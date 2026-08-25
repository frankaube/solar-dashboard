// Builds SolarDashboardSetup.exe — the Windows installer.
//
//   node packaging/build-installer.mjs [--skip-build]
//
// Runs the win-x64 packager first (unless --skip-build), stages the WinSW service
// wrapper, then compiles packaging/windows/solar-dashboard.iss with Inno Setup.
//
// Two third-party pieces are needed and neither is vendored into the repo:
//
//   Inno Setup 6   winget install JRSoftware.InnoSetup
//   WinSW-x64.exe  https://github.com/winsw/winsw/releases  →  packaging/vendor/
//
import { execFileSync, execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const OUT = join(ROOT, 'packaging', 'out');
const WIN = join(OUT, 'win');
const VENDOR = join(ROOT, 'packaging', 'vendor', 'WinSW-x64.exe');
const ISS = join(ROOT, 'packaging', 'windows', 'solar-dashboard.iss');

/**
 * The installer's version — read from package.json, not written down here.
 *
 * Inno compares it against the installed copy to decide what an upgrade means, so it has
 * to move when a build goes out. It was a constant, and a constant that must be edited
 * every release is a constant that will not be: it sat at 0.9.0 while the product shipped
 * 0.1.4, which would have made Inno treat every real release as a downgrade of a version
 * that never existed.
 *
 * The release workflow already refuses to build when the tag disagrees with package.json,
 * so reading the same file makes the installer inherit that check rather than needing its
 * own.
 */
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
if (!VERSION) {
  console.error('package.json has no version — cannot stamp the installer.');
  process.exit(1);
}

/** winget installs Inno Setup per-user, so Program Files is not where it lands. */
const ISCC_CANDIDATES = [
  join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
  join(process.env.ProgramFiles ?? '', 'Inno Setup 6', 'ISCC.exe'),
  join(process.env['ProgramFiles(x86)'] ?? '', 'Inno Setup 6', 'ISCC.exe'),
];

function findIscc() {
  const found = ISCC_CANDIDATES.find((path) => path && existsSync(path));
  if (found) return found;
  console.error(
    'Inno Setup not found. Install it with:\n\n  winget install JRSoftware.InnoSetup\n\n' +
      `Looked in:\n${ISCC_CANDIDATES.map((p) => `  ${p}`).join('\n')}`,
  );
  process.exit(1);
}

if (!process.argv.includes('--skip-build')) {
  console.log('> building win-x64 payload');
  execSync('node packaging/build.mjs win', { cwd: ROOT, stdio: 'inherit' });
}

if (!existsSync(join(WIN, 'solar-dashboard.exe'))) {
  console.error(`No payload at ${WIN}. Run without --skip-build.`);
  process.exit(1);
}

// Stage WinSW under the name the service XML and the installer both expect. It is
// copied rather than built in place because build.mjs wipes packaging/out/win.
if (!existsSync(VENDOR)) {
  console.error(
    `WinSW not found at ${VENDOR}.\n\n` +
      'Download WinSW-x64.exe from https://github.com/winsw/winsw/releases and save it there.',
  );
  process.exit(1);
}
mkdirSync(join(WIN, 'service'), { recursive: true });
copyFileSync(VENDOR, join(WIN, 'service', 'SolarDashboardService.exe'));

const iscc = findIscc();
console.log(`> ${iscc} ${ISS}`);
execFileSync(iscc, [`/DAppVersion=${VERSION}`, ISS], { cwd: ROOT, stdio: 'inherit' });

const setup = join(OUT, 'SolarDashboardSetup.exe');
if (!existsSync(setup)) {
  console.error('Inno Setup reported success but produced no installer.');
  process.exit(1);
}
const mb = (readFileSync(setup).length / 1024 / 1024).toFixed(1);
console.log(`\ninstaller: ${setup} (${mb} MB, version ${VERSION})`);
