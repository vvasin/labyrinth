// Static maze geometry + the per-frame list of visible mirror walls.
//
// In the original the maze walls are NOT drawn as ordinary geometry — every
// interior wall face is a mirror, drawn by the reflection pass (see mirrors.js).
// So scene.js builds only the things DrawScene drew directly: the textured
// floor, the coloured start/end markers, and the black boundary box shown on
// the finish flash. It also reproduces the wall-visibility test that picks
// which mirror faces to reflect this frame, nearest first.

export const WALL_LEFT = 0, WALL_UP = 1, WALL_RIGHT = 2, WALL_DOWN = 3;

// One vertex = [x,y,z, nx,ny,nz, u,v].
function v(x, y, z, nx, ny, nz, u, uv) { return [x, y, z, nx, ny, nz, u, uv]; }

function pushQuad(out, a, b, c, d) {
  for (const vert of [a, b, c, a, c, d]) out.push(...vert);
}

export function buildFloor(maze) {
  const out = [];
  for (let i = 0; i < maze.n; i++) {
    for (let j = 0; j < maze.m; j++) {
      if (maze.wall[i][j]) continue;
      pushQuad(out,
        v(j, 0, i, 0, 1, 0, 0, 0),
        v(j, 0, i + 1, 0, 1, 0, 0, 1),
        v(j + 1, 0, i + 1, 0, 1, 0, 1, 1),
        v(j + 1, 0, i, 0, 1, 0, 1, 0));
    }
  }
  return new Float32Array(out);
}

// The start marker (x = 1 face) and the end marker (x = m-1 face).
export function buildStartWall() {
  const out = [];
  pushQuad(out,
    v(1, 0, 2, 1, 0, 0, 0, 0),
    v(1, 0, 1, 1, 0, 0, 1, 0),
    v(1, 1, 1, 1, 0, 0, 1, 1),
    v(1, 1, 2, 1, 0, 0, 0, 1));
  return new Float32Array(out);
}

export function buildEndWall(maze) {
  const n = maze.n, m = maze.m, out = [];
  pushQuad(out,
    v(m - 1, 0, n - 2, -1, 0, 0, 0, 0),
    v(m - 1, 0, n - 1, -1, 0, 0, 1, 0),
    v(m - 1, 1, n - 1, -1, 0, 0, 1, 1),
    v(m - 1, 1, n - 2, -1, 0, 0, 0, 1));
  return new Float32Array(out);
}

// Black ceiling + outer shell, drawn during the finish flash.
export function buildBoundary(maze) {
  const n = maze.n, m = maze.m, out = [];
  // ceiling
  pushQuad(out,
    v(0, 1, 0, 0, -1, 0, 0, 0), v(m, 1, 0, 0, -1, 0, 0, 0),
    v(m, 1, n, 0, -1, 0, 0, 0), v(0, 1, n, 0, -1, 0, 0, 0));
  return new Float32Array(out);
}

const DIST = (x, y) => Math.hypot(x, y);

// Grid line-of-sight: true if the straight segment from (x0,z0) to (x1,z1)
// crosses no solid cell strictly between its endpoints (an Amanatides–Woo
// traversal). The endpoint cells are not tested — the start is the viewer's own
// cell and the end is an open cell adjacent to the mirror face — so what's left
// is "is anything walling this face off from the viewer".
function lineOfSight(w, x0, z0, x1, z1) {
  let cx = Math.floor(x0), cz = Math.floor(z0);
  const ex = Math.floor(x1), ez = Math.floor(z1);
  const dx = x1 - x0, dz = z1 - z0;
  const sx = Math.sign(dx), sz = Math.sign(dz);
  const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tmx = dx !== 0 ? (sx > 0 ? cx + 1 - x0 : x0 - cx) * tdx : Infinity;
  let tmz = dz !== 0 ? (sz > 0 ? cz + 1 - z0 : z0 - cz) * tdz : Infinity;
  // Guard against pathological inputs (a virtual camera that lands far outside
  // the grid) by bounding the steps to the worst-case Manhattan span.
  let guard = Math.abs(ex - cx) + Math.abs(ez - cz) + 1;
  while ((cx !== ex || cz !== ez) && guard-- > 0) {
    if (tmx < tmz) { cx += sx; tmx += tdx; } else { cz += sz; tmz += tdz; }
    if (cx === ex && cz === ez) break;
    if (w[cz] && w[cz][cx]) return false;
  }
  return true;
}

// Camera-facing mirror faces within optical range, sorted nearest-first.
//
// Each wall carries `los` — whether it has clear line of sight from the
// viewpoint. The mirror recursion draws every wall here as a surface (so the
// floor never shows through a missing wall) but only spends reflection budget
// on the `los` ones, since a mirror you can't see isn't worth recursing into.
//
// This is called for the real camera AND for the reflected "virtual" cameras of
// each recursion level. Because a virtual camera is just the real eye reflected
// through the mirror chain (reflections are distance-preserving), a wall's
// distance from it equals the true folded optical path from the eye — so the
// same fog range bounds every level, and deep reflections naturally see less.
// The scan is clamped to a window around the viewpoint so its cost is O(range²),
// independent of maze size (and empty once the virtual camera drifts off-grid).
//
// `losX,losZ` is where the occlusion ray starts. For the real camera it's the
// camera itself; for a reflected level it's the PORTAL (the mirror we're looking
// through), because the virtual camera sits behind that mirror — testing line of
// sight from there would let the portal wall occlude the whole tunnel beyond it.
export function visibleWallsFrom(maze, camX, camZ, range, losX = camX, losZ = camZ) {
  const n = maze.n, m = maze.m, w = maze.wall, walls = [];
  const add = (i, j, dir, dist, tx, tz) =>
    walls.push({ i, j, dir, dist, los: lineOfSight(w, losX, losZ, tx, tz) });

  const i0 = Math.max(0, Math.floor(camZ - range - 1));
  const i1 = Math.min(n - 1, Math.ceil(camZ + range + 1));
  const j0 = Math.max(0, Math.floor(camX - range - 1));
  const j1 = Math.min(m - 1, Math.ceil(camX + range + 1));
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      if (!(DIST(camX - j - 0.5, camZ - i - 0.5) < range + 1 && w[i][j])) continue;
      // The facing test is a half-space: the viewpoint must be on the wall's
      // OPEN side (the side its mirror face shows). The bounds are exact (not
      // slack by a cell) because the recursion's virtual cameras can sit inside
      // wall cells — a loose test would there pick a wall's hidden back face and
      // waste reflection budget on it instead of the wall you actually see.
      if (j > 0 && !w[i][j - 1] && camX < j)
        add(i, j, WALL_LEFT, DIST(camX - j, camZ - i - 0.5), j - 0.5, i + 0.5);
      if (j < m - 1 && !w[i][j + 1] && camX > j + 1)
        add(i, j, WALL_RIGHT, DIST(camX - j - 1, camZ - i - 0.5), j + 1.5, i + 0.5);
      if (i > 0 && !w[i - 1][j] && camZ < i)
        add(i, j, WALL_UP, DIST(camX - j - 0.5, camZ - i), j + 0.5, i - 0.5);
      if (i < n - 1 && !w[i + 1][j] && camZ > i + 1)
        add(i, j, WALL_DOWN, DIST(camX - j - 0.5, camZ - i - 1), j + 0.5, i + 1.5);
    }
  }
  walls.sort((a, b) => a.dist - b.dist);
  return walls;
}

// Path polyline (cells → world-space strip points at low height).
export function buildPathLine(cells) {
  const out = [];
  for (const c of cells) {
    out.push(c.y + 0.5, 0.1, c.x + 0.5, 0, 1, 0, 0, 0);
  }
  return new Float32Array(out);
}
