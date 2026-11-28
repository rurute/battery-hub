const test = require('node:test');
const assert = require('node:assert');

// The Worker against a fake GitHub and a fake KV: a report opens an issue, its key answers it, and
// anyone else's key, or too many reports, are refused.
test('the relay opens an issue, answers with the key, and refuses others', async () => {
  const worker = (await import('../relay/worker.mjs')).default;
  const kv = new Map();
  const env = {
    GITHUB_TOKEN: 'test',
    RELAY: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } },
  };
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ number: 300, html_url: 'https://github.com/battery-hub/battery-hub/issues/300' }), { status: 201 });
  };
  const call = (path, body, ip = '1.2.3.4') => worker.fetch(new Request(`https://relay.test${path}`, {
    method: 'POST', body: JSON.stringify(body), headers: { 'cf-connecting-ip': ip },
  }), env);
  try {
    const sent = await (await call('/report', { template: 'works', fields: { title: '[Works] Mouse', device: 'Mouse', how: 'x' } })).json();
    assert.equal(sent.number, 300);
    assert.match(calls[0].url, /\/repos\/battery-hub\/battery-hub\/issues$/);
    assert.deepEqual(calls[0].body.labels, ['works', 'from-app']);

    assert.equal((await call('/comment', { number: 300, key: sent.key, text: 'It reads 60%' })).status, 200);
    assert.match(calls[1].url, /\/issues\/300\/comments$/);
    assert.equal((await call('/comment', { number: 300, key: 'someone-else', text: 'spam' })).status, 403);

    for (let i = 0; i < 4; i++) await call('/report', { template: 'works', fields: { title: '[Works] M', device: 'M' } }, '9.9.9.9');
    assert.equal((await call('/report', { template: 'works', fields: { title: '[Works] M', device: 'M' } }, '9.9.9.9')).status, 200);
    assert.equal((await call('/report', { template: 'works', fields: { title: '[Works] M', device: 'M' } }, '9.9.9.9')).status, 429);
    assert.equal((await call('/report', { template: 'nope', fields: {} })).status, 400);
  } finally {
    global.fetch = realFetch;
  }
});
