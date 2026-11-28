// fork: builds src/main/taskbar-battery.exe from src/main/batteries/taskbar/*.cs (fork Issue #16) with
// the C# compiler that ships with Windows. Also works from WSL through Windows interop.
// Without a compiler it skips: the app then runs without the taskbar battery levels.
// On failure: run directly (`node scripts/build-taskbar-battery.js`) it always exits 1, so a check
// never runs an old exe. Required from build-batteries.js it throws when CI=true (no installer
// without the exe) and otherwise logs and skips (so `npm start` still runs).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'src', 'main', 'batteries', 'taskbar');
const OUT = path.join(ROOT, 'src', 'main', 'taskbar-battery.exe');
const FRAMEWORK = ['Microsoft.NET', 'Framework64', 'v4.0.30319'];
const WSL_CSC = path.posix.join('/mnt/c/Windows', ...FRAMEWORK, 'csc.exe');

// The compiler, and how to turn a local path into one it understands. null when there is none.
function findCompiler() {
  if (process.platform === 'win32') {
    const csc = path.join(process.env.WINDIR || 'C:\\Windows', ...FRAMEWORK, 'csc.exe');
    return fs.existsSync(csc) ? { csc, toWin: (p) => p } : null;
  }
  if (!fs.existsSync(WSL_CSC)) return null;
  const toWin = (p) => execFileSync('wslpath', ['-w', p], { encoding: 'utf8' }).trim();
  try {
    toWin(ROOT);
  } catch (e) {
    return null; // not WSL (no wslpath)
  }
  return { csc: WSL_CSC, toWin };
}

function sources() {
  return fs.readdirSync(SOURCE_DIR).filter((f) => f.endsWith('.cs')).sort().map((f) => path.join(SOURCE_DIR, f));
}

function upToDate(files) {
  if (!fs.existsSync(OUT)) return false;
  const built = fs.statSync(OUT).mtimeMs;
  return files.every((f) => fs.statSync(f).mtimeMs <= built);
}

// Returns quietly when skipped or already up to date; throws when the build fails.
function build() {
  const compiler = findCompiler();
  if (!compiler) {
    console.log('build-taskbar-battery: no Windows C# compiler here, skipping (no taskbar battery levels)');
    return;
  }
  const files = sources();
  if (upToDate(files)) return;
  const { csc, toWin } = compiler;
  const fw = toWin(path.dirname(csc));
  const refs = [
    'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Runtime.Serialization.dll',
    ...['UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll'].map((d) => path.win32.join(fw, 'WPF', d)),
  ].map((r) => `/r:${r}`);
  const srcDir = toWin(SOURCE_DIR);
  execFileSync(csc, ['/nologo', '/target:winexe', '/optimize+', '/platform:anycpu', `/out:${toWin(OUT)}`,
    ...refs, ...files.map((f) => path.win32.join(srcDir, path.basename(f)))], { stdio: 'inherit' });
  // In WSL the exe lands on the Linux file system without the execute bit; interop needs it to run.
  if (process.platform !== 'win32') fs.chmodSync(OUT, 0o755);
  console.log(`Wrote ${path.relative(ROOT, OUT)} (${Math.round(fs.statSync(OUT).size / 1024)} KB)`);
}

if (require.main === module) {
  try {
    build();
  } catch (e) {
    console.error(`build-taskbar-battery: build failed: ${e.message}`);
    process.exit(1);
  }
} else {
  try {
    build();
  } catch (e) {
    if (process.env.CI === 'true') throw e;
    console.log(`build-taskbar-battery: could not build the taskbar battery levels, skipping it (${e.message})`);
  }
}
