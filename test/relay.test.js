const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseReport } = require('../.github/scripts/triage');

const load = () => import('../relay/report.mjs');

test('a report sent through the relay reads like one sent on GitHub', async () => {
  const { buildIssue } = await load();
  const issue = buildIssue({
    template: 'device-support',
    fields: {
      title: '[Device] Gaming Mouse',
      device: 'Compx Gaming Mouse',
      connection: 'USB',
      ids: 'VID_25A7 / PID_FA3F',
      actual: '80%',
      version: '2.0.8',
      scan: 'Channels: ff02:0002\nScan 1: 3 messages\nff02:0002 report 9, seen 3x: 0904000000020800',
    },
  });
  assert.equal(issue.title, '[Device] Gaming Mouse');
  assert.deepEqual(issue.labels, ['device-support', 'from-app']);
  const report = parseReport({ title: issue.title, body: issue.body });
  assert.equal(report.hardware, '25A7:FA3F');
  assert.equal(report.version, '2.0.8');
  assert.equal(report.hasLevel, true);
  assert.equal(report.bytes, true);
  assert.match(issue.body, /### Anything else\n\n_No response_/);
});

test('the relay refuses what is not a report, and nobody gets pinged', async () => {
  const { buildIssue, buildComment } = await load();
  assert.throws(() => buildIssue({ template: 'other', fields: {} }), /unknown report type/);
  assert.throws(() => buildIssue({ template: 'works', fields: { title: 'Free money' } }), /bad title/);
  assert.throws(() => buildIssue({ template: 'works', fields: { title: '[Works] x' } }), /empty report/);
  assert.throws(() => buildComment('   '), /empty reply/);
  const issue = buildIssue({ template: 'support-request', fields: { problem: 'hi @someone', report: 'x' } });
  assert.ok(!/@someone/.test(issue.body));
  assert.match(buildComment('it is 60% now'), /^\*\*From the person who sent this report\*\*/);
});

test("the relay's fields are the issue forms' fields, in the same order", async () => {
  const { TEMPLATES } = await load();
  for (const [name, template] of Object.entries(TEMPLATES)) {
    const yml = fs.readFileSync(path.join(__dirname, '..', '.github', 'ISSUE_TEMPLATE', `${name}.yml`), 'utf8');
    const ids = [...yml.matchAll(/^\s+id: (\w+)/gm)].map((m) => m[1]);
    assert.deepEqual(template.fields.map(([id]) => id), ids, name);
  }
});

test('the app sends the same form it would open on GitHub', () => {
  const diagnostics = require('../src/main/diagnostics');
  const { form } = diagnostics.requestUrl('Checks:\n- OK Version');
  assert.equal(form.template, 'support-request.yml');
  assert.equal(form.fields.report, 'Checks:\n- OK Version');
});
