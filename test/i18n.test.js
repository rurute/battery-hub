const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { BH_STRINGS } = require('../src/renderer/i18n-strings');
const { BH_LANGS, PATTERNS, UNITS, bhTranslate, resolveLanguage } = require('../src/renderer/i18n-core');

test('the language follows Windows unless one is chosen', () => {
  assert.equal(resolveLanguage('system', 'es-MX'), 'es');
  assert.equal(resolveLanguage('system', 'zh-TW'), 'zh');
  assert.equal(resolveLanguage('system', 'he'), 'he');
  assert.equal(resolveLanguage('system', 'ru-RU'), 'ru');
  assert.equal(resolveLanguage('ru', 'en-US'), 'ru');
  assert.equal(resolveLanguage('system', 'fr-FR'), 'en');
  assert.equal(resolveLanguage(undefined, 'he-IL'), 'he');
  assert.equal(resolveLanguage('es', 'he-IL'), 'es');
});

test('Portuguese is chosen for pt-BR, pt-PT and plain pt', () => {
  assert.equal(resolveLanguage('system', 'pt-BR'), 'pt');
  assert.equal(resolveLanguage('system', 'pt-PT'), 'pt');
  assert.equal(resolveLanguage('system', 'pt'), 'pt');
  assert.equal(resolveLanguage(undefined, 'pt-BR'), 'pt');
  assert.equal(resolveLanguage('pt', 'he-IL'), 'pt');
  assert.equal(resolveLanguage('es', 'pt-BR'), 'es');
  assert.equal(resolveLanguage('system', 'ps-AF'), 'en', 'only pt itself, not any language starting with p');
});

test('exact text and text with numbers or names are translated, the rest stays English', () => {
  assert.equal(bhTranslate('Settings', 'he'), 'הגדרות');
  assert.equal(bhTranslate('  Settings  ', 'es'), '  Ajustes  ', 'surrounding spaces are kept');
  assert.equal(bhTranslate('Updated 40s ago', 'es'), 'Actualizado hace 40 s');
  assert.equal(bhTranslate('~1d 16h left', 'zh'), '剩余约 1天 16小时');
  assert.equal(bhTranslate('12.0% an hour', 'he'), '12.0% בשעה');
  assert.equal(bhTranslate('MX Master 4 is at 15%. Time to charge.', 'es'), 'MX Master 4 está al 15%. Hora de cargarlo.');
  assert.equal(bhTranslate('Set up AULA F87 Pro', 'zh'), '设置 AULA F87 Pro');
  assert.equal(bhTranslate('Something new', 'he'), 'Something new');
  assert.equal(bhTranslate('Settings', 'en'), 'Settings');
  assert.equal(bhTranslate('Settings', 'ru'), 'Настройки');
  assert.equal(bhTranslate('~1d 16h left', 'ru'), 'Осталось примерно 1 дн. 16 ч');
  assert.equal(bhTranslate('MX Master 4 is at 15%. Time to charge.', 'ru'), 'Устройство «MX Master 4»: заряд 15%. Пора заряжать.');
  assert.equal(bhTranslate('1 hidden device', 'ru'), '1 скрытое устройство');
  assert.equal(bhTranslate('2 hidden devices', 'ru'), '2 скрытых устройства');
  assert.equal(bhTranslate('5 hidden devices', 'ru'), '5 скрытых устройств');
  assert.equal(bhTranslate('11 hidden devices', 'ru'), '11 скрытых устройств');
  assert.equal(bhTranslate('21 hidden devices', 'ru'), '21 скрытое устройство');
});

test('Brazilian Portuguese: exact text uses the Windows wording', () => {
  assert.equal(bhTranslate('Settings', 'pt'), 'Configurações');
  assert.equal(bhTranslate('  Settings  ', 'pt'), '  Configurações  ');
  assert.equal(bhTranslate('Charging', 'pt'), 'Carregando');
  assert.equal(bhTranslate('Something new', 'pt'), 'Something new');
});

test('Brazilian Portuguese: durations and text with numbers or names', () => {
  assert.equal(bhTranslate('Updated 40s ago', 'pt'), 'Atualizado há 40 s');
  assert.equal(bhTranslate('3h ago', 'pt'), 'há 3 h');
  assert.equal(bhTranslate('5m ago', 'pt'), 'há 5 min');
  assert.equal(bhTranslate('2d ago', 'pt'), 'há 2 d');
  assert.equal(bhTranslate('~1d 16h left', 'pt'), 'Restam ~1 d 16 h');
  assert.equal(bhTranslate('~7h', 'pt'), '~7 h');
  assert.equal(bhTranslate('12.0% an hour', 'pt'), '12.0% por hora');
  assert.equal(bhTranslate('3.5% a day', 'pt'), '3.5% por dia');
  assert.equal(bhTranslate('Same as Settings (20%)', 'pt'), 'Igual às Configurações (20%)');
  assert.equal(bhTranslate('Charging, 80%', 'pt'), 'Carregando, 80%');
  assert.equal(bhTranslate('1 hidden device', 'pt'), '1 dispositivo oculto');
  assert.equal(bhTranslate('2 hidden devices', 'pt'), '2 dispositivos ocultos');
  assert.equal(bhTranslate('Dongle · 1 channel', 'pt'), 'Dongle · 1 canal');
  assert.equal(bhTranslate('Dongle · 3 channels', 'pt'), 'Dongle · 3 canais');
  assert.equal(bhTranslate('Version 2.0.5', 'pt'), 'Versão 2.0.5');
  assert.equal(bhTranslate('Update available: v2.1.0', 'pt'), 'Atualização disponível: v2.1.0');
  assert.equal(bhTranslate('Update ready: v2.1.0', 'pt'), 'Atualização pronta: v2.1.0');
  assert.equal(bhTranslate('Set up AULA F87 Pro', 'pt'), 'Configurar AULA F87 Pro');
  assert.equal(bhTranslate('AULA F87 Pro: open details', 'pt'), 'AULA F87 Pro: abrir detalhes');
});

test('Brazilian Portuguese notifications do not depend on the gender of the device', () => {
  assert.equal(bhTranslate('MX Master 4 is at 15%. Time to charge.', 'pt'), 'MX Master 4 está com 15%. Hora de carregar.');
  assert.equal(bhTranslate('MX Master 4 is charging (15%).', 'pt'), 'Carregando: MX Master 4 (15%).');
  assert.equal(bhTranslate('MX Master 4 is charged (100%).', 'pt'), 'Carga completa: MX Master 4 (100%).');
});

test('the old reading alert reads well in Portuguese', () => {
  const { ALERTS } = require('../src/main/notifier');
  const pt = (t) => bhTranslate(t, 'pt');
  const three = ALERTS.stale('Fuxi-H6', 3);
  assert.equal(pt(three.title), 'Leitura antiga');
  assert.equal(pt(three.body), 'Fuxi-H6: última leitura há 3 dias. Conecte-o de um jeito que o Battery Hub consiga ler, como o Bluetooth, para atualizar.');
  assert.equal(pt('Same as Settings (2 days)'), 'Igual às Configurações (2 dias)');
  assert.equal(pt('Same as Settings (1 day)'), 'Igual às Configurações (1 dia)');
  assert.equal(bhTranslate('Same as Settings (2 days)', 'ru'), 'Как в настройках (2 дня)');
  assert.equal(pt(ALERTS.stale('MX Keys Mini', 1).body), 'MX Keys Mini: última leitura há 1 dia. Conecte-o de um jeito que o Battery Hub consiga ler, como o Bluetooth, para atualizar.');
});

test('every language has the same keys', () => {
  const keys = (l) => Object.keys(BH_STRINGS[l]).sort().join('|');
  assert.equal(keys('es'), keys('zh'));
  assert.equal(keys('es'), keys('he'));
  // Russian includes extra strings used by the device calibration wizard.
  for (const key of Object.keys(BH_STRINGS.es)) assert.ok(Object.hasOwn(BH_STRINGS.ru, key), `Missing Russian key: ${key}`);
  const missing = Object.keys(BH_STRINGS.es).filter((k) => !(k in BH_STRINGS.pt));
  assert.deepEqual(missing, [], 'Portuguese has every text the others have (it may also have more: the Help panel)');
});

test('every language but English has a table and duration units; every pattern has Portuguese', () => {
  for (const lang of BH_LANGS.filter((l) => l !== 'en')) {
    assert.ok(BH_STRINGS[lang], `${lang} has a table`);
    assert.ok(UNITS[lang], `${lang} has duration units`);
    for (const unit of ['d', 'h', 'm', 's']) assert.ok(UNITS[lang][unit], `${lang} has a unit for ${unit}`);
  }
  for (const [re, forms] of PATTERNS) assert.equal(typeof forms.pt, 'function', `pt has a form of ${re}`);
});

test('es, zh and he cover the same patterns', () => {
  const covered = (lang) => PATTERNS.filter(([, forms]) => forms[lang]).map(([re]) => String(re)).join('|');
  assert.equal(covered('es'), covered('zh'));
  assert.equal(covered('es'), covered('he'));
});

test('every language in the settings list is one the app knows', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
  const select = html.match(/<select[^>]*data-setting="language"[^>]*>([\s\S]*?)<\/select>/);
  assert.ok(select, 'the language selector is in index.html');
  const values = [...select[1].matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(values.includes('pt'), 'Portuguese can be chosen');
  for (const v of values) assert.ok(v === 'system' || BH_LANGS.includes(v), `${v} is a known language`);
  for (const l of BH_LANGS) assert.ok(values.includes(l), `${l} can be chosen`);
});

test('Russian calibration, support and compact labels', () => {
  assert.equal(bhTranslate('1. Scan the device', 'ru'), '1. Сканирование устройства');
  assert.equal(bhTranslate('Scan again', 'ru'), 'Повторить сканирование');
  assert.equal(bhTranslate('Still not working?', 'ru'), 'Всё ещё не работает?');
  assert.equal(bhTranslate('Real battery level, e.g. 62% (or "don\'t know")', 'ru'),
    'Фактический заряд, например 62% (или «не знаю»)');
  assert.equal(bhTranslate('Scan failed: timeout', 'ru'), 'Ошибка сканирования: timeout');
  assert.equal(bhTranslate('Channel 0xff00, input report 85, seen 3 times', 'ru'),
    'Канал 0xff00, входящий отчёт 85, получен 3 раза');
  assert.equal(bhTranslate('System', 'ru'), 'Система');
  assert.equal(bhTranslate('Most urgent', 'ru'), 'По заряду');
  assert.equal(bhTranslate('My order', 'ru'), 'Вручную');
  assert.equal(bhTranslate('Per device', 'ru'), 'Отдельно');
  assert.equal(bhTranslate('Single list', 'ru'), 'Списком');
  assert.equal(bhTranslate('Add', 'ru'), 'Добавить');
  assert.equal(bhTranslate('  The scan takes 30 seconds. While it runs, turn the device off and on once or twice, because\n    many devices only report their battery at power on. If the device has its own app, keep it open.  ', 'ru'),
    '  Сканирование длится 30 секунд. За это время выключите и снова включите устройство один или два раза: некоторые устройства передают заряд только при включении. Если у устройства есть своя программа, не закрывайте её.  ');
});
