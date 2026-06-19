// Static maze geometry + the building blocks the section renderer draws.
//
// The maze walls are NOT ordinary geometry — every interior wall face is a
// mirror, drawn by the section pass (see sections.js). So scene.js builds the
// things drawn directly: the full preview floor, a single unit floor tile (one
// per section), the coloured start/end markers, the black finish box, the
// solution polyline, and the immediate-mode quad for a mirror wall placed at a
// section boundary in unfolded ("virtual") world space.

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

// A single unit floor tile at the origin cell [0,1]×[0,1]; the section renderer
// draws one per section, translated to the section's real cell then carried into
// place by that section's reflection matrix.
export function buildUnitFloor() {
  const out = [];
  pushQuad(out,
    v(0, 0, 0, 0, 1, 0, 0, 0),
    v(0, 0, 1, 0, 1, 0, 0, 1),
    v(1, 0, 1, 0, 1, 0, 1, 1),
    v(1, 0, 0, 0, 1, 0, 1, 0));
  return new Float32Array(out);
}

// A mirror wall quad on one side of virtual cell (vi,vj), in unfolded world
// space (no model transform — the quad already sits at its drawn position).
// `dir` is a {dj,di} step (see sections.js). Returns 4 verts for drawQuad.
export function wallQuad(vi, vj, dir) {
  const Q = (a, b, c, d, nx, ny, nz) => [
    [...a, nx, ny, nz, 0, 0], [...b, nx, ny, nz, 1, 0],
    [...c, nx, ny, nz, 1, 1], [...d, nx, ny, nz, 0, 1],
  ];
  if (dir.dj === 1) return Q([vj + 1, 0, vi], [vj + 1, 0, vi + 1], [vj + 1, 1, vi + 1], [vj + 1, 1, vi], 1, 0, 0);
  if (dir.dj === -1) return Q([vj, 0, vi + 1], [vj, 0, vi], [vj, 1, vi], [vj, 1, vi + 1], -1, 0, 0);
  if (dir.di === 1) return Q([vj, 0, vi + 1], [vj + 1, 0, vi + 1], [vj + 1, 1, vi + 1], [vj, 1, vi + 1], 0, 0, 1);
  return Q([vj + 1, 0, vi], [vj, 0, vi], [vj, 1, vi], [vj + 1, 1, vi], 0, 0, -1);
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

// Path polyline (cells → world-space strip points at low height).
export function buildPathLine(cells) {
  const out = [];
  for (const c of cells) {
    out.push(c.y + 0.5, 0.1, c.x + 0.5, 0, 1, 0, 0, 0);
  }
  return new Float32Array(out);
}
