const kysona = require('./kysona');
const compx = require('./compx');
const mchose = require('./mchose');
const mchoseMouse = require('./mchose-mouse');
const sinowealth = require('./sinowealth');
const beken = require('./beken');
const bitmouse = require('./bitmouse');
const yjx = require('./yjx');
const tabled = require('./tabled');
const hidpp = require('./hidpp');
const razer = require('./razer');
const playstation = require('./playstation');
const audeze = require('./audeze');
const generic = require('./generic');

// Auto-detected protocols, checked in order. Logitech headsets are in the table, so it comes
// before the general Logitech driver. The Compx keyboard receiver shares its vendor id with the
// Kysona mice, so it comes first.
const knownDrivers = [compx, kysona, mchose, mchoseMouse, sinowealth, beken, bitmouse, yjx, tabled, audeze, razer, playstation, hidpp];
const byId = new Map(knownDrivers.map((d) => [d.id, d]));

function detectDriver(logicalDevice) {
  return knownDrivers.find((d) => d.matches(logicalDevice)) || null;
}

function driverById(id) {
  return byId.get(id) || generic;
}

module.exports = { generic, detectDriver, driverById };
