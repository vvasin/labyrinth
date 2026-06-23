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

// Path polyline (cells → world-space strip points at low height).
export function buildPathLine(cells) {
  const out = [];
  for (const c of cells) {
    out.push(c.y + 0.5, 0.1, c.x + 0.5, 0, 1, 0, 0, 0);
  }
  return new Float32Array(out);
}

// A single quad covering the whole maze footprint at the floor plane — the dark
// "wall" base for the readable overview. Open floor tiles (buildFloor) are drawn
// just above it, so the maze reads as bright channels carved out of a solid
// slab. UV repeats once per cell so the floor texture (used dimmed) keeps a grid.
export function buildPlate(maze) {
  const n = maze.n, m = maze.m, out = [];
  pushQuad(out,
    v(0, 0, 0, 0, 1, 0, 0, 0),
    v(0, 0, n, 0, 1, 0, 0, n),
    v(m, 0, n, 0, 1, 0, m, n),
    v(m, 0, 0, 0, 1, 0, m, 0));
  return new Float32Array(out);
}

// A flat unit quad centred on the origin, lying on the floor (normal up). The
// overview places one per marker (start / exit decal) with a translate, so its
// texture reads as an emblem stamped on the floor.
export function buildDecal() {
  const out = [];
  pushQuad(out,
    v(-0.5, 0, -0.5, 0, 1, 0, 0, 0),
    v(-0.5, 0, 0.5, 0, 1, 0, 0, 1),
    v(0.5, 0, 0.5, 0, 1, 0, 1, 1),
    v(0.5, 0, -0.5, 0, 1, 0, 1, 0));
  return new Float32Array(out);
}

// The hint pickup: a small floating octahedron (a "gem"). Drawn in the section
// pass so it reflects in the mirror walls. Centred on the origin, ±0.5 across.
export function buildHint() {
  const out = [];
  const top = [0, 1, 0], bot = [0, -1, 0];
  const eq = [[1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1]];
  const tri = (a, b, c) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const L = Math.hypot(nx, ny, nz) || 1; nx /= L; ny /= L; nz /= L;
    out.push(...v(a[0], a[1], a[2], nx, ny, nz, 0.5, 1));
    out.push(...v(b[0], b[1], b[2], nx, ny, nz, 0, 0));
    out.push(...v(c[0], c[1], c[2], nx, ny, nz, 1, 0));
  };
  for (let k = 0; k < 4; k++) {
    tri(top, eq[k], eq[(k + 1) % 4]);
    tri(bot, eq[(k + 1) % 4], eq[k]);
  }
  return new Float32Array(out);
}

// A ribbon (triangle strip, emitted as quads) running along a list of cells, for
// the in-game hint reveal. It hugs the floor, carries the cumulative arc length
// in U (so the shader can flow a pulse along it toward the exit) and 0/1 across
// in V. World coords: x = col + 0.5, z = row + 0.5.
export function buildPathRibbon(cells, width = 0.17, y = 0.06) {
  const out = [];
  if (cells.length < 2) return new Float32Array(out);
  const pts = cells.map((c) => [c.y + 0.5, c.x + 0.5]); // [x, z]
  // Per-point left/right edges, offset by the perpendicular of the averaged
  // incoming/outgoing direction, plus the cumulative arc length at each point.
  const left = [], right = [], arc = [];
  let acc = 0;
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(pts.length - 1, i + 1)];
    let dx = next[0] - prev[0], dz = next[1] - prev[1];
    const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
    const px = -dz, pz = dx; // perpendicular
    const h = width / 2;
    left.push([pts[i][0] + px * h, pts[i][1] + pz * h]);
    right.push([pts[i][0] - px * h, pts[i][1] - pz * h]);
    if (i > 0) acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    arc.push(acc);
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const l0 = left[i], r0 = right[i], l1 = left[i + 1], r1 = right[i + 1];
    const a0 = arc[i], a1 = arc[i + 1];
    pushQuad(out,
      v(l0[0], y, l0[1], 0, 1, 0, a0, 1),
      v(r0[0], y, r0[1], 0, 1, 0, a0, 0),
      v(r1[0], y, r1[1], 0, 1, 0, a1, 0),
      v(l1[0], y, l1[1], 0, 1, 0, a1, 1));
  }
  return new Float32Array(out);
}
