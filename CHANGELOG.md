# Changelog

All notable changes to this project are documented here. Versions follow
[semantic versioning](https://semver.org/); each entry corresponds to a
[GitHub release](https://github.com/battery-hub/battery-hub/releases).

## [Unreleased]

## [2.0.7] - 2026-11-25

A hotfix for 2.0.6.

### Added

- A supported device can also be set up with a scan, from its card's menu. Its Add device row only offers Add,
  so when its reading failed there was no way to send the scan that fixes it (issue #92).
- An "old reading" alert, off by default: when a device hasn't had a real reading for a number of days, Battery Hub
  says so, for devices that can only be read now and then (pull request #219 by @maxeinstein-dev).

### Fixed

- Russian: about 30 texts that were still in English (the check, device reports, some settings), and
  correct plural forms (pull request #215 by @Dfavorit55).
- Compx receivers that still failed in 2.0.6 (Redragon M901P-KS, issue #92): the other vendor channels are
  tried too, a feature-report answer is waited for a little longer, and the error says what each channel answered.
- HyperX Cloud Stinger 2 Wireless wasn't recognised (issue #206): it was looked for on the Cloud II's interface,
  and is now its own entry, under its own name, with its 20-byte requests.
- Translations: a new text without a Russian translation shows in English, as in the other languages, instead of
  failing the checks (issue #217, pull request #220 by @maxeinstein-dev).

## [2.0.6] - 2026-11-25

### Added

- Mice on the Keychron / SKN Ultra-Link 8K receiver (issue #164), using the request that
  keychron-battery-dkms and HaloBattery checked on a Keychron M6 8K.
- HyperX Cloud Flight S (issue #180): the headset is asked for its level the way NGENUITY does, so it no longer shows 0%.
- The Logitech PRO X3 SUPERSTRIKE and other mice on the newest Lightspeed receiver, 046d:c54f (issue #113): its HID++ channel has a new name, so it was skipped.
- Razer BlackShark V3 and V3 Pro, on the cable and the dongle (issue #21), from openrazer, secbird
  and Joule, which checked it on both headsets.
- The ATK 8K Nano Dongle and ATK 1K/8K dongles on the Holtek platform (issue #168), read the way
  ATK's own web driver reads them.
- MCHOSE G3 A mouse over 2.4 GHz (pull request #198 by @whyolo1, tested on the mouse).
- SONY INZONE Buds on their USB dongle, with Left, Right and Case levels in the detail view
  (pull request #199 by @rurute, tested on the buds).
- Russian (pull request #153 by @Dfavorit55). It follows a Russian Windows, or can be picked in Settings.
- Brazilian Portuguese (pull request #183 by @maxeinstein-dev), also used on a Portuguese Windows.
- A Cancel button while a device scan runs (pull request #187 by @maxeinstein-dev).
- A switched-off device in the tray popup shows its last reading and how long ago it was
  (pull request #185 by @maxeinstein-dev).

### Fixed

- The check no longer counts the app being closed from outside (Task Manager, Windows shutting down)
  as an error (pull request #184 by @maxeinstein-dev).
- Redragon M901P-KS and AJAZZ AJ199 mice on Compx receivers 25a7:fa07 and 25a7:fa7c: the receiver
  answers only through feature reports, so the read failed with "could not read data from device" (#92, #196).
- Attack Shark X11 and other Beken receivers that send `03 55 40` instead of `03 e5 40`
  (issue #175, pull request #176 by @maxeinstein-dev), and the X11 receiver 1d57:fa55 (issue #88).
- Classic Bluetooth headsets whose battery Windows keeps on the Hands-Free service now show up
  (pull request #177 by @maxeinstein-dev).
- The Rescan button in Add device now spins while it looks for devices.
- "Open at startup" when the app runs from source (pull request #178 by @maxeinstein-dev).

## [2.0.5] - 2026-11-24

### Added

- Corsair Void Wireless v2, HS80 MAX, Virtuoso MAX, Virtuoso SE and Virtuoso XT headsets
  (issues #97, #99, #100), using the protocol HeadsetControl documents.
- MCHOSE V9 PRO (issue #43), Astro A50 Gen 4 (issue #35) and Astro A50 Gen 5 (issue #53) headsets,
  also from HeadsetControl.
- MCHOSE mice: A7 V2 Ultra, A5 Ultra, K7 Ultra and A7 Ultra (issues #54, #68, #77, #80, #130, #142,
  #161), and MCHOSE G75 V2, G87 V2, K87S and K99 V3 keyboards on their 2.4G receiver (issue #50).
  Both protocols are read from MCHOSE's own web driver.
- Glorious Model O, O-, D and D- Wireless (issue #45), LAMZU Maya X and other LAMZU mice (issue #146),
  and the MCHOSE A5 2.4G (issue #115), which share one receiver chip. The protocol comes from mxw
  and LAMZU's own web driver.
- The Beken/Xenta 2.4G receiver 1d57:fa60 used by Attack Shark and other mice (issues #20, #73), from
  Attack Shark Battery KDE.
- ATK mice on BitMouse receivers, NearLink and 2.4G (issues #60, #79, #93, #122), and the ATK X1
  NearLink (issue #129), read from ATK's own web driver.
- HyperX Cloud III Wireless, Cloud III S Wireless, Cloud II Core Wireless and Cloud Stinger 2 Wireless
  (issues #33, #117, #145), from auto94's HyperX-Cloud-2-Battery-Monitor.
- Mice on YJX-chip receivers (issues #85, #112, #157), read the way MCHOSE's web driver reads its
  G-series mice on the same platform.
- Corsair Slipstream receiver (issue #46), for the mouse or keyboard paired with it.
- Mice on the same Compx receiver chip as VXE: ATK, MADLIONS and other Compx receivers (issues #6,
  #61, #82, #92, #98, #111, #114, #121, #126, #135, #136). Linux reads one of them (373b:1085) the
  same way.
- "It works! Let the developer know": a device you set up with the scan that reads fine asks
  whether the level is right. A yes opens a filled-in GitHub form, which puts the device on the
  Works with list and helps build it in for everyone.

### Fixed

- Logitech G535 (issue #143): "Cannot write to hid device". It is now asked on its HID++ collection
  first, which Windows lets the app write to.

### Changed

- The scan now also listens on standard collections that carry no movement or keys. Some receivers
  broadcast their battery there, and the scan used to miss it.
- Device reports now include the bytes the scan caught, which is what a battery gets decoded from.
  Before, most only said how many messages came in. A keyboard's typing stays out, and anything
  that looks like an address or serial is masked.

## [2.0.4] - 2026-11-22

### Added

- Razer Viper V4 Pro (issue #56).
- Send device report now checks first: it asks you to update if you are on an old version, sends
  you to the existing report if someone already reported the same device, and does not send the
  same device twice from one PC. It also asks for the real battery level, and gives tips when the
  scan caught nothing.

### Fixed
- HyperX Cloud Alpha Wireless showed 0% most of the time, with the odd jump to its real level. Its
  dongle answers 0 when the headset is off (and while it charges); that now shows as off instead
  of a dead battery.
- The device scan could end with "capture timed out" on devices that are slow to refuse requests,
  and with "enumerate timed out" on PCs where listing USB devices takes a while. The scan now
  stops its checks on time, and listing devices gets more time.

## [2.0.3] - 2026-11-19

### Added
- When an update has downloaded, the Devices page shows it at the top with a Restart and install
  button, so it isn't only in Settings.

### Fixed
- Since 2.0.2, Settings > Help > device report said "This install is missing its file list" and
  blamed the PC. The file list was left out of 2.0.2 by mistake; it is back.
- If the device scan in Add device > Set up stops partway with "hid worker exited", it now shows
  what it found before stopping instead of nothing. Starting a second scan right after the first
  also no longer catches the first one still shutting down.
- A battery hovering around the alert level (20%, 21%, 20%…) no longer sends a Low battery alert
  each time it dips. It alerts again once it has charged or climbed 5 points above the level.
- The tray tooltip could show an old percentage until the level crossed the next 5% step.
- With tray icons turned off, Start minimized started the app with no window and nothing to open
  it from. It now opens the window.
- A routine update check after an update had downloaded could hide its Restart and install button
  when the PC was offline.
- Switching the tray style in Settings brought tray icons back even when they were turned off.

### Changed
- The release file that auto-update and winget use is now called Battery-Hub-Update-x.y.z.exe
  instead of Battery-Hub-Setup-x.y.z.exe, so it's clear that Battery-Hub-Installer-x.y.z.exe is
  the one to download.
- The project moved to github.com/battery-hub/battery-hub. Updates and device reports now use the
  new address directly (the old one still forwards).

## [2.0.2] - 2026-11-15

### Added
- Battery Hub in Spanish, Chinese and Hebrew (right to left), as well as English. It follows the
  Windows display language, or choose one in Settings > Appearance > Language. The tray and
  notifications follow it too.
- Keyboards on Compx's shared 2.4G receiver (3554:fa09): AULA F87 Pro and F99 Pro, Lingbao K98
  and MCHOSE G75. A card added before this release starts reading by itself. Built from two projects
  that read these keyboards on real hardware; not tested here.

### Fixed
- While a device was charging and the window was open, even behind other windows, Battery Hub
  used about half of one CPU core redrawing the pulsing ring. The ring now pulses three times and
  then stays a steady green, and CPU use drops to almost nothing.
- Battery Hub only looked for updates when its window opened, so a copy that starts hidden and
  lives in the tray could stay on an old version. It now checks a minute after starting and every
  six hours.
- With Close to tray turned off, closing the window left Battery Hub running with no window.
  Closing now quits.
- Pressing Refresh while a check was already running did nothing. It now waits and then refreshes.
- The log file is kept under 1 MB instead of growing for ever.
- A controller showed a drain rate like "238% a day". Devices that would lose more than a full
  charge in a day now show it per hour ("9.9% an hour"), and a level that wobbles between two steps,
  as a DualSense does, no longer makes the drain look faster than it is.

### Changed
- The installer is 107 MB instead of 122 MB, and the installed app about 75 MB smaller: unused
  languages, a 3D graphics library the app never uses, and copies of the USB library for other
  systems are left out.
- Removed the setting for reading PlayStation controllers over Bluetooth: they are always read now.
- Battery Hub uses about 40% less memory while it sits in the tray (about 290 MB instead of
  500 MB): the window is let go 30 seconds after you close it, and the tray popup a minute after it
  closes. Opening either again still takes about a quarter of a second.
- The helper that reads Bluetooth and Xbox controller batteries from Windows is now a small program
  of its own instead of PowerShell: about 17 MB instead of 125 MB while a Bluetooth device is added.

## [2.0.1] - 2026-11-10

### Fixed
- A wireless device switched off while its receiver stayed plugged in, such as a Logitech G502 X,
  kept showing its last level as if it were still on. It now shows Asleep or off (Turned off for
  headsets), keeps the last level dimmed, and comes back by itself. This works the same for
  VXE and ATK mice (Battery Hub now asks their receiver whether it has the mouse, as Linux does),
  Logitech, Razer, SteelSeries, HyperX, Corsair, MCHOSE and Audeze devices and PlayStation
  controllers. Mice and keyboards nap a few seconds after the last touch, and their receiver then
  says the same as when they are off, so they keep their normal look until they haven't answered
  for 2 minutes. A napping one is checked every 15 seconds, so any use in between is seen.
- A switched-off SteelSeries Aerox or Prime mouse showed 0%, and a DualShock 4 adapter with no
  controller on it showed 5%. Both now read as off.
- A Razer device, or one set up with a scan, kept its last level for minutes after its receiver
  was unplugged, and did not read again after it was plugged back in until Battery Hub restarted.
- Device reports showed a channel with no usage as NaN.
- A Compx receiver that refuses requests on its usual channel is now tried on its other vendor
  channels.
- With Logitech G HUB running, its traffic could be mistaken for a Logitech mouse's or headset's
  answer.

## [2.0.0] - 2026-11-02

A fresh start for Battery Hub. Earlier copies update to it by themselves.

### Added
- Each device can have its own low battery alert level, set in its panel. Devices without one
  keep using the level in Settings.
- While the installer runs, the third light on the character blinks.

### Changed
- Updated Electron from 33 to 45, along with the build tools and updater. The installer is about
  40 MB larger because of this.

## [1.3.2] - 2026-11-02

### Added
- Far wider device support, with no setup needed: any Bluetooth device that reports its
  battery to Windows, Xbox wireless controllers, PlayStation controllers, Logitech HID++ mice
  and keyboards, 81 Razer devices, and headsets and mice from SteelSeries, HyperX, Corsair,
  Logitech, Audeze and MCHOSE.
- Supported devices now appear first in Add device.
- One card per device: a device reachable several ways, such as a controller on its cable and
  over Bluetooth, is matched by its Bluetooth address and reads the best working connection.
  Existing duplicate cards merge by themselves and keep their name and history.
- Setting for reading PlayStation controllers over Bluetooth.
- If a device fails two scans, or three reads in a row, you can send a report on it. The report
  includes the same check as Settings > Help, and if the problem is on your PC you see the fix
  first.
- Settings > Help has a check that tests your install file by file, your version, this PC and
  your devices, says where a problem most likely is, and can open a filled-in support request.

### Fixed
- Running a scan again could save a setup from the older scan.

### Security
- The app window can no longer go to a website or open new windows.
- Updated two libraries with known security issues.

## [1.3.1] - 2026-11-01

### Changed
- All device icons now use one line style, including the icon picker. Icons you already chose
  carry over.
- Clearer, shorter wording in device setup, the tray and update messages.

## [1.3.0] - 2026-11-01

### Added
- New logo and a redesigned window with square device cards and a large level ring.
- New installer window with the character and a progress bar: no setup pages, and the app
  opens when it finishes.
- Charging notification when a device starts charging, on by default.
- Devices can sort most urgent first (the default) or stay in your own order.
- Tray flyout: click the tray icon to see every battery. The single tray icon now has a
  face that follows the battery that most needs attention.
- Device detail panel: click a card for a 24-hour or 7-day battery chart, drain rate, time
  left, last charge and voltage.

### Removed
- Accent colour setting. The app now always uses its teal.

### Fixed
- Time-left estimates were far too short. Flat stretches of history were left out of the
  drain-rate calculation, so each 1% drop was divided by only the last few minutes before
  it. A device that lost 15% in 17 hours showed about 1 hour left instead of about 51.
- Card hover lift never applied, and offline cards were never dimmed: the entry animation
  kept overriding both after it finished.
- Removing or hiding a device during a battery read could bring it back as an empty entry
  or restore its tray icon.
- Restarting monitoring could leave a headset reader process running untracked, after
  which another one was started alongside it.
- Time-left estimates no longer appear for a reading more than a week old.
- Calibrated devices could be read from the wrong collection when several share a usage
  page. New calibrations record the exact collection; existing ones behave as before.
- A calibrated device reporting an all-zero or too-short frame could show 0% or an invalid
  level. Those frames are now ignored.
- A device that rejected its first battery request left a timer writing to a closed handle
  twice a second, for every poll, until the worker restarted.
- Polls no longer run during a calibration scan, where they could swallow the frames being
  scanned for.
- A headset dongle reconnecting, or the app restarting, no longer leaves the card showing
  "not connected" until the battery next changes.
- A device moved to another USB port is found on the next poll instead of up to five
  minutes later.
- Python launchers that exit without running the reader, such as the Windows store alias,
  now fall through to the next launcher instead of failing silently.

### Changed
- Wider device cards with the ring beside the device details.
- HID devices now stay open between polls and reads run strictly one at a time. Closing a
  handle with a read in flight frees memory Windows may still be using, which fits the
  heap-corruption crashes in the background HID process.
- Calibrated devices that broadcast their battery level are picked up from the frames
  received since the last poll, instead of only during an 8-second listening window.
- Calibration scans poll only the reports a device actually supports.
- Tab switches are much smoother: frame gaps fall from about 60 ms to under 17 ms, with
  the worst stall dropping from 129 ms to about 25 ms. Blur filters were removed from
  surfaces that had nothing behind them to blur; they were being rendered in software and
  drew faint wavy lines on the cards.
- Removed the unused background layer and its colour tokens.

## [1.2.0] — 2026-07-25

First stable release, consolidating the 1.0.x and 1.1.x series.

### Added
- Hide devices from the ⋯ menu — polling and tray icons stop, calibration is kept, and
  hidden devices can be restored from a strip below the dashboard.
- `SHA256SUMS.txt` published with every release, and a "Verifying a download" section in
  the README, so unsigned installers can still be checked for integrity.
- Unit tests (`npm test`) covering the drain-rate estimate, history retention and HID
  driver parsing, run in CI on every push and pull request.
- Issue template for unsupported-device requests.
- Windows Package Manager listing: `winget install DORON177.BatteryHub`.
- Contributing, security and changelog documentation.

### Fixed
- Memory leak in the dashboard: a document-level click handler was registered for every
  device card on every refresh and never removed, so listeners accumulated for the life
  of the session and kept discarded cards in memory. Replaced with a single delegated
  handler.

### Changed
- Cursor tracking for the glass highlight now exits earlier, and does no work at all when
  **Reduce animations** is on.
- Removed dead code left over from an earlier gauge implementation.

## [1.1.5] — 2026-07-07

### Fixed
- Laggy scrolling in Settings.

## [1.1.4] — 2026-07-06

### Added
- Liquid-glass interface with a translucent Windows 11 acrylic backdrop, in light and dark.
- Animated view transitions, hover and press feedback, and a **Reduce animations** setting
  that disables all motion.

### Changed
- Opening the card menu now closes the icon picker.

## [1.1.3] — 2026-07-05

### Added
- Change a device's icon by clicking the icon itself.

### Changed
- Time-left estimates now use the whole stored history, so they survive restarts.
- Icon picker limited to computer peripherals.

## [1.1.2] — 2026-07-04

### Added
- Device icon picker.
- App logo as the tray icon in single-list mode.
- Automated release pipeline via GitHub Actions.

### Changed
- Smoother scrolling in Settings.

## [1.1.1] — 2026-07-04

### Fixed
- "Restart & install" button no longer stayed visible when already up to date.

## [1.1.0] — 2026-07-04

### Added
- In-app automatic updates via electron-updater.
- Tray layout setting: one icon per device, or a single icon listing them all.

## [1.0.4] — 2026-07-04

### Fixed
- Calibrated devices that reject HID writes but broadcast their battery frame are now
  read correctly instead of aborting.

## [1.0.3] — 2026-07-04

### Added
- Update checking against GitHub releases.

## [1.0.2] — 2026-07-04

Initial public release: live battery monitoring for wireless HID devices, per-device tray
icons, low-battery notifications, history sparklines and the guided calibration wizard.

[Unreleased]: https://github.com/battery-hub/battery-hub/compare/v2.0.7...HEAD
[2.0.7]: https://github.com/battery-hub/battery-hub/compare/v2.0.6...v2.0.7
[2.0.6]: https://github.com/battery-hub/battery-hub/compare/v2.0.5...v2.0.6
[2.0.5]: https://github.com/battery-hub/battery-hub/compare/v2.0.4...v2.0.5
[2.0.4]: https://github.com/battery-hub/battery-hub/compare/v2.0.3...v2.0.4
[2.0.3]: https://github.com/battery-hub/battery-hub/compare/v2.0.2...v2.0.3
[1.3.1]: https://github.com/battery-hub/battery-hub/releases/tag/v1.3.1
[1.3.0]: https://github.com/battery-hub/battery-hub/releases/tag/v1.3.0
[1.2.0]: https://github.com/battery-hub/battery-hub/releases/tag/v1.2.0
[1.1.5]: https://github.com/battery-hub/battery-hub/releases/tag/v1.1.5
[1.1.4]: https://github.com/battery-hub/battery-hub/releases/tag/v1.1.4
[1.1.3]: https://github.com/battery-hub/battery-hub/releases/tag/v1.1.3
[1.1.2]: https://github.com/battery-hub/battery-hub/releases/tag/v1.1.2
[1.1.1]: https://github.com/battery-hub/battery-hub/releases/tag/v1.1.1
[1.1.0]: https://github.com/battery-hub/battery-hub/releases/tag/v1.1.0
[1.0.4]: https://github.com/battery-hub/battery-hub/releases/tag/v1.0.4
[1.0.3]: https://github.com/battery-hub/battery-hub/releases/tag/v1.0.3
[1.0.2]: https://github.com/battery-hub/battery-hub/releases/tag/v1.0.2
