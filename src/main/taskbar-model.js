// fork: decides what the taskbar battery levels show (fork Issue #16). Pure functions only:
// taskbar.js sends lineFor(itemsFor(...)) to taskbar-battery.exe, which just draws it.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { urgencyCompare } = require('../renderer/estimate');

// Fixed, not tied to the notification thresholds (spec: 20% or below, also while charging).
const LOW_AT = 20;
// Same as READS_BEFORE_REPORT in src/renderer/app.js (a window script, so the value is copied):
// from this many failed reads in a row, the card says "Can't read this device".
const READS_BEFORE_REPORT = 3;

// icons.js is a window script with no module.exports. Its top-level consts don't land on the
// context object, so pick them up from inside the same script.
const ICONS = (() => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'icons.js'), 'utf8');
  const context = {};
  vm.runInNewContext(`${src}\n;this.__x = { ICON_PATHS, deviceIconName };`, context, { filename: 'icons.js' });
  return context.__x;
})();

const ICON_PATHS = ICONS.ICON_PATHS;

function iconName(device) {
  return ICONS.deviceIconName(device);
}

// Connected, not hidden, read since this launch (sinceMs), and not in the card's
// "Can't read this device" state. Ordered like the cards.
function visibleDevices(devices, settings, sinceMs) {
  const list = Object.values(devices || {}).filter((d) => d
    && d.online !== false
    && !d.hidden
    && d.lastReading
    && typeof d.lastReading.capacity === 'number'
    && Number.isFinite(d.lastReading.capacity)
    && typeof d.lastReadingAt === 'number'
    && d.lastReadingAt >= sinceMs
    && !((d.failedReads || 0) >= READS_BEFORE_REPORT));
  if ((settings || {}).sortMode === 'manual') {
    list.sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9));
  } else {
    list.sort(urgencyCompare);
  }
  return list;
}

function itemsFor(devices, settings, sinceMs) {
  return visibleDevices(devices, settings, sinceMs).map((d) => {
    const level = Math.min(100, Math.max(0, Math.round(d.lastReading.capacity)));
    return { icon: iconName(d), level, charging: !!d.lastReading.charging, low: level <= LOW_AT };
  });
}

function lineFor(items) {
  return JSON.stringify({ devices: items });
}

module.exports = { LOW_AT, READS_BEFORE_REPORT, ICON_PATHS, iconName, visibleDevices, itemsFor, lineFor };
