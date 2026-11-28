<div align="center">
  <img src="assets/brand/watcher-tile.png" width="120" alt="Battery Hub" />
  <h1>Battery Hub</h1>
  <p><strong>Live battery monitoring for wireless mice, keyboards, headsets and controllers on Windows.</strong></p>

  <a href="https://github.com/battery-hub/battery-hub/releases/latest"><img src="https://img.shields.io/github/v/release/battery-hub/battery-hub?sort=semver" alt="Latest release" /></a>
  <a href="https://github.com/battery-hub/battery-hub/releases"><img src="https://img.shields.io/github/downloads/battery-hub/battery-hub/total" alt="Downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/battery-hub/battery-hub" alt="License" /></a>
  <img src="https://img.shields.io/badge/platform-Windows%2010%20%2F%2011-0078D6" alt="Platform: Windows 10/11" />

  <p><a href="https://buymeacoffee.com/batteryhub"><img src="https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=000000" height="34" alt="Buy me a coffee" /></a></p>
</div>

---

Battery Hub reads the battery level of your wireless HID devices and shows each one on a live dashboard, with a per-device indicator in the system tray. Built with Electron.

<p align="center">
  <img src="docs/screenshot.png" width="820" alt="Battery Hub dashboard showing five devices with charge rings, history sparklines and time-left estimates" />
  <br />
  <sub>The dashboard, shown with sample devices. Regenerate with <code>npx electron scripts/screenshot.js</code>.</sub>
</p>

## Features

- **Multi-device dashboard** — mice, keyboards, headsets and controllers, each with a colour-coded charge ring.
- **System-tray icons** — a live battery indicator per device beside the clock.
- **At-a-glance overview** — which device needs charging next, how soon, and how many are connected.
- **History & estimates** — click any device for a 24-hour or 7-day battery chart, its drain rate and when it was last charged.
- **Low-battery notifications** — Windows alerts when a device falls below a threshold, set once for all devices or per device.
- **Knows when a device is off** — a device switched off while its receiver stays plugged in shows as *Asleep or off* instead of an old reading.
- **Guided calibration** — a 30-second scan detects the battery byte for devices that aren't recognised automatically.
- **Light and dark themes** — a calm Windows 11 style window, a tray flyout and a reduce-motion option.
- **Auto-updates** — delivered through GitHub Releases.

## Installation

With the [Windows Package Manager](https://learn.microsoft.com/windows/package-manager/):

```powershell
winget install DORON177.BatteryHub
```

Or download the latest `Battery-Hub-Installer-x.y.z.exe` from the [releases page](https://github.com/battery-hub/battery-hub/releases/latest) and run it. Battery Hub installs per-user and requires no administrator rights.

Windows SmartScreen shows a **"Windows protected your PC"** prompt because the installer isn't code-signed — select **More info → Run anyway**. Code signing certificates are issued to identified publishers for a recurring fee; this project is unfunded, so builds are unsigned. See [Verifying a download](#verifying-a-download) if you'd like to confirm the file's integrity first.

### Verifying a download

Every release is built and published by [GitHub Actions](.github/workflows/release.yml) directly from a tagged commit — no binaries are uploaded by hand — and each one ships a `SHA256SUMS.txt`. To confirm your download matches, run:

```powershell
(Get-FileHash "Battery-Hub-Installer-2.0.9.exe" -Algorithm SHA256).Hash
```

and compare the result with the checksum in that release's `SHA256SUMS.txt`. Pasting the same hash into [VirusTotal](https://www.virustotal.com/gui/home/search) will show any scan results for the exact file.

## Usage

### Adding a device

Open **Add device**. Recognised devices are listed first with a *Supported* badge: click **Add**. For anything else, choose **Set up**:

1. Start the 30-second scan.
2. Power the device off and on while it scans — many wireless devices only report their battery on power-up.
3. Select the value that matches your current battery percentage.
4. If the device reports on a different scale, enter your real percentage and it's converted automatically from then on.

### Reading a card

Each card shows the current percentage and ring (green / yellow / red), a charging indicator, a history sparkline, an estimated time remaining, and the age of the last reading. Click a card for its full history. Every device also appears as a tray icon that fills and changes colour with the charge.

### Settings

Theme, card density, reduce animations, low-battery threshold, tray behaviour, launch at login, and refresh interval.

Devices can be renamed, given a custom icon, dragged to reorder, or **hidden** from the ⋯ menu. Hiding keeps the device and its calibration but stops polling and removes its tray icon; hidden devices are listed below the grid and can be restored at any time.

## Build from source

Requires [Node.js](https://nodejs.org).

```bash
npm install
npm start        # run in development
npm run dist     # build the Windows installer into dist/
npm run installer  # wrap it in the branded installer window
```

## Supported devices

Battery Hub reads these directly. Anything else can usually be added with **Set up**.

| Family | Devices |
| --- | --- |
| Bluetooth | Any paired device that reports its battery to Windows |
| Xbox | Wireless controllers |
| PlayStation | DualSense, DualSense Edge, DualShock 4 (USB and Bluetooth) |
| Sony | INZONE Buds (USB dongle), INZONE H5, INZONE H9 II |
| Nintendo | Switch Pro Controller and clones, Joy-Con (Bluetooth) |
| Flydigi | Vader 4 Pro, Vader 5 Pro, Apex 4, 5 and 6 |
| 8BitDo | Ultimate 2 Wireless and Bluetooth, Ultimate 3 (D-input mode) |
| Valve | Steam Controller (2015, on its receiver) and Steam Controller (2026) |
| Other controllers | NVIDIA SHIELD controller, Amazon Luna (Bluetooth), SInput pads such as the ProGCC |
| Logitech | Mice and keyboards using HID++ 2.0 (Bolt, Unifying, Lightspeed, including the newest receiver of the PRO X3 SUPERSTRIKE); G PRO, G PRO X 2, G325, G533, G535, G633, G733, G933, G935 headsets |
| Razer | 90 wireless mice and keyboards (including the Basilisk V4 Pro and HyperSpeed, Naga V3 Pro, Orochi V2 and BlackWidow V4 Low Profile TKL); BlackShark V3, V3 Pro, V3 X HyperSpeed, V2 HyperSpeed, V2 Pro (2020), Kraken V4, Kraken V4 Pro (cable) and Nari headsets |
| SteelSeries | Arctis 1, 7, 7+, 9, Nova 3P, Nova 5, Nova 7, Nova Pro Wireless, Nova Pro Omni, Nova Elite headsets, Arctis GameBuds; Aerox, Aerox 3 Wireless Gen 2, Prime, Rival 3 Wireless, Rival 650 Wireless and Rival Pro mice; Apex Pro TKL Wireless and Apex Pro Mini Wireless keyboards |
| HyperX | Cloud Alpha Wireless, Cloud Alpha 2 Wireless, Cloud Core Wireless, Cloud Flight (also for PlayStation), Cloud Flight S, Cloud II Wireless, Cloud II Core Wireless, Cloud III Wireless, Cloud III S Wireless, Cloud Stinger 2 Wireless headsets; Pulsefire Haste 2 Wireless, Haste 2 Core and Dart mice |
| Corsair | Void, Void Wireless v2 (also on its cable), HS80 MAX, HS80 RGB, Virtuoso, Virtuoso SE, XT and MAX headsets; SABRE v3 PRO; Slipstream receivers and the Dark Core RGB Pro, Ironclaw, Harpoon and Katar Pro dongles; M65, M75, Dark Core, Scimitar, Nightsabre, NIGHTSWORD v2, Sabre and other wireless mice on their cable; K65 PLUS (and its dongle), K70 CORE TKL, K100 AIR, K70 PRO MINI and MAKR 75 keyboards on their cable |
| Audeze | Maxwell, Maxwell 2 (including the Xbox and ANC dongles) |
| Skullcandy | PLYR, Crusher PLYR 720 |
| ELECOM | BlueLED Mouse over Bluetooth (056e:00e5, listed as "Broadcom Bluetooth Wireless Mouse") |
| Astro | A50 Gen 4, A50 Gen 5 |
| Jabra | Link 380 and Link 390 dongles, Evolve3 75, Evolve2 65 Flex |
| Poly (Plantronics) | Voyager headsets on the BT600 dongle |
| JBL | Quantum 810, Quantum 910 |
| Lenovo | Wireless VoIP Headset |
| FIFINE | HT6 |
| MCHOSE | V9 Turbo+, V9 PRO, V9 Pro 2, X9 headsets; A7 V2 Ultra, A7 V2 Pro, A5 Ultra, K7 Ultra, A7 Ultra, G3 A mice; G75 V2, G87 V2, K87S, K99 V3, K87, G98 Pro keyboards; A5 V3, A7 V3, A7X Ultra, K7 V2, R7 Ultra, V7 Pro, G3 V3, G3 Ultra and A5 V2 Ultra mice |
| VXE, ATK, MADLIONS | Dragonfly R1 Pro, NordicMouse and other mice on Compx receivers; ATK NearLink and BitMouse receivers, X1 NearLink; ATK 8K Nano and 1K/8K dongles; Pulsar 8K Dongle Gen.2 and CrazyLight mice, Pulsar Xlite V4, X3 and Feinmann (Fusion2), G-Wolves 8K receiver, Endgame Gear XM2we, ATK A9 PRO MAX and Duckbill ELITE, ATK NearLink 8K dongle, A9 Ultimate and F1 NearLink, iRocks M31R, Zebronics receiver |
| Glorious, LAMZU | Model O, O-, D, D- Wireless; Maya X, Atlantis OG and Mini, TACHI, INCA, PARO, THORN and other LAMZU mice; WLmouse mice (Beast X Max and others), Attack Shark R5 Ultra |
| Beken/Xenta 2.4G receiver | Attack Shark and other mice on 1d57:fa60 and fa55 |
| ASUS | ROG Strix Go 2.4 and TUF Gaming H3 Wireless headsets; ROG Claymore II, Azoth, Azoth X, Azoth Extreme, Falchion, Falchion RX LP, Strix Scope II 96 and Scope RX TKL Wireless keyboards; ROG Gladius III, Gladius III AimPoint (and EVA-02), Chakram X, Harpe Ace, Harpe II Ace, Keris AimPoint, Keris II, Spatha X, TUF Gaming M4 and Mini, ProArt MD301, MD200 and mice on the ROG OMNI receiver |
| MSI | VERSA 300 Elite Wireless, VERSA PRO Wireless |
| Bloody | R73 Pro and other Bloody wireless mice |
| Waizowl | OGM 8K |
| NZXT | Lift Elite Wireless |
| Cooler Master | MM712, MM731 |
| VAXEE | Wireless mice on their dongles |
| Ninjutso | Sora V3 |
| CROCIRIS | X7 |
| DARKRIM | SHADOW |
| Delux | M800 Pro |
| Redragon | M690 PRO (receiver); M901P-KS, M913 and other mice on Compx receivers |
| Darmoshark | M3, N5 and other Darmoshark mice and receivers |
| AULA, EWEADN | Keyboards on their SONiX 2.4G receiver; AULA F108 Pro dongle |
| Lofree | Flow Lite84 |
| GANSS | GS3075T (2.4G) |
| Alienware | Pro Wireless Gaming Keyboard |
| Red Square | Alumix TKL |
| CHERRY | MX 3.0S Wireless |
| 1EA7 2.4G receiver | Generic 2.4G mice on 1ea7:0064 and 0066 |
| Rapoo | VT7 and VT9 Pro / VT3 MAX mice (24ae:1413, 1417), VT9 Pro V2, VT7 on its cable |
| YICHIP 2.4G receiver | AJAZZ AJ159 APEX, AJ179 PRO, Lingbao M5 Pro, Attack Shark R2 and other mice and keyboards on YICHIP and Rongyuan receivers (also MonsGeek, Epomaker, MSI, Trust and VGN ones) |
| BY Tech | PIAO 8K, EWEADN S9 and other BY Tech mice |
| Akko, Telink, Wobkey | Mice on the Akko 8K receiver, and Telink mice and Wobkey keyboards on the same platform |
| VGN | Dragonfly 3 MasterGT, Dragonfly Y2 / F1 V2, F1 V2 Extreme, Falcon3 Extreme and other VGN mice; N75 V2, V108, V87 V2, V98pro V3 keyboard dongles |
| Keychron, SKN | Mice on the Ultra-Link 8K receiver |
| YJX-chip 2.4G receiver | AJAZZ, XCTECH and other mice on YJX receivers (the same platform as MCHOSE G-series mice) |
| Compx 2.4G receiver | AULA F87 Pro and F99 Pro, Lingbao K98, MCHOSE G75 keyboards |

Tested on real hardware: VXE NordicMouse, MCHOSE V9 Turbo+, DualSense on USB and Bluetooth, Logitech MX Master 4 over Bluetooth, INZONE Buds on their USB dongle, and the ELECOM BlueLED Mouse over Bluetooth. The rest are built from the protocols documented by the projects below and checked against those byte layouts, so please [report a device](https://github.com/battery-hub/battery-hub/issues/new?template=device-support.yml) if one misbehaves.

Protocol work comes from [HeadsetControl](https://github.com/Sapd/HeadsetControl), [OpenRazer](https://github.com/openrazer/openrazer), [rivalcfg](https://github.com/flozz/rivalcfg), [openinzone](https://github.com/penguinwokrs/openinzone) and the Linux kernel's HID drivers.

A device connected more than one way, such as a controller on its cable and over Bluetooth, shows as one card when both connections report the same Bluetooth address.

Reading a PlayStation controller over Bluetooth switches it to its full report mode until it's turned off, as Steam and DS4Windows do. A few older games may not see the controller in that mode until it's turned off and on.

## Project structure

| Path | Purpose |
| --- | --- |
| `src/main` | Electron main process — HID polling, tray, notifications, updates. |
| `src/main/hid/drivers` | Per-device battery drivers; `table.js` lists simple request/response devices. |
| `src/renderer` | Application UI. |
| `scripts` | Icon generation and build tooling. |

Native `node-hid` runs in an isolated utility process, so a driver fault can't bring the app down.

## Troubleshooting

- **"Can't read this device's battery."** Some devices block battery requests at the driver level and can't be read.
- **Nothing captured during calibration.** Rerun the scan and power the device off and on while it runs.
- **MCHOSE V9 Turbo+ shows "needs Python + hid module".** This headset is read through Python. Install [Python](https://www.python.org/downloads/), then run `pip install hidapi`.
- **A device won't work.** After two failed scans, or three failed reads in a row (open the device's card), a Send device report button appears. It fills in a device request on GitHub for you to check and submit.
- **Something else isn't working.** Open Settings > Help and press Run check. It tests your install, this PC and your devices, tells you where the problem is, and can open a filled-in support request.
- **Crash logs** are written to `%APPDATA%\battery-hub\battery-hub.log`.

## Privacy

Battery Hub runs entirely on your PC and collects nothing. It goes online for two things only, both
to GitHub: checking for and downloading updates, and the version check in Settings > Help. Device
reports and support requests open a filled-in GitHub form in your browser; nothing is sent until you
submit it yourself, and you can read every field first. Battery history and settings stay in
`%APPDATA%\battery-hub`.

## Contributing

Device support requests and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
Release history is in [CHANGELOG.md](CHANGELOG.md), and security reports are covered by
[SECURITY.md](SECURITY.md).

## Support the project

Battery Hub is free and stays free. If it saved you from a dead mouse mid-game, you can
[buy it a coffee](https://buymeacoffee.com/batteryhub). It helps keep it free and adds
support for more devices.

## License

[MIT](LICENSE) © 2026 Battery Hub contributors
