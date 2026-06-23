// End-to-end smoke test — boots the app in a real browser and checks the
// section renderer actually draws, in every state, without GL or JS errors.
//
// There is no test framework; this is a standalone script. It starts the dev
// server, drives the app through `window.__app`, asserts WebGL is live
// (glGetError stays clean) and that real pixels land on the canvas, then exits
// non-zero if anything failed.
//
//   npm run test:e2e
//
// Browser: on a local machine, install Chromium once with `npx playwright
// install chromium`. In the sandboxed/remote environment the Playwright CDN is
// blocked, BUT a Chromium build ships pre-installed under /opt/pw-browsers — so
// when you are NOT on the user's local machine, use that browser (this script
// auto-detects it; you can also point PLAYWRIGHT_CHROMIUM at any chrome binary).

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8793;
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.SHOTS || ''; // optional dir to dump screenshots into

// --- pick a browser ---------------------------------------------------------
// Prefer an explicit override, then a sandbox-preinstalled Chromium, then fall
// back to Playwright's own managed download (local machines).
function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM;
  const base = '/opt/pw-browsers';
  if (existsSync(base)) {
    const dirs = readdirSync(base)
      .filter((d) => d.startsWith('chromium-') && !d.includes('headless'))
      .sort();
    for (const d of dirs.reverse()) {
      const p = join(base, d, 'chrome-linux', 'chrome');
      if (existsSync(p)) return p;
    }
  }
  return null; // let Playwright use its managed browser
}

// --- tiny assertion harness -------------------------------------------------
const failures = [];
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures.push(name);
}

// Read back the GL canvas (preserveDrawingBuffer is on) and summarise it.
const PIXELS = () => {
  const c = document.getElementById('glcanvas');
  const o = document.createElement('canvas');
  o.width = c.width; o.height = c.height;
  o.getContext('2d').drawImage(c, 0, 0);
  const d = o.getContext('2d').getImageData(0, 0, o.width, o.height).data;
  let nonblack = 0, sum = 0, sum2 = 0; const n = o.width * o.height;
  const colors = new Set();
  for (let i = 0; i < d.length; i += 4) {
    const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
    if (l > 12) nonblack++;
    sum += l; sum2 += l * l;
    colors.add(((d[i] >> 5) << 10) | ((d[i + 1] >> 5) << 5) | (d[i + 2] >> 5));
  }
  const mean = sum / n;
  return { nonblackFrac: nonblack / n, std: Math.sqrt(sum2 / n - mean * mean), colors: colors.size };
};

async function main() {
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });

  // start the dev server
  const server = spawn('node', ['scripts/serve.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore',
  });
  const stop = () => { try { server.kill(); } catch { /* ignore */ } };

  try {
    // wait for it to answer
    for (let i = 0; ; i++) {
      try { if ((await fetch(`${BASE}/index.html`)).ok) break; } catch { /* not up yet */ }
      if (i > 50) throw new Error('dev server did not start');
      await new Promise((r) => setTimeout(r, 100));
    }

    const exe = findChromium();
    console.log(`browser: ${exe || 'playwright-managed'}`);
    const browser = await chromium.launch({
      ...(exe ? { executablePath: exe } : {}),
      args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    });
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
    const jsErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') jsErrors.push(m.text()); });
    page.on('pageerror', (e) => jsErrors.push('pageerror: ' + e.message));

    await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__app && window.__app._frames > 3, { timeout: 15000 });

    // real WebGL context?
    const gl = await page.evaluate(() => {
      const g = window.__app.r.gl;
      return { version: g.getParameter(g.VERSION), err: g.getError() };
    });
    check('WebGL context is live', /WebGL/.test(gl.version || ''), gl.version);

    const settle = () => page.evaluate(() => new Promise((res) =>
      requestAnimationFrame(() => requestAnimationFrame(res))));
    const glErr = () => page.evaluate(() => window.__app.r.gl.getError());

    // 1) the generated state draws the whole maze as a readable top-down map
    await page.evaluate(() => window.__app.newGame(8));
    await settle();
    const prev = await page.evaluate(PIXELS);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'generated.png') });
    check('generated map renders the maze', prev.nonblackFrac > 0.5 && prev.colors >= 8,
      `nonblack=${prev.nonblackFrac.toFixed(2)} colors=${prev.colors}`);

    // 2) first person at the entrance
    await page.evaluate(() => {
      const a = window.__app;
      a.startGame(); a.animT = 1; // skip the fog-in
      a.camX = 1.5; a.camZ = 1.5; a.camY = 0.5; a.yaw = 90; a.pitch = 0;
      a.setViewDist(4);
    });
    await settle();
    const ent = await page.evaluate(PIXELS);
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'entrance.png') });
    check('gameplay renders content', ent.nonblackFrac > 0.2 && ent.std > 2,
      `nonblack=${ent.nonblackFrac.toFixed(2)} std=${ent.std.toFixed(1)}`);
    check('no GL error after gameplay frame', (await glErr()) === 0);

    // 3) mid-maze, sweeping view distance — every depth must stay error-free
    await page.evaluate(() => {
      const a = window.__app, p = a.maze.solutionPath();
      const c = p[Math.min(5, p.length - 1)];
      a.camX = c.y + 0.5; a.camZ = c.x + 0.5; a.yaw = 0; a.pitch = 0;
    });
    let sweepOk = true, mid = null;
    for (const vd of [4, 8, 16]) {
      await page.evaluate((v) => window.__app.setViewDist(v), vd);
      await settle();
      mid = await page.evaluate(PIXELS);
      if ((await glErr()) !== 0 || mid.nonblackFrac < 0.2) sweepOk = false;
    }
    if (SHOTS) await page.screenshot({ path: join(SHOTS, 'mid.png') });
    check('view-distance sweep (4,8,16) stays clean', sweepOk,
      `last nonblack=${mid.nonblackFrac.toFixed(2)}`);

    // 4) every state + lifecycle transition keeps the GL error register clean.
    // Reveal a hint mid-play too, so the flowing path ribbon is exercised.
    const states = {};
    for (const [name, fn] of [
      ['initial', () => window.__app.toInitial()],
      ['generated', () => window.__app.newGame(12)],
      ['started', () => { const a = window.__app; a.startGame(); a.animT = 1; }],
      ['reveal', () => { const a = window.__app; const h = a.hints[0]; if (h) { a.camX = h.j + 0.5; a.camZ = h.i + 0.5; a._parseMove(); } }],
      ['surrendered', () => window.__app.surrender()],
      ['finished', () => { const a = window.__app; a.newGame(8); a.startGame(); a._finish(); }],
    ]) {
      await page.evaluate(fn);
      await settle();
      states[name] = await glErr();
    }
    check('all states/transitions GL-clean', Object.values(states).every((e) => e === 0),
      JSON.stringify(states));

    check('no JS/console errors', jsErrors.length === 0, jsErrors.join(' | '));

    await browser.close();
  } finally {
    stop();
  }

  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nall checks passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
