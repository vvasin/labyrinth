// Recursive portal unfolding of the mirror maze (the new section model).
//
// This REPLACES the earlier "disk of deduped virtual cells" idea. The dedup
// magic was wrong: two mirrors that reach the same virtual cell are NOT
// generally the same reflection, so a virtual cell must be allowed to be drawn
// more than once — each copy clipped to the portal it was seen through.
//
// Instead this is a depth-first portal walk from the cell the eye stands in.
// For each of a section's sides (skipping the one we came in through):
//
//   • OPENING (the real neighbour cell is open): step to that real cell, same
//     orientation and transform — a real piece of the maze;
//   • WALL (the neighbour cell is solid → a mirror): step to a REFLECTION of the
//     current cell (its reference real cell is unchanged), with one more
//     axis-aligned reflection composed into the transform and the orientation
//     flipped.
//
// Every section keeps the REAL cell it represents (`ri,rj`) so the body can be
// drawn on the eye's cell and on every reflected copy of it, and a `mirrored`
// parity. Culling is by VIEW SECTOR, not dedup: each portal narrows a 2-D
// angular sector (measured from the fixed eye point in unfolded space); a branch
// stops when the sector is empty, the distance bound is passed, or the path
// would revisit a virtual cell (a sight-line can't pass through the same cell
// twice — this also guarantees termination through parallel mirrors).
//
// The portals crossed along a path are the masks the section is clipped to when
// rendered (a wall reflection only shows inside the mirror; a real neighbour
// only shows through the opening). They are recorded on each section for the
// render pass; this module itself does no drawing.

import * as M from './mat4.js';

const PI = Math.PI;

// Four grid directions as (dj, di) world steps. j = column = X, i = row = Z.
const DIRS = [
  { dj: 1, di: 0 },   // +X
  { dj: -1, di: 0 },  // -X
  { dj: 0, di: 1 },   // +Z
  { dj: 0, di: -1 },  // -Z
];

// World-space reflection about an axis-aligned plane (x = c, or z = c).
function reflectX(c) { const m = M.identity(); m[0] = -1; m[12] = 2 * c; return m; }
function reflectZ(c) { const m = M.identity(); m[10] = -1; m[14] = 2 * c; return m; }

const vkey = (vi, vj) => vi * 100000 + vj;

// The two endpoints [x,z] of the edge on side `dir` of virtual cell (vi,vj).
function edgeEndpoints(vi, vj, dir) {
  if (dir.dj === 1) return [[vj + 1, vi], [vj + 1, vi + 1]];
  if (dir.dj === -1) return [[vj, vi], [vj, vi + 1]];
  if (dir.di === 1) return [[vj, vi + 1], [vj + 1, vi + 1]];
  return [[vj, vi], [vj + 1, vi]];
}

// Angle of a point relative to the forward direction, in (-PI, PI].
function relAngle(fwdAng, ex, ez, x, z) {
  let a = Math.atan2(z - ez, x - ex) - fwdAng;
  while (a > PI) a -= 2 * PI;
  while (a < -PI) a += 2 * PI;
  return a;
}

// Angular interval [lo,hi] (relative to forward) a portal edge subtends from the
// eye. A straight edge always subtends the SHORT arc between its endpoint
// directions (< PI, exactly PI only with the eye on the edge's line), so we walk
// from a1 by the signed, wrap-normalised gap to a2 rather than taking min/max of
// the two raw angles — the latter silently flips to the > PI complement when the
// short arc straddles the rear (±PI) direction, which happens when the eye sits
// almost on the edge's own plane (standing on a cell border). That flip used to
// return null and wrongly cull the cell beyond as "behind"; the interval may now
// run outside [-PI,PI], which the caller intersects against the (forward,
// non-wrapping) view sector — a rear-straddling edge simply misses the sector.
function portalInterval(fwdAng, ex, ez, e1, e2) {
  const a1 = relAngle(fwdAng, ex, ez, e1[0], e1[1]);
  const a2 = relAngle(fwdAng, ex, ez, e2[0], e2[1]);
  let d = a2 - a1;
  while (d > PI) d -= 2 * PI;
  while (d <= -PI) d += 2 * PI;   // signed short-arc gap, in (-PI, PI]
  return [Math.min(a1, a1 + d), Math.max(a1, a1 + d)];
}

// Unfold the maze around the camera.
//
// params: { maze, camX, camZ, yaw, viewDist, fovy, aspect, margin?, maxSections? }
// returns:
//   visits — every side considered, in depth-first order, each with kind
//     ('start'|'opening'|'wall'), drawn flag, cull reason (null|'angle'|
//     'distance'|'cycle'), the reference real cell (ri,rj), mirrored parity,
//     hasBody, virtual cell (vi,vj) and distance. Culled visits still carry the
//     reference cell they WOULD have drawn (useful for tests/debugging).
//   draws  — the drawn sections sorted FAR → NEAR (eye's own section last), each
//     with its model matrix and the portal masks it is clipped to.
export function unfoldSections(p) {
  const {
    maze, camX, camZ, yaw,
    viewDist = 6, fovy = 65, aspect = 1, margin = 0, maxSections = 5000,
  } = p;
  const wall = maze.wall;
  // The body cell (camX,camZ) is what `hasBody` keys on, but the VIEWPOINT — and
  // the cell the walk starts from — is the EYE, which sits a touch ahead of the
  // body. Starting from the eye's cell matters near a border: the eye can already
  // be in the next cell, and starting from the body's cell would put the cell in
  // front of us behind the eye → angle-culled → black until the body crosses over.
  const { eyeX = camX, eyeZ = camZ, pitch = 0 } = p;
  const ci = Math.floor(eyeZ), cj = Math.floor(eyeX);   // eye / start cell
  const bi = Math.floor(camZ), bj = Math.floor(camX);   // body cell (for hasBody)
  const ex = eyeX, ez = eyeZ;
  const ya = (yaw * PI) / 180;
  const fwdAng = Math.atan2(-Math.cos(ya), Math.sin(ya)); // forward = (sin, -cos)
  // Horizontal half-FOV widens with pitch: looking down (or up) the screen spans
  // a wider range of world azimuths (at straight down, all of them). Take the
  // widest frustum-corner azimuth for this pitch, plus a little slack — portals
  // narrow the sector again almost immediately, so erring wide is cheap.
  const fh = Math.atan(Math.tan((fovy * PI) / 360) * aspect);
  const tv = Math.tan((fovy * PI) / 360);
  const pp = Math.abs((pitch * PI) / 180), tf = Math.tan(fh);
  const half = Math.min(margin + 0.12 + Math.max(
    Math.atan2(tf, Math.cos(pp) - tv * Math.sin(pp)),
    Math.atan2(tf, Math.cos(pp) + tv * Math.sin(pp)),
  ), PI * 0.98);
  const isWall = (ri, rj) => (wall[ri] ? wall[ri][rj] : 1) !== 0; // out of bounds → wall

  const visits = [];  // every side considered (incl. culled), depth-first
  const draws = [];   // drawn sections, later sorted far → near
  const onPath = new Set(); // virtual cells on the current DFS branch (cycle guard)

  // A drawn section doubles as a tree node (it carries `children`) AND as the
  // traversal state for its own recursion (vi/vj/ri/rj/sx/sz/model).
  function recur(s, sector, cameFrom) {
    if (draws.length > maxSections) return;
    for (const dir of DIRS) {
      if (cameFrom && dir.dj === -cameFrom.dj && dir.di === -cameFrom.di) continue; // skip parent
      const nvi = s.vi + dir.di, nvj = s.vj + dir.dj;
      const nri = s.ri + dir.di * s.sz, nrj = s.rj + dir.dj * s.sx;
      const wallHere = isWall(nri, nrj);

      // Build the node first, so even a culled visit reports the reference cell
      // it would have drawn (matches "if it were drawn, ref would be …").
      let ri, rj, sx = s.sx, sz = s.sz, mirrored = s.mirrored, model = s.model;
      if (wallHere) {
        ri = s.ri; rj = s.rj; mirrored = !s.mirrored;            // reflection of the cell in front
        if (dir.dj === 1) { model = M.multiply(reflectX(s.vj + 1), s.model); sx = -sx; }
        else if (dir.dj === -1) { model = M.multiply(reflectX(s.vj), s.model); sx = -sx; }
        else if (dir.di === 1) { model = M.multiply(reflectZ(s.vi + 1), s.model); sz = -sz; }
        else { model = M.multiply(reflectZ(s.vi), s.model); sz = -sz; }
      } else {
        ri = nri; rj = nrj;                                       // real neighbour
      }
      const dist = Math.hypot(nvj + 0.5 - ex, nvi + 0.5 - ez);
      const node = {
        depth: s.depth + 1, vi: nvi, vj: nvj, kind: wallHere ? 'wall' : 'opening',
        ri, rj, sx, sz, mirrored, hasBody: ri === bi && rj === bj, dist, model,
        portalDir: dir, portalVi: s.vi, portalVj: s.vj, // the edge this section is seen through (its mask)
        children: [], solidWalls: [],
      };
      visits.push(node);

      // A wall whose reflection isn't drawn (culled) must still show as a SOLID
      // mirror on the parent, so the player never sees the void behind it.
      const cullSolid = () => { if (wallHere) s.solidWalls.push({ dir, vi: s.vi, vj: s.vj }); };

      const [e1, e2] = edgeEndpoints(s.vi, s.vj, dir);
      const span = portalInterval(fwdAng, ex, ez, e1, e2);
      // The view sector is forward-facing and never wraps; an edge whose arc
      // straddles the rear simply fails to overlap it and is culled here.
      const lo = Math.max(sector[0], span[0]), hi = Math.min(sector[1], span[1]);
      if (lo >= hi) { node.drawn = false; node.cull = 'angle'; cullSolid(); continue; }
      if (dist > viewDist) { node.drawn = false; node.cull = 'distance'; cullSolid(); continue; }
      const k = vkey(nvi, nvj);
      if (onPath.has(k)) { node.drawn = false; node.cull = 'cycle'; cullSolid(); continue; }

      node.drawn = true; node.cull = null;
      draws.push(node);
      s.children.push(node);
      onPath.add(k);
      recur(node, [lo, hi], dir);
      onPath.delete(k);
    }
  }

  const root = {
    depth: 0, vi: ci, vj: cj, kind: 'start', ri: ci, rj: cj, sx: 1, sz: 1,
    mirrored: false, hasBody: ci === bi && cj === bj, dist: 0, model: M.identity(),
    portalDir: null, portalVi: null, portalVj: null, drawn: true, cull: null,
    children: [], solidWalls: [],
  };
  visits.push(root);
  draws.push(root);
  onPath.add(vkey(ci, cj));
  recur(root, [-half, half], null);

  draws.sort((a, b) => b.dist - a.dist); // far → near; the eye's section last
  return { visits, draws, root };
}
