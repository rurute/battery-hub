const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BH_STRINGS } = require('../src/renderer/i18n-strings');
const { bhTranslate, resolveLanguage } = require('../src/renderer/i18n-core');

const tr = (text) => bhTranslate(text, 'ru');
const renderer = path.join(__dirname, '../src/renderer');

// Russian works like es, zh and he (#217): it must keep the texts every language has, and every
// text it already translates (i18n-ru-keys.json, so a translation can't be lost by accident). A new
// text with no Russian is not required: it shows in English until someone translates it. When you
// add Russian for a text, you may add its key to i18n-ru-keys.json to protect it too.
const RU_KEYS = require('./i18n-ru-keys.json');
function missingRussian() {
  const required = new Set([...Object.keys(BH_STRINGS.es), ...RU_KEYS]);
  return [...required].filter((key) => !Object.hasOwn(BH_STRINGS.ru, key));
}

test('Russian keeps the texts every language has and every text it already translates', () => {
  assert.deepEqual(missingRussian(), [], 'Missing Russian translations');
  for (const [key, value] of Object.entries(BH_STRINGS.ru)) {
    assert.ok(value && value.trim(), 'Empty Russian translation: ' + key);
  }
});

test('a new text with no Russian is not required: it shows in English, as in es, zh and he', () => {
  // A contributor adds a text and translates it only into Portuguese (#217).
  BH_STRINGS.pt['A brand new sentence for the test.'] = 'Uma frase nova para o teste.';
  try {
    assert.deepEqual(missingRussian(), []);
    assert.equal(tr('A brand new sentence for the test.'), 'A brand new sentence for the test.');
  } finally {
    delete BH_STRINGS.pt['A brand new sentence for the test.'];
  }
});

test('Russian translates calibration, help and device-confirmation screens', () => {
  const examples = [
    '1. Scan the device', '2. Pick the battery value', '3. Confirm',
    'Choose an icon', 'Notification test (this PC only)',
    'Low battery alerts are off in Settings',
    'Still not working?', 'Is this battery level right?',
    'It works! Let the developer know', 'Thank you!',
    'This device is no longer saved', 'Python for your headset',
    "Settings can't be saved.", 'Run again',
    'The part that talks to your devices didn\'t start.',
  ];
  for (const english of examples) assert.notEqual(tr(english), english, english);
  assert.equal(resolveLanguage('system', 'ru-RU'), 'ru');
});

test('Russian translates dynamic diagnostics and makes plurals correctly', () => {
  const examples = [
    'All 312 files match what was shipped.',
    '3 of 312 files are missing or changed.',
    'You have 2.0.6, the latest version.',
    'You have 2.0.5. The latest is v2.0.6.',
    "You have 2.0.5. Couldn't reach GitHub to compare.",
    'Working: found 1 device in 12 ms.',
    'Working: found 4 devices in 5 ms.',
    'Working: Windows has a battery reading for 1 device.',
    'Working: Windows has a battery reading for 4 devices.',
    '11 in the last week.',
    'Last read just now.',
    'Last read 5 min ago.',
    'Last read 3 h ago.',
    'Last read 4 days ago.',
    "Didn't answer, so it may be asleep. Last read 5 min ago.",
    "Can't read it: device sleeping",
    "The check couldn't finish: This device is no longer saved",
    "The report couldn't be made: This device is no longer saved",
    "The form couldn't be opened: offline",
    'Battery from 80% to 40%, between 35% and 90%. Use the arrow keys to read each point.',
    'The scan takes 45 seconds. While it runs, turn the device off and on once or twice, because many devices only report their battery at power on. If the device has its own app, keep it open.',
  ];
  for (const english of examples) assert.notEqual(tr(english), english, english);
  assert.equal(tr('All 1 files match what was shipped.'), '1 файл соответствует исходной поставке.');
  assert.equal(tr('All 2 files match what was shipped.'), '2 файла соответствуют исходной поставке.');
  assert.equal(tr('All 5 files match what was shipped.'), '5 файлов соответствуют исходной поставке.');
  assert.match(tr('Working: found 21 devices in 8 ms.'), /21 устройство/);
  assert.match(tr('Working: found 12 devices in 8 ms.'), /12 устройств/);
  assert.match(tr('Last read 4 days ago.'), /4 дня назад/);
  assert.match(tr('Last read 11 days ago.'), /11 дней назад/);
  assert.match(tr("The report couldn't be made: This device is no longer saved"), /Это устройство больше не сохранено/);
});

test('Russian translates GitHub report notes and scan error reasons', () => {
  const examples = [
    'Opens GitHub with the device filled in, so it can be listed and built in for everyone. Nothing is posted until you submit it there. You need a free GitHub account. Issues are public, so your user name, device serials and Bluetooth details are left out.',
    'Opens GitHub with the report filled in. Nothing is posted until you submit it there. You need a free GitHub account. Issues are public, so your user name, device serials and Bluetooth details are left out.',
    'Your browser opened with the report filled in. Nothing is posted until you submit it there. You need a free GitHub account. Issues are public, so your user name, device serials and Bluetooth details are left out. This report is too long for a link, so the full version is also copied for you to paste in.',
    'Scan failed: This device is no longer saved',
    'Channel 0xff00, input report 85, seen 3 times',
  ];
  for (const english of examples) assert.notEqual(tr(english), english, english);
  assert.match(tr('Scan failed: This device is no longer saved'), /Это устройство больше не сохранено/);
  assert.match(tr('Channel 0xff00, input report 85, seen 3 times'), /3 раза/);
});
