// Turn built folders into the artifacts an updater will accept:
//
//   solar-dashboard-arm64.tar.gz
//   solar-dashboard-x64.tar.gz
//   SHA256SUMS
//
// Then sign SHA256SUMS yourself. This script deliberately does NOT sign, and will not be
// given a way to: the private key is the one thing standing between a compromised
// publishing account and root on every install, so it must never be reachable by a build
// script, a CI job, or anything holding a token. Signing is a manual step on a machine
// that holds the key.
//
//   node packaging/release.mjs [arm64|linux|win|all]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const OUT = join(ROOT, 'packaging', 'out');

// The asset name carries node's own arch string, which is what the app compares against —
// one name, decided in one place, rather than a mapping table that can drift.
const ASSET_ARCH = { arm64: 'arm64', linux: 'x64', win: 'win-x64' };

const wanted = process.argv[2] ?? 'all';
const targets = (wanted === 'all' ? Object.keys(ASSET_ARCH) : [wanted]).filter((name) => {
  if (!ASSET_ARCH[name]) {
    console.error(`unknown target ${name}; use ${Object.keys(ASSET_ARCH).join('|')}|all`);
    process.exit(1);
  }
  return existsSync(join(OUT, name));
});

if (targets.length === 0) {
  console.error(`nothing built in ${OUT} — run node packaging/build.mjs first`);
  process.exit(1);
}

const sums = [];
for (const name of targets) {
  const dist = join(OUT, name);
  const stamp = join(dist, 'version.json');
  if (!existsSync(stamp)) {
    // A release without a stamp cannot be verified after install, and the updater refuses
    // to replace an unstamped build. Publishing one would produce an install that can
    // never update again.
    console.error(`${dist} has no version.json — rebuild before packaging a release`);
    process.exit(1);
  }
  const asset = `solar-dashboard-${ASSET_ARCH[name]}.tar.gz`;
  const path = join(OUT, asset);
  console.log(`> packing ${asset}`);
  /*
    Relative paths with a cwd, not absolute ones. Windows' bundled bsdtar fails outright
    on `-C D:\...\arm64` — status 2, no message — while the identical command with a
    relative target succeeds. -C so the archive holds the files rather than the path they
    happened to be built at.
  */
  execFileSync('tar', ['-czf', asset, '-C', name, '.'], { cwd: OUT, stdio: 'inherit' });
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  sums.push(`${digest}  ${asset}`);
  console.log(`  ${(statSync(path).size / 1024 / 1024).toFixed(1)} MB  ${digest.slice(0, 16)}…`);
}

const sumsPath = join(OUT, 'SHA256SUMS');
writeFileSync(sumsPath, `${sums.join('\n')}\n`);

const version = JSON.parse(readFileSync(join(OUT, targets[0], 'version.json'), 'utf8')).version;
console.log(`\nSHA256SUMS written for ${version}.`);
console.log('\nNow sign it, on the machine that holds the key:');
console.log(`  minisign -Sm ${sumsPath}`);
console.log('\nThen publish the tarballs, SHA256SUMS and SHA256SUMS.minisig together.');
console.log('An install with a key configured will refuse anything missing the signature.');
