const kysona = require('./kysona');
const compx = require('./compx');
const mchose = require('./mchose');
const mchoseMouse = require('./mchose-mouse');
const sinowealth = require('./sinowealth');
const beken = require('./beken');
const bitmouse = require('./bitmouse');
const yjx = require('./yjx');
const inzone = require('./inzone');
const atkHoltek = require('./atk-holtek');
const tabled = require('./tabled');
const hidpp = require('./hidpp');
const razer = require('./razer');
const playstation = require('./playstation');
const audeze = require('./audeze');
const elecom = require('./elecom');
const akko = require('./akko');
const rapoo = require('./rapoo');
const gearhub = require('./gearhub');
const bytech = require('./bytech');
const bloody = require('./bloody');
const darmoshark = require('./darmoshark');
const nintendo = require('./nintendo');
const controllers = require('./controllers');
const generic = require('./generic');

// Auto-detected protocols, checked in order. Logitech headsets are in the table, so it comes
// before the general Logitech driver. The Compx keyboard receiver shares its vendor id with the
// Kysona mice, so it comes first. The INZONE Buds dongle shares Sony's vendor id with the
// PlayStation controllers; each claims only its own product ids.
const knownDrivers = [compx, kysona, mchose, mchoseMouse, sinowealth, beken, bitmouse, yjx, akko, rapoo, gearhub, bytech, bloody, darmoshark, atkHoltek, tabled, audeze, razer, inzone, playstation, nintendo, controllers, elecom, hidpp];
const byId = new Map(knownDrivers.map((d) => [d.id, d]));

function detectDriver(logicalDevice) {
  return knownDrivers.find((d) => d.matches(logicalDevice)) || null;
}

function driverById(id) {
  return byId.get(id) || generic;
}

module.exports = { generic, detectDriver, driverById };
