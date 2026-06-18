// Recursive planar mirrors — a port of DrawMirrors() from display_module.c.
//
// Every interior wall face is a mirror. For each visible mirror we (1) stamp
// its silhouette into the stencil buffer, (2) recurse to draw the whole scene
// reflected across that wall, clipped to the wall's half-space and to the
// stencil region, then (3) lay the semi-transparent mirror texture over the
// reflection so it reads as a real wall and writes depth. After all mirrors at
// a level we draw the un-reflected scene there too.
//
// Fixed-function pieces we re-create by hand:
//   • the modelview matrix stack → an accumulated `model` matrix passed down;
//   • glClipPlane → eye-space planes pushed on a stack, fed to the shader;
//   • cull-face flipping → reflections invert winding, so odd depths cull FRONT.

import * as M from './mat4.js';
import { WALL_LEFT, WALL_UP, WALL_RIGHT, WALL_DOWN, visibleWallsFrom } from './scene.js';

// GL stencil enums are stable numbers; spell them out so this file stays
// independent of a live context object.
const GL = { EQUAL: 0x0202, LEQUAL: 0x0203, KEEP: 0x1E00, REPLACE: 0x1E01, INCR: 0x1E02 };

// Per-direction geometry/transform. Returns the mirror quad (4 verts), the
// world-space clip plane, and the reflection matrix across the wall.
function wallData(dir, i, j) {
  const q = (a, b, c, d, nx, ny, nz) => [
    [...a, nx, ny, nz, 0, 0], [...b, nx, ny, nz, 1, 0],
    [...c, nx, ny, nz, 1, 1], [...d, nx, ny, nz, 0, 1],
  ];
  switch (dir) {
    case WALL_LEFT:
      return {
        quad: q([j, 0, i], [j, 0, i + 1], [j, 1, i + 1], [j, 1, i], -1, 0, 0),
        clip: [1, 0, 0, -j],
        reflect: M.translate(M.scale(M.identity(), -1, 1, 1), -2 * j, 0, 0),
      };
    case WALL_RIGHT:
      return {
        quad: q([j + 1, 0, i + 1], [j + 1, 0, i], [j + 1, 1, i], [j + 1, 1, i + 1], 1, 0, 0),
        clip: [-1, 0, 0, j + 1],
        reflect: M.translate(M.scale(M.identity(), -1, 1, 1), -2 * (j + 1), 0, 0),
      };
    case WALL_UP:
      return {
        quad: q([j + 1, 0, i], [j, 0, i], [j, 1, i], [j + 1, 1, i], 0, 0, -1),
        clip: [0, 0, 1, -i],
        reflect: M.translate(M.scale(M.identity(), 1, 1, -1), 0, 0, -2 * i),
      };
    case WALL_DOWN:
      return {
        quad: q([j, 0, i + 1], [j + 1, 0, i + 1], [j + 1, 1, i + 1], [j, 1, i + 1], 0, 0, 1),
        clip: [0, 0, -1, i + 1],
        reflect: M.translate(M.scale(M.identity(), 1, 1, -1), 0, 0, -2 * (i + 1)),
      };
  }
}

// Reflect a viewpoint (cx,cz) across a wall's mirror plane — the same isometry
// `d.reflect` applies to the geometry, in 2D. Threading this down the recursion
// gives each level the virtual camera it should pick its visible walls from.
function reflectCam(dir, i, j, cx, cz) {
  switch (dir) {
    case WALL_LEFT: return [2 * j - cx, cz];
    case WALL_RIGHT: return [2 * (j + 1) - cx, cz];
    case WALL_UP: return [cx, 2 * i - cz];
    case WALL_DOWN: return [cx, 2 * (i + 1) - cz];
  }
}

// World-space centre of a wall's mirror face, in the maze xz-plane.
function faceCenter(dir, i, j) {
  switch (dir) {
    case WALL_LEFT: return [j, i + 0.5];
    case WALL_RIGHT: return [j + 1, i + 0.5];
    case WALL_UP: return [j + 0.5, i];
    case WALL_DOWN: return [j + 0.5, i + 1];
  }
}

// Decide which visible walls actually get recursed into (the expensive job:
// each is a whole reflected sub-render, cost ~ walls^depth). Returns a Set of
// wall objects from `visible`.
//
// Depth 0 reflects every wall in line of sight — those are the real walls around
// the player and must all mirror. Deeper levels keep only the nearest
// `reflectCap`, but ranked by how CENTRAL each wall is to the mirror we're
// looking through (the angle off the portal's principal ray), not by raw
// distance. The wall straight down the portal — e.g. the wall behind you, seen
// in the mirror ahead — has to win the budget over the near peripheral side
// walls, or the hall-of-mirrors tunnel collapses into a flat opaque wall.
function chooseReflections(ctx, depth, visible, camX, camZ, portalX, portalZ) {
  const set = new Set();
  if (depth >= ctx.maxDepth) return set;
  if (depth === 0) {
    for (const w of visible) if (w.los) set.add(w);
    return set;
  }
  const dx = portalX - camX, dz = portalZ - camZ;
  const dl = Math.hypot(dx, dz) || 1;
  const ndx = dx / dl, ndz = dz / dl;
  const ranked = [];
  for (const w of visible) {
    if (!w.los) continue;
    const [fx, fz] = faceCenter(w.dir, w.i, w.j);
    const vx = fx - camX, vz = fz - camZ, vl = Math.hypot(vx, vz) || 1;
    const cos = (vx * ndx + vz * ndz) / vl;   // 1 = dead ahead, < 0 = behind us
    if (cos > 0) ranked.push({ w, cos });      // drop walls outside the portal cone
  }
  ranked.sort((a, b) => b.cos - a.cos);
  for (let k = 0; k < ranked.length && k < ctx.reflectCap; k++) set.add(ranked[k].w);
  return set;
}

// ctx: { r, proj, view, maze, range, maxDepth, reflectCap, mirrorMat,
//        mirrorOpaque, drawScene(model, clips, depth) }
function recurse(ctx, depth, id, model, clips, camX, camZ, portalX, portalZ) {
  const r = ctx.r;
  const face = (depth & 1) === 1;          // true → cull FRONT (reflected winding)
  const nextId = id + 1;

  // The walls that face THIS viewpoint, within optical range, nearest first.
  // Recomputed per level from the reflected virtual camera — the old code reused
  // one real-camera list at every depth, so deep reflections drew the wrong (and
  // capped) walls and the floor showed through where a mirror should have been.
  //
  // Every wall here is laid down as a mirror SURFACE, so the reflected room is
  // always fully walled (no floor leaks). Only the chosen few (see
  // chooseReflections) are RECURSED into; a wall that gets a surface but no
  // reflection is drawn opaque, reading as a solid wall rather than a hole.
  const visible = visibleWallsFrom(ctx.maze, camX, camZ, ctx.range, portalX, portalZ);
  const reflectSet = chooseReflections(ctx, depth, visible, camX, camZ, portalX, portalZ);

  for (const w of visible) {
    const d = wallData(w.dir, w.i, w.j);
    const canRecurse = reflectSet.has(w);

    if (canRecurse) {
      // (1) stamp the mirror silhouette into the stencil (color/depth masked
      //     off, INCR-on-pass set by the caller).
      r.cullFace(face);
      r.stencilFunc(GL.EQUAL, id, 0xFF);
      r.setMatrices(ctx.proj, M.multiply(ctx.view, model));
      r.drawQuad(d.quad);

      // (2) recurse: draw the scene reflected across this wall, clipped to its
      //     half-space (eye-space plane added to the stack), from the reflected
      //     virtual camera. We also pass the portal we're stepping through (this
      //     wall's face centre) so the child can rank its own mirrors by how
      //     central they are to it.
      const planeEye = M.transformPlane(M.multiply(ctx.view, model), d.clip);
      const [rx, rz] = reflectCam(w.dir, w.i, w.j, camX, camZ);
      const [fx, fz] = faceCenter(w.dir, w.i, w.j);
      recurse(ctx, depth + 1, nextId, M.multiply(model, d.reflect),
        clips.concat([planeEye]), rx, rz, fx, fz);
    }

    // (3) lay the textured mirror over the reflection; REPLACE resets the
    //     stencil to `id` and depth is written so the mirror occludes like a
    //     wall. A recursed wall is semi-transparent so its reflection shows
    //     through; everything else — out of budget, past max depth, or not in
    //     line of sight — is OPAQUE, so it reads as a solid wall instead of a
    //     hole onto the void behind the glass.
    r.cullFace(face);
    r.stencilFunc(GL.LEQUAL, id, 0xFF);
    r.stencilOp(GL.KEEP, GL.KEEP, GL.REPLACE);
    r.colorMask(true);
    r.depthMask(true);
    r.setClipPlanes(clips);
    r.setMatrices(ctx.proj, M.multiply(ctx.view, model));
    r.setMaterial(canRecurse ? ctx.mirrorMat : (ctx.mirrorOpaque || ctx.mirrorMat));
    r.drawQuad(d.quad);

    r.depthMask(false);
    r.colorMask(false);
    r.stencilOp(GL.KEEP, GL.KEEP, GL.INCR);
  }

  // un-reflected scene at this level, in the stencil region <= id.
  r.cullFace(face);
  r.stencilFunc(GL.LEQUAL, id, 0xFF);
  r.stencilOp(GL.KEEP, GL.KEEP, GL.KEEP);
  r.depthMask(true);
  r.colorMask(true);
  ctx.drawScene(model, clips, depth);

  r.colorMask(false);
  r.depthMask(false);
  r.stencilOp(GL.KEEP, GL.KEEP, GL.INCR);
}

export function drawMirrors(ctx) {
  const r = ctx.r, gl = r.gl;
  gl.enable(gl.STENCIL_TEST);
  r.colorMask(false);
  r.depthMask(false);
  r.stencilOp(GL.KEEP, GL.KEEP, GL.INCR);
  recurse(ctx, 0, 0, M.identity(), [], ctx.camX, ctx.camZ, ctx.camX, ctx.camZ);
  // restore sane defaults for any non-mirror drawing
  r.stencilOp(GL.KEEP, GL.KEEP, GL.KEEP);
  r.depthMask(true);
  r.colorMask(true);
  gl.disable(gl.STENCIL_TEST);
}
