// Section-based mirror-maze renderer — replaces the recursive stencil pass.
//
// The visible world is an "unfolding" of the maze across its mirror walls.
// Starting from the cell the camera stands in, we flood-fill outward over a grid
// of SECTIONS placed in unfolded ("virtual") world space:
//
//   • crossing an OPEN passage steps to the real neighbouring cell — a real
//     piece of the maze, same orientation;
//   • crossing a WALL steps to a section that is the REFLECTION of the cell in
//     front of it — same real cell, one more planar reflection in its matrix.
//
// Each section carries a `model` matrix (a composition of axis-aligned
// reflections) mapping real-maze coordinates to its place in the unfolded world,
// plus the real cell it draws and whether the player's body rides on it.
//
// Because sections are keyed by their virtual cell, the whole structure is just
// a disk of cells of radius = view distance — bounded by area, never the
// exponential `walls^depth` of the old recursion. Two different mirrors that
// reach the same virtual cell produce the same reflection, so we draw it once.
//
// We compute every section (bounded by the view DISTANCE in section units and
// the forward view angle), then hand back the section list and a deduped wall
// list, each sorted FAR → NEAR so the painter draws back-to-front and the
// semi-transparent mirror glass composites correctly.

import * as M from './mat4.js';

// World-space reflection about an axis-aligned plane (x = c, or z = c).
function reflectX(c) { const m = M.identity(); m[0] = -1; m[12] = 2 * c; return m; }
function reflectZ(c) { const m = M.identity(); m[10] = -1; m[14] = 2 * c; return m; }

// The four grid directions as (dj, di) world steps. j = column = X, i = row = Z.
const DIRS = [
  { dj: 1, di: 0 },   // +X
  { dj: -1, di: 0 },  // -X
  { dj: 0, di: 1 },   // +Z
  { dj: 0, di: -1 },  // -Z
];

const vkey = (vi, vj) => vi * 100000 + vj;

// Canonical key for the undirected boundary a section side sits on, so one
// physical mirror discovered from either adjoining cell dedupes to a single wall.
function edgeKey(vi, vj, dir) {
  if (dir.dj === 1) return `v:${vi}:${vj + 1}`;
  if (dir.dj === -1) return `v:${vi}:${vj}`;
  if (dir.di === 1) return `h:${vi + 1}:${vj}`;
  return `h:${vi}:${vj}`;
}

// Keep near cells regardless of facing (so the view edge never pops), otherwise
// require a corner of the cell to fall inside the forward cone.
function inView(vi, vj, camX, camZ, fwd, cosHalf) {
  const cx = vj + 0.5 - camX, cz = vi + 0.5 - camZ;
  if (cx * cx + cz * cz < 2.25) return true; // within ~1.5 cells
  for (let a = 0; a <= 1; a++) {
    for (let b = 0; b <= 1; b++) {
      const x = vj + a - camX, z = vi + b - camZ;
      const len = Math.hypot(x, z) || 1;
      if ((x * fwd[0] + z * fwd[1]) / len >= cosHalf) return true;
    }
  }
  return false;
}

// Compute the draw lists. Params: { maze, camX, camZ, yaw, viewDist, fovy, aspect }.
// Returns { sections, walls }, each sorted far → near.
export function computeSections(p) {
  const { maze, camX, camZ, yaw, viewDist, fovy, aspect } = p;
  const wall = maze.wall;
  const ci = Math.floor(camZ), cj = Math.floor(camX);

  const ya = (yaw * Math.PI) / 180;
  const fwd = [Math.sin(ya), -Math.cos(ya)]; // forward in world (x, z)
  const halfH = Math.atan(Math.tan((fovy * Math.PI) / 360) * aspect) + (35 * Math.PI) / 180;
  const cosHalf = Math.cos(Math.min(halfH, Math.PI * 0.95));
  const maxDist = viewDist + 0.5;
  const CAP = 4000; // safety bound; the view disk is far smaller in practice

  // sx/sz are the orientation signs: world +X maps to real dir sx, +Z to sz.
  const start = {
    vi: ci, vj: cj, ri: ci, rj: cj, sx: 1, sz: 1,
    model: M.identity(), hasBody: true, dist: 0,
  };
  const visited = new Map([[vkey(ci, cj), start]]);
  const sections = [start];

  for (let head = 0; head < sections.length && sections.length < CAP; head++) {
    const s = sections[head];
    for (const dir of DIRS) {
      const nvi = s.vi + dir.di, nvj = s.vj + dir.dj;
      const k = vkey(nvi, nvj);
      if (visited.has(k)) continue;

      const dist = Math.hypot(nvj + 0.5 - camX, nvi + 0.5 - camZ);
      if (dist > maxDist) continue;
      if (!inView(nvi, nvj, camX, camZ, fwd, cosHalf)) continue;

      // The real cell on this side: world step → real step via the orientation.
      const nri = s.ri + dir.di * s.sz;
      const nrj = s.rj + dir.dj * s.sx;
      const cell = wall[nri] ? wall[nri][nrj] : undefined;
      const isMirror = cell !== 0; // a wall, or out of bounds → mirror

      let child;
      if (isMirror) {
        // Reflection of the cell in front: same real cell, flipped one axis.
        let model, sx = s.sx, sz = s.sz;
        if (dir.dj === 1) { model = M.multiply(reflectX(s.vj + 1), s.model); sx = -sx; }
        else if (dir.dj === -1) { model = M.multiply(reflectX(s.vj), s.model); sx = -sx; }
        else if (dir.di === 1) { model = M.multiply(reflectZ(s.vi + 1), s.model); sz = -sz; }
        else { model = M.multiply(reflectZ(s.vi), s.model); sz = -sz; }
        child = { vi: nvi, vj: nvj, ri: s.ri, rj: s.rj, sx, sz, model, hasBody: s.hasBody, dist };
      } else {
        // Real neighbouring cell, same orientation; the body does not ride along.
        child = { vi: nvi, vj: nvj, ri: nri, rj: nrj, sx: s.sx, sz: s.sz, model: s.model, hasBody: false, dist };
      }
      visited.set(k, child);
      sections.push(child);
    }
  }

  // One wall per mirror boundary, deduped; semi-transparent if a section sits
  // behind it (a reflection shows through the glass), otherwise solid.
  const wallMap = new Map();
  for (const s of sections) {
    for (const dir of DIRS) {
      const nri = s.ri + dir.di * s.sz, nrj = s.rj + dir.dj * s.sx;
      const cell = wall[nri] ? wall[nri][nrj] : undefined;
      if (cell === 0) continue; // open passage: no wall here
      const ek = edgeKey(s.vi, s.vj, dir);
      if (wallMap.has(ek)) continue;
      const nvi = s.vi + dir.di, nvj = s.vj + dir.dj;
      let mx, mz;
      if (dir.dj === 1) { mx = s.vj + 1; mz = s.vi + 0.5; }
      else if (dir.dj === -1) { mx = s.vj; mz = s.vi + 0.5; }
      else if (dir.di === 1) { mx = s.vj + 0.5; mz = s.vi + 1; }
      else { mx = s.vj + 0.5; mz = s.vi; }
      wallMap.set(ek, {
        vi: s.vi, vj: s.vj, dir,
        transparent: visited.has(vkey(nvi, nvj)),
        dist: Math.hypot(mx - camX, mz - camZ),
      });
    }
  }

  sections.sort((a, b) => b.dist - a.dist);
  const walls = [...wallMap.values()].sort((a, b) => b.dist - a.dist);
  return { sections, walls };
}
