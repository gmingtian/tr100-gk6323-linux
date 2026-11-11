// SPDX-License-Identifier: GPL-2.0
/* GK6323 temperature sampler, based on the matching Goke SDK formula. */
#include <linux/delay.h>
#include <linux/hwmon.h>
#include <linux/io.h>
#include <linux/iopoll.h>
#include <linux/module.h>
#include <linux/mutex.h>
#include <linux/platform_device.h>
#include <linux/slab.h>
#include "gk6323-temp.h"

struct tr100_sensor {
    void __iomem *pmc;
    u32 trim;
    u32 previous_control;
};

static DEFINE_MUTEX(tr100_sensor_access);
static struct tr100_sensor *tr100_active_sensor;

static int tr100_read_trim(struct device *dev, u32 *trim)
{
    void __iomem *otp;
    u32 status, channel, control, mode;
    int ret;

    otp = devm_ioremap(dev, 0xf8ab0000, 0x24);
    if (!otp)
        return -ENOMEM;
    ret = readl_poll_timeout(otp + 0x0c, status, status & 1, 1, 10000);
    if (ret)
        return ret;
    if (status & BIT(4))
        return -EACCES;
    channel = readl(otp);
    control = readl(otp + 4);
    mode = readl(otp + 0x20);
    writel((channel & ~3u) | 2u, otp);
    /* Read only: explicitly clear both write-select and write-enable. */
    writel((control & ~(BIT(0) | BIT(2) | (3u << 4))) | BIT(1) | (2u << 4), otp + 4);
    writel(mode | 0x34f, otp + 0x20);
    writel(0x258, otp + 0x18);
    udelay(1);
    ret = readl_poll_timeout(otp + 0x0c, status, status & 1, 1, 10000);
    if (!ret)
        *trim = readl(otp + 0x10);
    writel(control & ~(BIT(0) | BIT(1) | BIT(2)), otp + 4);
    writel(mode, otp + 0x20);
    writel(channel, otp);
    return ret;
}

static int tr100_measure(struct tr100_sensor *sensor, long *value)
{
    unsigned int samples[4];
    int i, raw;
    writel(0x72, sensor->pmc); /* Match the SDK's sampling trigger. */
    readl(sensor->pmc);
    for (i = 0; i < 4; i++) samples[i] = readl(sensor->pmc + 8 + i * 4);
    raw = gk6323_samples_raw(samples);
    if (raw < 0)
        return -EAGAIN;
    *value = gk6323_temp_mc(raw, sensor->trim);
    if (*value < -40000 || *value > 150000)
        return -ERANGE;
    return 0;
}

int tr100_get_temperature(long *value)
{
    int ret;
    if (!value) return -EINVAL;
    mutex_lock(&tr100_sensor_access);
    ret = tr100_active_sensor ? tr100_measure(tr100_active_sensor, value) : -ENODEV;
    mutex_unlock(&tr100_sensor_access);
    return ret;
}
EXPORT_SYMBOL_GPL(tr100_get_temperature);

static int tr100_read(struct device *dev, enum hwmon_sensor_types type,
                     u32 attr, int channel, long *value)
{
    struct tr100_sensor *sensor = dev_get_drvdata(dev);
    if (type != hwmon_temp || channel) return -EOPNOTSUPP;
    if (attr == hwmon_temp_offset) {
        *value = gk6323_temp_mc(519, sensor->trim) - gk6323_temp_mc(519, 0);
        return 0;
    }
    if (attr != hwmon_temp_input) return -EOPNOTSUPP;
    {
        int ret;
        mutex_lock(&tr100_sensor_access);
        ret = tr100_active_sensor == sensor ? tr100_measure(sensor, value) : -ENODEV;
        mutex_unlock(&tr100_sensor_access);
        return ret;
    }
}

static umode_t tr100_visible(const void *data, enum hwmon_sensor_types type,
                            u32 attr, int channel)
{
    if (type == hwmon_temp && !channel &&
        (attr == hwmon_temp_input || attr == hwmon_temp_offset))
        return 0444;
    return 0;
}

static const struct hwmon_ops tr100_ops = {
    .is_visible = tr100_visible,
    .read = tr100_read,
};
static const struct hwmon_channel_info *tr100_info[] = {
    HWMON_CHANNEL_INFO(temp, HWMON_T_INPUT | HWMON_T_OFFSET),
    NULL
};
static const struct hwmon_chip_info tr100_chip = {
    .ops = &tr100_ops,
    .info = tr100_info,
};

static int tr100_probe(struct platform_device *pdev)
{
    struct tr100_sensor *sensor;
    struct device *hwmon;
    int ret;

    sensor = devm_kzalloc(&pdev->dev, sizeof(*sensor), GFP_KERNEL);
    if (!sensor)
        return -ENOMEM;
    sensor->pmc = devm_ioremap_resource(&pdev->dev,
                                      platform_get_resource(pdev, IORESOURCE_MEM, 0));
    if (IS_ERR(sensor->pmc))
        return PTR_ERR(sensor->pmc);
    ret = tr100_read_trim(&pdev->dev, &sensor->trim);
    if (ret)
        return dev_err_probe(&pdev->dev, ret, "cannot read temperature factory trim\n");
    sensor->previous_control = readl(sensor->pmc);
    writel(0x72, sensor->pmc);
    msleep(100); /* SDK waits for all eight temperature samples to settle. */
    platform_set_drvdata(pdev, sensor);
    hwmon = devm_hwmon_device_register_with_info(&pdev->dev, "gk6323", sensor,
                                                &tr100_chip, NULL);
    if (IS_ERR(hwmon)) {
        writel(sensor->previous_control, sensor->pmc);
        return PTR_ERR(hwmon);
    }
    mutex_lock(&tr100_sensor_access);
    tr100_active_sensor = sensor;
    mutex_unlock(&tr100_sensor_access);
    dev_info(&pdev->dev, "temperature sampler enabled; factory trim applied\n");
    return 0;
}

static int tr100_remove(struct platform_device *pdev)
{
    struct tr100_sensor *sensor = platform_get_drvdata(pdev);

    mutex_lock(&tr100_sensor_access);
    tr100_active_sensor = NULL;
    writel(sensor->previous_control, sensor->pmc);
    mutex_unlock(&tr100_sensor_access);
    return 0;
}
static struct platform_driver tr100_driver = {
    .probe = tr100_probe,
    .remove = tr100_remove,
    .driver = { .name = "tr100-tsensor" },
};
static struct resource tr100_resources[] = {
    { .start = 0xf8a23028, .end = 0xf8a2303f, .flags = IORESOURCE_MEM },
};
static struct platform_device *tr100_device;

static int __init tr100_init(void)
{
    int ret = platform_driver_register(&tr100_driver);

    if (ret)
        return ret;
    tr100_device = platform_device_register_simple("tr100-tsensor", -1,
                    tr100_resources, ARRAY_SIZE(tr100_resources));
    if (IS_ERR(tr100_device)) {
        platform_driver_unregister(&tr100_driver);
        return PTR_ERR(tr100_device);
    }
    return 0;
}
static void __exit tr100_exit(void)
{
    platform_device_unregister(tr100_device);
    platform_driver_unregister(&tr100_driver);
}
module_init(tr100_init);
module_exit(tr100_exit);
MODULE_LICENSE("GPL");
MODULE_DESCRIPTION("TR100 GK6323 calibrated temperature sampler");
