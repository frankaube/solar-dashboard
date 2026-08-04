#!/usr/bin/env node
/**
 * Regenerate the README screenshots.
 *
 *   pnpm --filter web dev            # or any server for the built app
 *   node scripts/screenshots.mjs     # → guide/images/*.png
 *
 * Drives headless Chrome over the DevTools protocol rather than a screenshot library,
 * because the two things needed here — setting localStorage before the app boots, and
 * resizing to the rendered height afterwards — are both a couple of CDP calls, against
 * roughly 200 MB of browser download for Playwright.
 *
 * Screenshots are taken in demo mode. The real array is asleep at night, and a hero
 * reading 0.0 kW is an honest but useless advertisement; the demo banner stays in frame
 * so the images say what they are.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const BASE = process.env.SHOT_BASE ?? 'http://localhost:5173';
const PORT = 9222;
const OUT = new URL('../guide/images/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const CHROME = process.env.CHROME_PATH ?? (
  process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : 'google-chrome'
);

const SHOTS = [
  { file: 'overview-dark.png', path: '/', theme: 'dark' },
  { file: 'overview-light.png', path: '/', theme: 'light' },
  { file: 'car-dark.png', path: '/car', theme: 'dark' },
  { file: 'trends-light.png', path: '/money/trends', theme: 'light' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rpc(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result);
      pending.delete(m.id);
    }
  });
  return (method, params = {}) =>
    new Promise((resolve) => {
      const i = ++id;
      pending.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
}

mkdirSync(OUT, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TEMP ?? '/tmp'}/solar-shots`,
  'about:blank',
], { stdio: 'ignore' });

try {
  // Wait for the debugging endpoint rather than sleeping a guessed interval.
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250);
    target = await fetch(`http://localhost:${PORT}/json/list`)
      .then((r) => r.json())
      .then((list) => list.find((t) => t.type === 'page'))
      .catch(() => null);
  }
  if (!target) throw new Error(`Chrome did not expose a debugging target on ${PORT}`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  const send = rpc(ws);
  await send('Page.enable');
  await send('Runtime.enable');

  for (const shot of SHOTS) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 2, mobile: false,
    });
    // Same origin first, so localStorage is writable before the app reads it.
    await send('Page.navigate', { url: `${BASE}/` });
    await sleep(1500);
    await send('Runtime.evaluate', {
      expression:
        `localStorage.setItem('solar.theme','${shot.theme}');` +
        `localStorage.setItem('solar-demo-mode','on');`,
    });
    await send('Page.navigate', { url: `${BASE}${shot.path}` });
    await sleep(6500); // first poll, then the chart's entry animation

    // Resize to the rendered height so a short page is not mostly empty canvas.
    const { result } = await send('Runtime.evaluate', {
      expression: 'Math.min(2400, Math.ceil(document.documentElement.scrollHeight))',
      returnByValue: true,
    });
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: Math.max(700, result.value), deviceScaleFactor: 2, mobile: false,
    });
    await sleep(1800);

    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(OUT + shot.file, Buffer.from(data, 'base64'));
    console.log(`  ${shot.file} (${shot.theme}, ${Math.max(700, result.value)}px)`);
  }
  ws.close();
} finally {
  chrome.kill();
}
