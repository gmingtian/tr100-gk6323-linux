# TR100 onboard SDIO Wi-Fi

The tested device reports SDIO `0000:0000`, chip ID `0x56630001` (Marlin3E)
and uses the factory UWE5621-family driver selection. Matching factory firmware
and RF calibration are required. Presence of similarly named ROM files alone
is not evidence of a particular fitted chip.

Native MMC power sequencing uses GPIO4 local pin 3, active low, with 100 ms reset
and 100 ms post-release delay. Only Wi-Fi SDIO at f9c40000 enables the preserving
PERI_CTRL card-detect override. The proven conservative bus mode is 50 MHz,
4-bit, 3.3 V high-speed; UHS is disabled. eMMC keeps its existing boot tuning.

The service loads BSP and Wi-Fi modules once per boot and brings the interface
up without adding an IP address, route, connection profile, AP, or Bluetooth
driver. The interface name depends on USB Wi-Fi enumeration; inspect `iw dev`.
Do not remove/reload a partly initialized vendor BSP; use a clean reboot.

Verification: successful firmware boot, command exchange, interface creation
and scanning on both 2.4 GHz and 5 GHz. Automatic driver startup also passed
after an unattended eMMC boot with the KVM kernel. Network association and
throughput testing are deferred at the owner's request.
