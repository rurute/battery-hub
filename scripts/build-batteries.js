// Builds src/main/system-batteries.exe from src/main/batteries/SystemBatteries.cs with the C# compiler
// that ships with Windows, so there is nothing to install. Runs before `npm start` and `npm run dist`.
// Not on Windows, or without the compiler, it skips: the app then uses the PowerShell script.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'src', 'main', 'batteries', 'SystemBatteries.cs');
const OUT = path.join(ROOT, 'src', 'main', 'system-batteries.exe');
const CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

if (process.platform !== 'win32' || !fs.existsSync(CSC)) {
  console.log('build-batteries: no Windows C# compiler here, skipping (the PowerShell script is used instead)');
  process.exit(0);
}

if (!(fs.existsSync(OUT) && fs.statSync(OUT).mtimeMs >= fs.statSync(SOURCE).mtimeMs)) {
  execFileSync(CSC, ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu', `/out:${OUT}`, SOURCE], { stdio: 'inherit' });
  console.log(`Wrote ${path.relative(ROOT, OUT)} (${Math.round(fs.statSync(OUT).size / 1024)} KB)`);
}

// The Bluetooth LE reader uses Windows' own Bluetooth API, described in the WinMetadata files every
// Windows 10 and 11 has. If it can't be built, the app just doesn't read those devices directly.
const BLE_SOURCE = path.join(ROOT, 'src', 'main', 'batteries', 'BleBatteries.cs');
const BLE_OUT = path.join(ROOT, 'src', 'main', 'ble-batteries.exe');
const WINMD = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WinMetadata');
if (!(fs.existsSync(BLE_OUT) && fs.statSync(BLE_OUT).mtimeMs >= fs.statSync(BLE_SOURCE).mtimeMs)) {
  try {
    execFileSync(CSC, ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu', `/out:${BLE_OUT}`,
      ...['Windows.Devices', 'Windows.Foundation', 'Windows.Storage'].map((m) => `/r:${path.join(WINMD, m + '.winmd')}`),
      `/r:${path.join(path.dirname(CSC), 'System.Runtime.dll')}`, BLE_SOURCE], { stdio: 'inherit' });
    console.log(`Wrote ${path.relative(ROOT, BLE_OUT)} (${Math.round(fs.statSync(BLE_OUT).size / 1024)} KB)`);
  } catch (e) {
    console.log('build-batteries: could not build the Bluetooth LE reader, skipping it');
  }
}
