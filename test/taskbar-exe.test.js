// fork: runs taskbar-battery.exe's own self-test (fork Issue #16). The C# side has no test runner of
// its own, so `--self-test` runs its table of cases and prints "PASS <count>" or "FAIL ...".
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'src', 'main', 'taskbar-battery.exe');
const ASSETS = path.join(ROOT, 'assets', 'taskbar');

test('taskbar-battery.exe --self-test passes', (t) => {
  if (process.platform !== 'win32') {
    t.skip('needs Windows and taskbar-battery.exe');
    return;
  }
  if (!fs.existsSync(EXE)) {
    // On the Windows CI the build must have made it; don't let the self-test be skipped there.
    if (process.env.CI === 'true') assert.fail('taskbar-battery.exe was not built');
    t.skip('needs Windows and taskbar-battery.exe');
    return;
  }
  const r = spawnSync(EXE, ['--self-test', '--assets', ASSETS], { encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(r.error, undefined, String(r.error));
  assert.strictEqual(r.status, 0, `exit ${r.status}\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /^PASS \d+/);
});
