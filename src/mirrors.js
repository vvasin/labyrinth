// Recursive planar mirrors — a port of DrawMirrors() from display_module.c.
//
// Every interior wall face is a mirror. Each level owns a stencil value `id`.
// For each facing wall we (1) stamp its silhouette id→id+1, (2) if it's close
// enough and in view, recurse to draw the scene reflected across it into that
// id+1 region, clipped to the wall's half-space, then (3) lay a mirror pane over
// the whole silhouette (semi-transparent if reflected, opaque otherwise). Once
// every wall is stamped, the un-reflected scene is drawn only where the stencil
// is still exactly id — the open area no wall covers. That EQUAL-id mask is the
// "culling mask" that stops the floor being redrawn over the mirrors (the
// z-fighting); without it the base pass and the reflections overlap.
//
// Reflection budget is a DISTANCE (`reflectDist`, in cells), not a wall count:
// the virtual camera is the eye folded through the mirror chain, so a wall's
// distance from it is the real optical path, and "within N cells" is a stable
// cutoff out in the fog. A count cap instead flips near walls between mirror and
// solid as you move (flicker).
//
// Fixed-function pieces we re-create by hand:
//   • the modelview matrix stack → an accumulated `model` matrix passed down;
//   • glClipPlane → eye-space planes pushed on a stack, fed to the shader;
//   • cull-face flipping → reflections invert winding, so odd depths cull FRONT.

import * as M from './mat4.js';
import { WALL_LEFT, WALL_UP, WALL_RIGHT, WALL_DOWN, visibleWallsFrom } from './scene.js';
import { MAX_CLIP } from './shaders.js';

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

// The two endpoints of a wall's mirror face in the maze xz-plane — the edges of
// the "portal" you look through when this wall is recursed into.
function faceEnds(dir, i, j) {
  switch (dir) {
    case WALL_LEFT: return [j, i, j, i + 1];
    case WALL_RIGHT: return [j + 1, i, j + 1, i + 1];
    case WALL_UP: return [j, i, j + 1, i];
    case WALL_DOWN: return [j, i + 1, j + 1, i + 1];
  }
}

// Is direction (cx,cz)←from the viewpoint inside the angular cone the portal
// (segment A→B) subtends from that viewpoint? Pure 2D cross-product sidedness,
// so it works no matter how the portal is oriented. A null portal (depth 0, the
// real camera) means "everything is in view".
function inCone(camX, camZ, portal, cx, cz) {
  if (!portal) return true;
  const eax = portal[0] - camX, eaz = portal[1] - camZ;
  const ebx = portal[2] - camX, ebz = portal[3] - camZ;
  const vx = cx - camX, vz = cz - camZ;
  const c = eax * ebz - eaz * ebx;            // cross(A, B): the cone's turn sense
  if (Math.abs(c) < 1e-9) return true;        // degenerate portal — don't cull
  const s1 = eax * vz - eaz * vx;             // cross(A, v)
  const s2 = vx * ebz - vz * ebx;             // cross(v, B)
  return s1 * c > 0 && s2 * c > 0;            // v between A and B
}

// ctx: { r, proj, view, maze, range, reflectDist, mirrorMat, mirrorOpaque,
//        drawScene(model, clips, depth) }
//
// `id` doubles as the recursion depth and the stencil value owned by this level.
// `portal` is the mirror face (4 maze-plane coords) we stepped through to get
// here, or null at the top; `camX,camZ` is this level's reflected virtual camera.
function recurse(ctx, depth, id, model, clips, camX, camZ, portal) {
  const r = ctx.r;
  const face = (depth & 1) === 1;          // true → cull FRONT (reflected winding)
  const nextId = id + 1;
  const losX = portal ? (portal[0] + portal[2]) / 2 : camX;
  const losZ = portal ? (portal[1] + portal[3]) / 2 : camZ;

  // Walls that face this (reflected) viewpoint within visible range. Every one
  // gets a mirror SURFACE, so the reflected room is always fully walled (no
  // floor leaks). A wall is RECURSED into — its reflection drawn behind a
  // semi-transparent pane — only when it is in line of sight, inside the portal
  // cone, and within the reflection distance budget; otherwise it's opaque.
  //
  // The budget is a DISTANCE (in cells), not a count: because the virtual camera
  // is the eye reflected through the mirror chain, a wall's distance from it is
  // the true folded optical path, so "within reflectDist cells of the eye" is a
  // stable test whose boundary sits out in the fog. The old nearest-N count cap
  // flipped near walls between mirror and solid as you moved — the flicker.
  const range = Math.max(ctx.range, ctx.reflectDist);
  const visible = visibleWallsFrom(ctx.maze, camX, camZ, range, losX, losZ);

  for (const w of visible) {
    const d = wallData(w.dir, w.i, w.j);
    const [fx, fz] = faceCenter(w.dir, w.i, w.j);
    const canRecurse = clips.length < MAX_CLIP && w.los &&
      w.dist <= ctx.reflectDist && inCone(camX, camZ, portal, fx, fz);

    // (1) stamp this wall's silhouette into the stencil: id → id+1. Marking
    //     EVERY wall (not just recursed ones) lets the un-reflected scene below
    //     mask itself out of all wall pixels — that's the culling mask that
    //     stops the floor being redrawn over a mirror (the z-fighting).
    r.cullFace(face);
    r.stencilFunc(GL.EQUAL, id, 0xFF);
    r.stencilOp(GL.KEEP, GL.KEEP, GL.INCR);
    r.colorMask(false);
    r.depthMask(false);
    r.setMatrices(ctx.proj, M.multiply(ctx.view, model));
    r.drawQuad(d.quad);

    // (2) recurse: draw the scene reflected across this wall into its id+1
    //     region, clipped to the wall's half-space, from the reflected virtual
    //     camera. The wall's own face becomes the child's portal.
    if (canRecurse) {
      const planeEye = M.transformPlane(M.multiply(ctx.view, model), d.clip);
      const [rx, rz] = reflectCam(w.dir, w.i, w.j, camX, camZ);
      recurse(ctx, depth + 1, nextId, M.multiply(model, d.reflect),
        clips.concat([planeEye]), rx, rz, faceEnds(w.dir, w.i, w.j));
    }

    // (3) lay the mirror pane over the wall's whole silhouette (stencil ≥ id+1),
    //     writing depth so it occludes like a wall and flattening the region
    //     back to id+1. A recursed wall is semi-transparent (its reflection
    //     shows through); a wall with nothing drawn behind it is OPAQUE, reading
    //     as a solid wall rather than a hole onto the void.
    r.cullFace(face);
    r.stencilFunc(GL.LEQUAL, nextId, 0xFF);
    r.stencilOp(GL.KEEP, GL.KEEP, GL.REPLACE);
    r.colorMask(true);
    r.depthMask(true);
    r.setClipPlanes(clips);
    r.setMatrices(ctx.proj, M.multiply(ctx.view, model));
    r.setMaterial(canRecurse ? ctx.mirrorMat : (ctx.mirrorOpaque || ctx.mirrorMat));
    r.drawQuad(d.quad);
  }

  // un-reflected scene at this level — only where the stencil is still exactly
  // id, i.e. the open area NOT covered by any wall pane. This is the mask that
  // keeps the floor/markers from being drawn a second time over the mirrors.
  r.cullFace(face);
  r.stencilFunc(GL.EQUAL, id, 0xFF);
  r.stencilOp(GL.KEEP, GL.KEEP, GL.KEEP);
  r.depthMask(true);
  r.colorMask(true);
  ctx.drawScene(model, clips, depth);
}

export function drawMirrors(ctx) {
  const r = ctx.r, gl = r.gl;
  gl.enable(gl.STENCIL_TEST);
  r.colorMask(false);
  r.depthMask(false);
  recurse(ctx, 0, 0, M.identity(), [], ctx.camX, ctx.camZ, null);
  // restore sane defaults for any non-mirror drawing
  r.stencilOp(GL.KEEP, GL.KEEP, GL.KEEP);
  r.depthMask(true);
  r.colorMask(true);
  gl.disable(gl.STENCIL_TEST);
}
