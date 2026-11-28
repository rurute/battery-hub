const Store = require('electron-store');

// Single source of truth for settings defaults — also merged in on read so a store written
// by an older version always gains any newly-added keys.
const DEFAULT_SETTINGS = {
  pollIntervalSec: 60,
  theme: 'system',          // 'system' | 'light' | 'dark'
  density: 'detailed',      // 'detailed' | 'compact'
  sortMode: 'urgent',       // 'urgent' | 'manual'
  reduceMotion: false,      // disable all UI animations/transitions
  notifyEnabled: true,
  language: 'system',       // 'system' follows Windows; or en, es, zh, he, pt, ru
  notifyThreshold: 20,      // notify when battery drops below this %
  notifyCharging: true,     // notify when a device starts charging
  notifyCharged: false,     // notify when a device finishes charging
  notifyStale: false,       // old reading alert for every device (each can override it)
  notifyStaleDays: 2,       // ... when its last real reading is older than this many days
  trayEnabled: true,        // show tray battery icons
  trayMode: 'list',         // 'perDevice' | 'list'
  closeToTray: true,        // hide to tray instead of quitting on close
  launchAtLogin: false,
  startMinimized: false,
  confirmedDevices: {},     // device id -> when "It works" was sent from this PC
  reportedDevices: {},      // 'VVVV:PPPP' -> when this PC last opened a device report on it
};

const store = new Store({
  name: 'battery-hub',
  defaults: {
    devices: {}, // id -> { id, product, manufacturer, driverId, profile, customName, order, hidden, lastReading, lastReadingAt, lastError }
    settings: { ...DEFAULT_SETTINGS },
  },
});

// Settings written before the redesign hold the old defaults; move those to the new ones once,
// so a choice made after this point is never overridden.
if (!store.get('uiV2')) {
  const { accent, ...old } = store.get('settings');
  store.set('settings', { ...old, trayMode: 'list' });
  store.set('uiV2', true);
}

// ---- in-memory copy ----
// electron-store reads and parses the whole file on every get and rewrites it atomically on every
// set; with a week of history that was about 230 ms of blocking work per poll. So the devices and
// settings are kept in memory, written only when they change, and handed out as copies, as
// electron-store did, so a caller changing what it got never changes the store behind its back.
const { isDeepStrictEqual } = require('util');
let devicesCache = null;
let settingsCache = null;
const loadDevices = () => (devicesCache ??= store.get('devices'));
const loadSettings = () => (settingsCache ??= store.get('settings'));
const copy = (value) => structuredClone(value);
function saveDevices() { store.set('devices', devicesCache); }

// ---- devices ----
function getDevices() {
  return copy(loadDevices());
}
function upsertDevice(id, patch) {
  const devices = loadDevices();
  const next = { ...(devices[id] || {}), ...patch, id };
  if (isDeepStrictEqual(devices[id], next)) return copy(next); // nothing changed: no write
  devices[id] = copy(next);
  saveDevices();
  return copy(next);
}
function removeDevice(id) {
  const devices = loadDevices();
  if (!(id in devices)) return;
  delete devices[id];
  saveDevices();
}
// Folds one card into another when they turn out to be the same device.
function mergeDevices(keepId, dropId) {
  const devices = loadDevices();
  const keep = devices[keepId];
  const drop = devices[dropId];
  if (!keep || !drop) return;
  const newest = (drop.lastReadingAt || 0) > (keep.lastReadingAt || 0) ? drop : keep;
  const history = [...(keep.history || []), ...(drop.history || [])].sort((a, b) => a.t - b.t);
  devices[keepId] = copy({
    ...keep,
    customName: keep.customName || drop.customName || null,
    customIcon: keep.customIcon || drop.customIcon || null,
    alertThreshold: keep.alertThreshold ?? drop.alertThreshold ?? null,
    product: /_/.test(keep.product || '') ? drop.product : keep.product, // "MX_Master_4"
    identity: keep.identity || drop.identity,
    order: Math.min(keep.order ?? 1e9, drop.order ?? 1e9),
    hidden: !!(keep.hidden && drop.hidden),
    lastReading: newest.lastReading,
    lastReadingAt: newest.lastReadingAt,
    history,
    links: [...(keep.links || []), { id: drop.id, driverId: drop.driverId, profile: drop.profile || null }, ...(drop.links || [])],
  });
  delete devices[dropId];
  saveDevices();
}

// Gives a card another id, keeping everything set on it.
function moveDevice(fromId, toId, patch) {
  const devices = loadDevices();
  if (!devices[fromId] || devices[toId]) return;
  devices[toId] = copy({ ...devices[fromId], ...patch, id: toId });
  delete devices[fromId];
  saveDevices();
}

// Persist a user-chosen card order as a per-device index.
function reorderDevices(orderedIds) {
  const devices = loadDevices();
  orderedIds.forEach((id, i) => { if (devices[id]) devices[id].order = i; });
  saveDevices();
  return copy(devices);
}

// ---- settings ----
function getSettings() {
  // merge with defaults so newly-added keys are always present
  return copy({ ...DEFAULT_SETTINGS, ...loadSettings() });
}
function getSetting(key) {
  const saved = loadSettings();
  const value = key in saved ? saved[key] : DEFAULT_SETTINGS[key];
  return value !== null && typeof value === 'object' ? copy(value) : value;
}
function setSettings(patch) {
  const settings = { ...DEFAULT_SETTINGS, ...loadSettings(), ...patch };
  if (!isDeepStrictEqual(settings, { ...DEFAULT_SETTINGS, ...loadSettings() })) {
    settingsCache = copy(settings);
    store.set('settings', settingsCache);
  }
  return copy(settings);
}
function getPollIntervalSec() {
  return getSetting('pollIntervalSec');
}

module.exports = {
  getDevices, upsertDevice, removeDevice, mergeDevices, moveDevice, reorderDevices,
  getSettings, getSetting, setSettings,
  getPollIntervalSec,
};
