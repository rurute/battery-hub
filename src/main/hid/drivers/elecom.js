// ELECOM BlueLED Mouse over Bluetooth (056e:00e5). It names itself "Broadcom Bluetooth Wireless
// Mouse" and doesn't give Windows its battery, but its consumer-control collection carries the
// standard HID Battery Strength usage (Generic Device Controls page 0x06, usage 0x20):
//
//   03 <percent> <Bluetooth address, 6 bytes>       input report 3, 8 bytes
//
// The mouse never sends that report by itself, so a calibration scan sees nothing; it answers
// HidD_GetInputReport, which node-hid doesn't expose, so a small PowerShell script asks for it.
// Checked on real hardware against the level shown by a direct read.
const { execFile } = require('child_process');
const path = require('path');

const VENDOR = 0x056e;
const PRODUCTS = new Set([0x00e5]);
const REPORT_ID = 0x03;
const REPORT_SIZE = 8;
const BATTERY_COLLECTION = { usagePage: 0x0c, usage: 0x01 };
const SCRIPT = path.join(__dirname, '..', 'get-input-report.ps1');
const SCRIPT_TIMEOUT_MS = 6000;

function batteryChannel(logicalDevice) {
  return logicalDevice.channels.find((c) => c.usagePage === BATTERY_COLLECTION.usagePage && c.usage === BATTERY_COLLECTION.usage);
}

function matches(logicalDevice) {
  return logicalDevice.vendorId === VENDOR && PRODUCTS.has(logicalDevice.productId) && Boolean(batteryChannel(logicalDevice));
}

// 0 is what comes back before the mouse has answered, not an empty battery.
function parseReport(report) {
  if (report.length < 2 || report[0] !== REPORT_ID || report[1] === 0 || report[1] > 100) return null;
  return { capacity: report[1], charging: null };
}

function getInputReport(channelPath) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, channelPath, String(REPORT_ID), String(REPORT_SIZE)],
      { windowsHide: true, timeout: SCRIPT_TIMEOUT_MS }, (err, stdout) => {
        if (err) { reject(new Error('mouse is not answering')); return; }
        resolve(Array.from(Buffer.from(stdout.trim(), 'hex')));
      });
  });
}

async function readBattery(logicalDevice) {
  const channel = batteryChannel(logicalDevice);
  if (!channel) throw new Error('battery collection not present on this device');
  const reading = parseReport(await getInputReport(channel.path));
  if (!reading) throw new Error('mouse is not answering');
  return reading;
}

module.exports = { id: 'elecom', matches, readBattery, parseReport, batteryChannel };
