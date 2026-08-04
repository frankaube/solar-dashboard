#!/usr/bin/env node
/**
 * Render the GitHub social preview card → guide/images/social-card.png (1280×640).
 *
 *   node scripts/social-card.mjs
 *
 * GitHub serves this when the repo is linked from Slack, Discord, Reddit, Hacker News or
 * anywhere else that unfurls a URL. Without one it serves a generic card built from the
 * avatar, which is the difference between a link people click and a link they scroll past.
 *
 * Upload it at Settings → General → Social preview. There is no API for that field.
 *
 * Designed to survive being shown small: unfurls are often rendered around 500 px wide, so
 * the headline is set large and everything else is subordinate to it. Reuses the app's own
 * screenshot rather than a mockup, because the card should promise what the repo delivers.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const OUT = `${ROOT}guide/images/`;
const PORT = 9223;
const CHROME = process.env.CHROME_PATH ?? (
  process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
  : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : 'google-chrome'
);

const shot = readFileSync(`${OUT}overview-dark.png`).toString('base64');

const HTML = `<!doctype html><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  html, body { width: 1280px; height: 640px; overflow: hidden; }
  body {
    background: #14120f;
    font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
    color: #f6f2ec;
    display: grid;
    grid-template-columns: 700px 1fr;
    align-items: center;
  }
  .left { padding: 0 0 0 68px; }
  .brand { display: flex; align-items: center; gap: 16px; margin-bottom: 38px; }
  .badge {
    width: 52px; height: 52px; border-radius: 15px; background: #e5a52f; color: #241a05;
    display: grid; place-items: center; font-weight: 700; font-size: 27px;
  }
  .name { font-size: 25px; font-weight: 600; letter-spacing: -0.01em; }
  h1 {
    font-family: Georgia, "Iowan Old Style", serif;
    font-size: 44px; line-height: 1.2; font-weight: 400; letter-spacing: -0.015em;
    margin-bottom: 32px; max-width: 600px;
  }
  h1 em { font-style: normal; color: #e5a52f; }
  .sub {
    font-family: ui-monospace, Consolas, monospace;
    font-size: 17.5px; line-height: 1.7; color: #a89e90;
  }
  .url {
    position: absolute; left: 68px; bottom: 46px;
    font-family: ui-monospace, Consolas, monospace; font-size: 16px; color: #6f6558;
  }
  /* The screenshot bleeds off the right edge and fades into the panel, so the card reads
     as one composition rather than a picture pasted beside some text. */
  .shot {
    position: relative; height: 640px; overflow: hidden;
  }
  .shot .frame {
    position: absolute; top: 58px; left: 16px; width: 1020px; height: 500px;
    overflow: hidden; border-radius: 14px 0 0 0;
    border: 1px solid #332e27; border-right: 0; border-bottom: 0;
  }
  /* Negative offsets skip the demo banner (top) and the nav rail (left): the card should
     show the dashboard, not the chrome around it. */
  .shot .frame img { position: absolute; top: -118px; left: -92px; width: 1180px; }
  .shot::after {
    content: ''; position: absolute; inset: 0;
    background: linear-gradient(90deg, #14120f 0%, rgba(20,18,15,.85) 6%, rgba(20,18,15,.15) 22%, rgba(20,18,15,0) 40%),
                linear-gradient(0deg, #14120f 2%, rgba(20,18,15,0) 26%);
  }
</style>
<div class="left">
  <div class="brand"><div class="badge">S</div><div class="name">Solar Dashboard</div></div>
  <h1>Would rather tell you nothing<br>than tell you <em>something false</em>.</h1>
  <div class="sub">Self-hosted solar, EV and home energy.<br>No account, no cloud, runs on a Pi.</div>
  <div class="url">github.com/frankaube/solar-dashboard</div>
</div>
<div class="shot"><div class="frame"><img src="data:image/png;base64,${shot}"></div></div>`;

mkdirSync(OUT, { recursive: true });
const page = `${ROOT}scripts/.social-card.html`;
writeFileSync(page, HTML);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TEMP ?? '/tmp'}/solar-card`,
  'about:blank',
], { stdio: 'ignore' });

try {
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(250);
    target = await fetch(`http://localhost:${PORT}/json/list`)
      .then((r) => r.json()).then((l) => l.find((t) => t.type === 'page')).catch(() => null);
  }
  if (!target) throw new Error('Chrome did not start');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  });
  const send = (method, params = {}) =>
    new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

  await send('Page.enable');
  // 2x, so it stays crisp where the card is shown at full size.
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 640, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: `file:///${page.replace(/\\/g, '/')}` });
  await sleep(2500);
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}social-card.png`, Buffer.from(data, 'base64'));
  console.log(`  guide/images/social-card.png (1280x640 @2x)`);
  ws.close();
} finally {
  chrome.kill();
}
