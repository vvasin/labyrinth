// Procedural textures, generated at runtime onto power-of-two canvases. This
// replaces the old hand-painted BMPs: the look is crisp at any resolution, ships
// no binary assets, and is tuned to the renderer's gamma/tonemap pipeline (see
// shaders.js) for a clean, modern sci-fi labyrinth.
//
// Each builder returns a <canvas>; Renderer.textureFromCanvas uploads it with
// mipmaps + REPEAT wrap. All sizes are powers of two. Textures are authored in
// the same space the shader treats as linear and then gamma-encodes, so colours
// here are kept a touch dark/saturated to read right after that lift.

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

// Per-pixel monochrome noise overlay, kept subtle — enough to kill the "flat
// plastic" look without reading as grain.
function addNoise(ctx, size, amp) {
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() * 2 - 1) * amp;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

// Floor: a dark polished tech panel. Each texture tile maps to one maze cell, so
// the panel seams glow along the cell grid and a finer inner grid subdivides it.
export function floorTexture() {
  const S = 512, c = makeCanvas(S), x = c.getContext('2d');

  const g = x.createLinearGradient(0, 0, S, S);
  g.addColorStop(0.0, '#12151e');
  g.addColorStop(0.5, '#0c0f16');
  g.addColorStop(1.0, '#090b11');
  x.fillStyle = g;
  x.fillRect(0, 0, S, S);
  addNoise(x, S, 9);

  // Fine inner grid.
  x.strokeStyle = 'rgba(120, 170, 200, 0.05)';
  x.lineWidth = 1;
  for (let i = 1; i < 8; i++) {
    const p = (i * S) / 8;
    x.beginPath(); x.moveTo(p, 0); x.lineTo(p, S); x.stroke();
    x.beginPath(); x.moveTo(0, p); x.lineTo(S, p); x.stroke();
  }

  // Glowing panel seam around the cell edge (drawn inset so the REPEAT wrap puts
  // a crisp double-line groove on every cell boundary).
  x.save();
  x.shadowColor = 'rgba(80, 200, 235, 0.8)';
  x.shadowBlur = 10;
  x.strokeStyle = 'rgba(110, 215, 245, 0.5)';
  x.lineWidth = 3;
  const m = 10;
  x.strokeRect(m, m, S - 2 * m, S - 2 * m);
  x.restore();

  // Corner rivets.
  x.fillStyle = 'rgba(150, 210, 235, 0.35)';
  for (const cx of [m + 8, S - m - 8]) {
    for (const cy of [m + 8, S - m - 8]) {
      x.beginPath(); x.arc(cx, cy, 3, 0, Math.PI * 2); x.fill();
    }
  }
  return c;
}

// Mirror glass: drawn at low alpha over the reflection, so it mostly tints. A
// faint diagonal streak field + a dark bevel frame give it a real glassy edge.
export function mirrorTexture() {
  const S = 256, c = makeCanvas(S), x = c.getContext('2d');

  x.fillStyle = '#aeb6c2';
  x.fillRect(0, 0, S, S);

  // Soft diagonal smudges/streaks.
  for (let i = 0; i < 48; i++) {
    x.strokeStyle = `rgba(255, 255, 255, ${Math.random() * 0.05})`;
    x.lineWidth = Math.random() * 3 + 0.5;
    const o = Math.random() * S * 1.4 - S * 0.2;
    x.beginPath(); x.moveTo(o, 0); x.lineTo(o + S * 0.35, S); x.stroke();
  }

  // Cool sheen sweeping across.
  const g = x.createLinearGradient(0, 0, S, S);
  g.addColorStop(0.0, 'rgba(150, 200, 230, 0.10)');
  g.addColorStop(0.5, 'rgba(255, 255, 255, 0.0)');
  g.addColorStop(1.0, 'rgba(120, 150, 190, 0.10)');
  x.fillStyle = g;
  x.fillRect(0, 0, S, S);

  // Dark bevel frame at the cell edge.
  x.strokeStyle = 'rgba(35, 45, 60, 0.55)';
  x.lineWidth = 12;
  x.strokeRect(0, 0, S, S);
  return c;
}

// Start / exit marker: a glowing emblem (ring + symbol) on a dark plate. The
// shader rides emission with the texture, so the plate stays dark while the ring
// blooms. `symbol` is 'dot' (start) or 'chevron' (exit, an up arrow).
function markerTexture(r, gb, symbol) {
  const S = 256, c = makeCanvas(S), x = c.getContext('2d');
  const rgb = `${r}, ${gb[0]}, ${gb[1]}`;
  const cx = S / 2, cy = S / 2;

  // Dark tinted plate.
  x.fillStyle = `rgb(${Math.round(r * 0.12)}, ${Math.round(gb[0] * 0.12)}, ${Math.round(gb[1] * 0.12)})`;
  x.fillRect(0, 0, S, S);

  // Radial bloom.
  const g = x.createRadialGradient(cx, cy, 2, cx, cy, S * 0.5);
  g.addColorStop(0.0, `rgba(${rgb}, 0.95)`);
  g.addColorStop(0.35, `rgba(${rgb}, 0.35)`);
  g.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
  x.fillStyle = g;
  x.fillRect(0, 0, S, S);

  // Glowing ring.
  x.save();
  x.shadowColor = `rgba(${rgb}, 0.9)`;
  x.shadowBlur = 22;
  x.strokeStyle = `rgba(${rgb}, 0.95)`;
  x.lineWidth = 9;
  x.beginPath();
  x.arc(cx, cy, S * 0.3, 0, Math.PI * 2);
  x.stroke();

  // Symbol.
  x.lineWidth = 12;
  x.lineCap = 'round';
  x.lineJoin = 'round';
  if (symbol === 'chevron') {
    const w = S * 0.13;
    x.beginPath();
    x.moveTo(cx - w, cy + w * 0.6);
    x.lineTo(cx, cy - w * 0.7);
    x.lineTo(cx + w, cy + w * 0.6);
    x.stroke();
  } else {
    x.fillStyle = `rgba(${rgb}, 0.95)`;
    x.beginPath();
    x.arc(cx, cy, S * 0.08, 0, Math.PI * 2);
    x.fill();
  }
  x.restore();
  return c;
}

export function startTexture() { return markerTexture(235, [70, 80], 'dot'); }
export function endTexture() { return markerTexture(70, [235, 130], 'chevron'); }
