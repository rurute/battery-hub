// Fork only: gives a fork build its own version (X.Y.Z-fork.N, or X.Y.Z-fork.0.<run> for a manual
// build) and points auto-update at the fork's Releases. Run by the fork's workflows inside CI only;
// the rewritten package.json is never committed, so merging upstream never conflicts. See docs/fork.md.
//
//   node scripts/fork-version.js --tag v2.0.7-fork.1
//   node scripts/fork-version.js --dev 12
const fs = require('fs');
const path = require('path');

const PACKAGE = path.join(__dirname, '..', 'package.json');
const FORK_PUBLISH = { provider: 'github', owner: 'rurute', repo: 'battery-hub' };

function versionFromTag(tag, baseVersion) {
  const match = /^v(\d+\.\d+\.\d+)-fork\.([1-9]\d*)$/.exec(String(tag));
  if (!match) throw new Error(`"${tag}" is not a fork release tag (expected v${baseVersion}-fork.N, N from 1)`);
  if (match[1] !== baseVersion) {
    throw new Error(`Tag ${tag} is for ${match[1]}, but package.json is ${baseVersion}`);
  }
  return `${match[1]}-fork.${match[2]}`;
}

function devVersion(baseVersion, runNumber) {
  if (!/^[1-9]\d*$/.test(String(runNumber))) throw new Error(`"${runNumber}" is not a run number`);
  return `${baseVersion}-fork.0.${runNumber}`;
}

function applyFork(pkg, version) {
  const publish = [{ ...FORK_PUBLISH }, ...((pkg.build && pkg.build.publish) || []).slice(1)];
  return { ...pkg, version, build: { ...pkg.build, publish } };
}

function main(args) {
  const [flag, value] = args;
  const pkg = JSON.parse(fs.readFileSync(PACKAGE, 'utf8'));
  let version;
  if (flag === '--tag') version = versionFromTag(value, pkg.version);
  else if (flag === '--dev') version = devVersion(pkg.version, value);
  else throw new Error('Usage: fork-version.js --tag vX.Y.Z-fork.N | --dev <run_number>');

  fs.writeFileSync(PACKAGE, `${JSON.stringify(applyFork(pkg, version), null, 2)}\n`);

  const written = JSON.parse(fs.readFileSync(PACKAGE, 'utf8'));
  if (written.version !== version || written.build.publish[0].owner !== FORK_PUBLISH.owner) {
    throw new Error('package.json did not take the fork version and publish target');
  }
  console.log(version);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`fork-version: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { versionFromTag, devVersion, applyFork };
