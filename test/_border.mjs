// Throwaway: reproduce the "border + side wall → right cell blacks out" bug.
// Straddle a vertical cell border with a wall directly ahead, look slightly to
// one side, and measure the black fraction of the RIGHT half of the screen.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8851, BASE = `http://localhost:${PORT}`;
function findChromium() {
  const base = '/opt/pw-browsers';
  for (const d of readdirSync(base).filter((x) => x.startsWith('chromium-') && !x.includes('headless')).sort().reverse()) {
    const p = join(base, d, 'chrome-linux', 'chrome');
    if (existsSync(p)) return p;
  }
}
const srv = spawn('node', ['scripts/serve.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) } });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch({ executablePath: findChromium() });
const page = await browser.newPage({ viewport: { width: 900, height: 500 } });
await page.addInitScript(() => {
  let s = 12345;
  Math.random = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
});
await page.goto(BASE);
await page.waitForFunction(() => window.__app && window.__app._frames > 2);

const res = await page.evaluate(() => {
  const a = window.__app;
  a.regenerate();                  // rebuild under the seeded RNG → deterministic
  a.startGame(); a.state = 'g';
  const w = a.maze.wall;
  // Reproduce the reported pose: straddle the j|j+1 border (a plane running
  // along Z), look DOWN that border (−Z) at a wall ahead, with the right-hand
  // cell (j+1) open. The side portal to that right cell lies in the plane you're
  // standing on. Need: A=(i,j) and B=(i,j+1) open, wall ahead of B at (i-1,j+1).
  let spot = null;
  for (let i = 2; i < a.maze.n - 1 && !spot; i++) {
    for (let j = 1; j < a.maze.m - 2; j++) {
      if (!w[i][j] && !w[i][j + 1] && w[i - 1][j + 1]) { spot = { i, j }; break; }
    }
  }
  if (!spot) return { spot: null };
  a.camZ = spot.i + 0.5;
  a.camX = spot.j + 1.0;          // exactly on the j|j+1 border (right cell = j+1)
  a.pitch = 0;
  a.yaw = 0 - 18;                 // look −Z (down the border), turned 18° left
  // render a couple frames
  return new Promise((resolve) => {
    let n = 0;
    const tick = () => {
      if (++n < 4) return requestAnimationFrame(tick);
      const c = document.getElementById('glcanvas');
      const o = document.createElement('canvas');
      o.width = c.width; o.height = c.height;
      const ctx = o.getContext('2d'); ctx.drawImage(c, 0, 0);
      const d = ctx.getImageData(0, 0, o.width, o.height).data;
      let blackRight = 0, totRight = 0;
      for (let y = 0; y < o.height; y++) {
        for (let x = Math.floor(o.width / 2); x < o.width; x++) {
          const p = (y * o.width + x) * 4;
          totRight++;
          if (d[p] + d[p + 1] + d[p + 2] < 12) blackRight++;
        }
      }
      resolve({ spot, blackRightFrac: blackRight / totRight });
    };
    requestAnimationFrame(tick);
  });
});
console.log(JSON.stringify(res));
await browser.close();
srv.kill();
