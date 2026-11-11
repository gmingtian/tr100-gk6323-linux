#ifndef GK6323_TEMP_H
#define GK6323_TEMP_H
static inline int gk6323_temp_mc(unsigned int raw, unsigned int otp)
{
    int trim = (otp >> 18) & 15;

    if (otp & (1u << 22))
        trim = -trim;
    return ((int)raw - 127) * 165000 / 784 - 40000 + trim * 1000;
}
static inline int gk6323_samples_raw(const unsigned int samples[4])
{
 unsigned int i, sum = 0;
 for (i = 0; i < 4; i++) {
  unsigned int a = samples[i] & 0x3ff, b = (samples[i] >> 16) & 0x3ff;
  if (!a || a == 0x3ff || !b || b == 0x3ff) return -1;
  sum += a + b;
 }
 return sum / 8;
}
#endif
