const test = require('node:test');
const assert = require('node:assert');
const { versionFromTag, devVersion, applyFork } = require('../scripts/fork-version');

test('turns a fork tag into its version', () => {
  assert.equal(versionFromTag('v2.0.7-fork.1', '2.0.7'), '2.0.7-fork.1');
  assert.equal(versionFromTag('v2.0.7-fork.12', '2.0.7'), '2.0.7-fork.12');
});

test('rejects a tag for another base version', () => {
  assert.throws(() => versionFromTag('v2.0.6-fork.1', '2.0.7'), /2\.0\.6.*2\.0\.7|2\.0\.7.*2\.0\.6/);
});

test('rejects tags that are not fork releases', () => {
  for (const tag of ['v2.0.7', 'v2.0.7-fork.0', 'v2.0.7-fork.01', 'v2.0.7-fork.x', '2.0.7-fork.1', 'v2.0.7-beta.1']) {
    assert.throws(() => versionFromTag(tag, '2.0.7'), Error, tag);
  }
});

test('a manual build sorts below the first fork release', () => {
  assert.equal(devVersion('2.0.7', '12'), '2.0.7-fork.0.12');
  assert.throws(() => devVersion('2.0.7', ''));
});

test('points publishing at the fork and keeps the rest', () => {
  const pkg = { name: 'battery-hub', version: '2.0.7', build: { appId: 'x', publish: [{ provider: 'github', owner: 'battery-hub', repo: 'battery-hub' }] } };
  const out = applyFork(pkg, '2.0.7-fork.1');
  assert.equal(out.version, '2.0.7-fork.1');
  assert.deepEqual(out.build.publish[0], { provider: 'github', owner: 'rurute', repo: 'battery-hub' });
  assert.equal(out.build.appId, 'x');
  assert.equal(pkg.version, '2.0.7');
  assert.equal(pkg.build.publish[0].owner, 'battery-hub');
});
