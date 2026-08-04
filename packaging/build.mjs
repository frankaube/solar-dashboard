// Lite-build packager: produces self-contained folders for win-x64, linux-x64,
// and linux-arm64 (Raspberry Pi 4/5, 64-bit OS). Run from the repo root:
//   node packaging/build.mjs [win|linux|arm64|all]
import { execSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const API = join(ROOT, 'apps', 'api');
const OUT = join(ROOT, 'packaging', 'out');

const TARGETS = {
  win: { pkg: 'node22-win-x64', exe: 'solar-dashboard.exe', engine: 'query_engine-windows.dll.node' },
  linux: { pkg: 'node22-linux-x64', exe: 'solar-dashboard', engine: 'libquery_engine-debian-openssl-3.0.x.so.node' },
  // Cross-arch builds can't generate V8 bytecode on this machine — ship plain JS.
  arm64: {
    pkg: 'node22-linux-arm64',
    exe: 'solar-dashboard',
    engine: 'libquery_engine-linux-arm64-openssl-3.0.x.so.node',
    flags: '--no-bytecode --public --public-packages "*"',
  },
};

const wanted = process.argv[2] ?? 'all';
const selected = wanted === 'all' ? Object.keys(TARGETS) : [wanted];
for (const name of selected) {
  if (!TARGETS[name]) {
    console.error(`unknown target ${name}; use win|linux|arm64|all`);
    process.exit(1);
  }
}

const run = (cmd, cwd = ROOT) => {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
};

// 1. Build everything once.
run('pnpm --dir apps/api exec prisma generate');
run('pnpm --dir apps/api build');
run('pnpm --dir apps/web build');

// 1b. Pre-bundle to a single CJS file: resolves Prisma's #subpath imports at
// build time (pkg's snapshot resolver can't) and removes runtime node_modules
// resolution entirely. Externals are Nest/pg/ws optionals that are never loaded
// (Nest guards them in try/catch).
const EXTERNALS = [
  '@nestjs/microservices',
  '@nestjs/microservices/microservices-module',
  '@nestjs/websockets',
  '@nestjs/websockets/socket-module',
  '@nestjs/platform-socket.io',
  'class-validator',
  'class-transformer',
  '@fastify/static',
  '@fastify/view',
  'pg-native',
  'bufferutil',
  'utf-8-validate',
]
  .map((name) => `--external:${name}`)
  .join(' ');
run(
  `pnpm --dir apps/api exec esbuild dist/main.js --bundle --platform=node --target=node22 --format=cjs --outfile=dist/bundle.cjs ${EXTERNALS}`,
);

// Locate the generated Prisma engines (all binaryTargets land beside the client).
const prismaClientDir = (() => {
  const pnpmDir = join(ROOT, 'node_modules', '.pnpm');
  const entry = readdirSync(pnpmDir).find((name) => name.startsWith('@prisma+client@'));
  return join(pnpmDir, entry, 'node_modules', '.prisma', 'client');
})();

for (const name of selected) {
  const target = TARGETS[name];
  const dist = join(OUT, name);
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });

  // 2. Single executable (JS bundled; native engine ships alongside).
  run(
    `pnpm --dir apps/api exec pkg dist/bundle.cjs --target ${target.pkg} ${target.flags ?? ''} --output ${JSON.stringify(join(dist, target.exe))}`,
  );

  // 3. External resources next to the executable.
  cpSync(join(ROOT, 'apps', 'web', 'dist'), join(dist, 'public'), { recursive: true });
  cpSync(join(API, 'src', 'hoymiles', 'protos'), join(dist, 'protos'), { recursive: true });
  cpSync(join(API, 'prisma', 'migrations'), join(dist, 'migrations'), { recursive: true });
  mkdirSync(join(dist, 'engine'), { recursive: true });
  const enginePath = join(prismaClientDir, target.engine);
  if (!existsSync(enginePath)) {
    console.error(`missing engine ${target.engine} — check schema binaryTargets`);
    process.exit(1);
  }
  cpSync(enginePath, join(dist, 'engine', target.engine));

  // 4a. Stamp which build this is.
  //
  // Without it the app reported a hardcoded version forever, so a deploy could not be
  // verified — see apps/api/src/common/build-info.ts. The commit is the useful half: a
  // version number moves once a release, a SHA moves every time the code does.
  let commit = null;
  try {
    commit = execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim();
  } catch {
    // Built outside a checkout. Recorded as null rather than guessed.
  }
  writeFileSync(
    join(dist, "version.json"),
    JSON.stringify(
      {
        // The root package.json carries no version (it is a workspace root); the API one
        // does. Falling back to "0.0.0" here looked like a broken build rather than a
        // missing field, which is the wrong kind of wrong.
        version:
          JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version ??
          JSON.parse(readFileSync(join(API, "package.json"), "utf8")).version ??
          "0.0.0",
        commit,
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  // 4. Service assets + docs.
  if (name === 'win') {
    cpSync(join(ROOT, 'packaging', 'windows'), join(dist, 'service'), { recursive: true });
  } else {
    // The updater's own test suite lives under packaging/linux/test and is not part of the
    // product. Without this filter it ships in every bundle and is then installed to
    // /opt/solar-dashboard/service by the very script it tests.
    cpSync(join(ROOT, 'packaging', 'linux'), join(dist, 'service'), {
      recursive: true,
      filter: (src) => !src.replace(/\\/g, '/').includes('/packaging/linux/test'),
    });
  }
  /*
    Make the shipped scripts executable, rather than inheriting whatever mode the checkout
    happened to have.

    systemd runs ExecStart=/opt/solar-dashboard/service/update.sh directly, so the bit has
    to be real. Git stored these as 100644 for a long time — a Windows checkout hides that,
    because MSYS reports every file as 755 — so a release built on Linux shipped an
    update.sh that could not be executed, and automatic updates broke permanently the first
    time a machine updated itself. Silently, as a unit failure nobody reads.

    The modes are fixed in git now; this is the belt to that pair of braces.
  */
  if (name !== 'win') {
    for (const script of readdirSync(join(dist, 'service')).filter((f) => f.endsWith('.sh'))) {
      chmodSync(join(dist, 'service', script), 0o755);
    }
  }

  const exeName = name === 'win' ? 'solar-dashboard.exe' : './solar-dashboard';
  writeFileSync(
    join(dist, 'README.txt'),
    [
      'SOLAR DASHBOARD',
      '===============',
      '',
      'A local dashboard for home solar, EV charging and smart plugs. Everything runs',
      'on your own machine - no account, no cloud, nothing leaves your network.',
      '',
      '',
      'GETTING STARTED',
      '---------------',
      `  1. Run ${exeName}`,
      ...(name === 'win'
        ? [
            '     (Windows may warn about an unknown publisher - the app is not code-signed.',
            '      Click "More info" then "Run anyway".)',
          ]
        : []),
      '  2. Open http://localhost:3001 in a browser',
      '  3. Follow the welcome screen - it scans your network and sets itself up',
      '',
      'Leave the window open while it runs. To have it start automatically and keep',
      'collecting after a reboot, see the service/ folder.',
      '',
      '',
      'FROM YOUR PHONE OR ANOTHER COMPUTER',
      '-----------------------------------',
      '  http://solar-dashboard.local:3001',
      '',
      '  The app announces that name on your network, so it is the same address on',
      '  every machine - no IP to look up. Works on iPhone, Mac, Android 13+ and',
      '  Windows. Your firewall has to allow TCP 3001 and UDP 5353 inbound; the',
      '  installer offers to add both, and the portable build will prompt on first run.',
      '',
      '  If the name does not resolve, the IP address always works. Set MDNS_HOSTNAME',
      '  to use something other than "solar-dashboard", or MDNS_DISABLE=1 to turn the',
      '  announcements off entirely.',
      '',
      '',
      'WHAT IT FINDS ON YOUR NETWORK',
      '-----------------------------',
      '  Solar          Hoymiles DTU, Fronius, OpenDTU / AhoyDTU',
      '  EV charging    Tesla Wall Connector',
      '  Smart devices  Kasa (TP-Link), Shelly, Tasmota, HomeKit (e.g. Mysa)',
      '  Battery        EcoFlow - added in Settings with your own API keys, not scanned',
      '',
      'The scan is one gentle pass over your local subnet. It only looks; it never',
      'changes anything on the devices it finds.',
      '',
      '',
      'WHAT YOU GET',
      '------------',
      '  With a supported solar system:',
      '    Everything - live production, per-panel roof view, savings in real dollars,',
      '    underperforming-panel alerts, history and trends.',
      '',
      '  With no solar, but smart plugs:',
      '    The Devices page works fully - per-device power, on-time, running costs and',
      '    standby-draw detection. The solar-centric pages will be empty.',
      '',
      '  Just curious?',
      '    Click "Explore demo" on the welcome screen for a fully populated dashboard',
      '    (about two years of generated data, including a home battery). Nothing is',
      '    scanned and no real data is touched.',
      '',
      '',
      'NOT INCLUDED IN THIS BUILD',
      '--------------------------',
      '  Vehicle logging (battery %, drives, range) needs TeslaMate, which only runs in',
      '  the Docker version. A Tesla Wall Connector still reports charging power and',
      '  energy here - it is the car-side detail that is missing.',
      '',
      '',
      'YOUR DATA',
      '---------',
      '  Stored in ./data/solar.db next to the program. Move or back up the whole',
      '  folder and everything comes with it. Set SOLAR_DATA_DIR to put it elsewhere.',
      '',
      '',
      'OPTIONAL SETTINGS (environment variables)',
      '-----------------------------------------',
      '  PORT                 web port (default 3001)',
      '  SOLAR_DATA_DIR       where the database lives',
      '  MDNS_HOSTNAME        network name (default "solar-dashboard")',
      '  MDNS_DISABLE         set to 1 to stop announcing a name at all',
      '  DTU_HOST             solar gateway address, if you would rather not scan',
      '  CHARGER_HOST         Tesla Wall Connector address',
      '  POLL_INTERVAL_MS     how often to read the gateway',
      '  NOTIFY_WEBHOOK_URL   push notifications (ntfy)',
      '  API_TOKEN            require a token for any change-making request',
    ].join('\n'),
  );
  console.log(`\npackaged: ${dist}`);
}
