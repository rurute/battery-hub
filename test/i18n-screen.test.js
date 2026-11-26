// Every piece of text the app writes on screen must have a Portuguese translation, so a new screen
// or a new sentence can't ship half in English. The scan reads the renderer's source:
//   - text between tags and title/placeholder/aria-label in index.html and flyout.html
//   - every string literal in the window scripts that looks like a sentence or a label
//   - the text inside HTML that app.js and the other scripts build with template literals
// Not counted, on purpose: ids, class names and selectors (they start in lower case), key names,
// the brand and the language names in the language list, and mock.js (sample data for development).
// The report sent to support is written in the main process and never goes through this.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { BH_STRINGS } = require('../src/renderer/i18n-strings');
const { bhTranslate } = require('../src/renderer/i18n-core');

const RENDERER = path.join(__dirname, '../src/renderer');
const SCRIPTS = ['app.js', 'detail.js', 'support.js', 'flyout.js'];
const PAGES = ['index.html', 'flyout.html'];
const NOT_TEXT = new Set(['Enter', 'Escape', 'Home', 'End', 'Tab', 'Battery Hub', 'English', 'Español', 'Português (Brasil)', '中文', 'עברית']);
const HOLE = '\u0001'; // stands where a template puts a value

const read = (f) => fs.readFileSync(path.join(RENDERER, f), 'utf8');
const withoutComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const squash = (t) => t.replace(/\s+/g, ' ').trim();
const translated = (t) => bhTranslate(t, 'pt') !== t || squash(t) in BH_STRINGS.pt;

function literals(src) {
  const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  const found = [];
  let m;
  while ((m = re.exec(src))) {
    const raw = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
    found.push({ text: raw.replace(/\\'/g, "'").replace(/\\"/g, '"'), template: m[3] !== undefined });
  }
  return found;
}

// The visible text and the text-like attributes in a piece of HTML.
function htmlTexts(html) {
  const body = html.replace(/<(script|style)[\s\S]*?<\/\1>/g, '').replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, HOLE);
  const found = [];
  for (const x of body.matchAll(/>([^<>]+)</g)) found.push(squash(x[1]));
  for (const x of body.matchAll(/(?:title|placeholder|aria-label|alt)="([^"]+)"/g)) found.push(squash(x[1]));
  return found.filter((t) => /[A-Za-z]{2}/.test(t) && !NOT_TEXT.has(t));
}

function assertCovered(where, texts) {
  const missing = [...new Set(texts)].filter((t) => !translated(t));
  assert.deepEqual(missing, [], `${where}: these have no Portuguese translation`);
}

test('the pages have no text without a Portuguese translation', () => {
  for (const f of PAGES) {
    const texts = htmlTexts(read(f));
    assert.ok(texts.length > 1, `${f}: texts were found`);
    assertCovered(f, texts);
  }
});

test('the labels and sentences in the window scripts have a Portuguese translation', () => {
  for (const f of SCRIPTS) {
    const texts = literals(withoutComments(read(f)))
      .filter(({ text }) => !text.includes('${') && !text.includes('<'))
      .map(({ text }) => text)
      .filter((t) => /^[A-Z]/.test(t) && /[a-z]{2}/.test(t) && !/[=;{}]/.test(t) && !NOT_TEXT.has(t));
    assertCovered(f, texts);
  }
});

test('the HTML the scripts build has a Portuguese translation for each of its texts', () => {
  let seen = 0;
  for (const f of SCRIPTS) {
    const parts = literals(withoutComments(read(f)))
      .filter(({ text }) => /<[a-z/]/i.test(text)) // HTML with tags, in any kind of quotes
      .flatMap(({ text }) => htmlTexts(text));
    seen += parts.length;
    // A text with a value in it is a pattern: the examples below stand in for them.
    assertCovered(f, parts.filter((t) => !t.includes(HOLE)));
  }
  assert.ok(seen > 10, 'the built HTML was read');
});

test('the texts with numbers or reasons in the scan and setup screens are in Portuguese', () => {
  const examples = [
    'Set up AULA F87 Pro',
    'The scan takes 30 seconds. While it runs, turn the device off and on once or twice, because\n        many devices only report their battery at power on. If the device has its own app, keep it open.',
    'Scan failed: device not connected',
    'Channel 0xff00, input report 1, seen 12 times',
    'Channel 0x1, feature report 7, seen 1 times',
    's remaining',
    'Scanning…',
  ];
  assertCovered('the scan flow', examples);
  assert.equal(bhTranslate('Channel 0xff00, input report 1, seen 12 times', 'pt'), 'Canal 0xff00, relatório de entrada 1, visto 12 vezes');
  assert.equal(bhTranslate('Scan failed: This device is no longer saved', 'pt'), 'A busca falhou: Este dispositivo não está mais salvo');
  assert.equal(bhTranslate('The scan takes 45 seconds. While it runs, turn the device off and on once or twice, because many devices only report their battery at power on. If the device has its own app, keep it open.', 'pt').startsWith('A busca leva 45 segundos.'), true);
});

test('text that wraps over several lines in the source still matches its translation', () => {
  assert.equal(bhTranslate('\n      Back\n   ', 'pt'), '\n      Voltar\n   ');
  assert.equal(bhTranslate('Not   enough\n readings in this period yet.', 'pt'), 'Ainda não há leituras suficientes neste período.');
});
