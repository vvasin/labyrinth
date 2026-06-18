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

// Camera-facing mirror faces within fog range, sorted nearest-first.
export function visibleWalls(maze, camX, camZ, fe) {
  const n = maze.n, m = maze.m, w = maze.wall, walls = [];
  const add = (i, j, dir, dist) => walls.push({ i, j, dir, dist });

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      if (!(DIST(camX - j - 0.5, camZ - i - 0.5) < fe + 1 && w[i][j])) continue;
      if (j > 0 && !w[i][j - 1] && camX < j + 1) add(i, j, WALL_LEFT, DIST(camX - j, camZ - i - 0.5));
      if (j < m - 1 && !w[i][j + 1] && camX > j) add(i, j, WALL_RIGHT, DIST(camX - j - 1, camZ - i - 0.5));
      if (i > 0 && !w[i - 1][j] && camZ < i + 1) add(i, j, WALL_UP, DIST(camX - j - 0.5, camZ - i));
      if (i < n - 1 && !w[i + 1][j] && camZ > i) add(i, j, WALL_DOWN, DIST(camX - j - 0.5, camZ - i - 1));
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
