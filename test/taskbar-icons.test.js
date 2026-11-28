// fork: the taskbar icon PNGs that taskbar-battery.exe reads (fork Issue #16).
// They are built by `npx electron scripts/make-taskbar-icons.js` and kept in the repo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ICON_PATHS } = require('../src/main/taskbar-model');

const DIR = path.join(__dirname, '..', 'assets', 'taskbar');
const NAMES = ['mouse', 'keyboard', 'headset', 'mic', 'speaker', 'camera', 'controller', 'pen', 'plug', 'flash'];
const COLORS = ['white', 'black'];
const SIZES = [16, 20, 24, 32];

test('every name has a path in icons.js', () => {
  for (const name of NAMES) assert.equal(typeof ICON_PATHS[name], 'string', name);
});

for (const name of NAMES) {
  for (const color of COLORS) {
    for (const px of SIZES) {
      const file = `${name}-${color}-${px}.png`;
      test(file, () => {
        const buf = fs.readFileSync(path.join(DIR, file));
        assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG signature');
        assert.equal(buf.toString('ascii', 12, 16), 'IHDR');
        assert.equal(buf.readUInt32BE(16), px, 'width');
        assert.equal(buf.readUInt32BE(20), px, 'height');
      });
    }
  }
}
