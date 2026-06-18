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
import { WALL_LEFT, WALL_UP, WALL_RIGHT, WALL_DOWN } from './scene.js';

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

// ctx: { r, proj, view, walls, maxDepth, reflectCap, mirrorMat, drawScene(model, clips, depth) }
function recurse(ctx, depth, id, model, clips) {
  const r = ctx.r;
  const face = (depth & 1) === 1;          // true → cull FRONT (reflected winding)
  const nextId = id + 1;

  if (depth < ctx.maxDepth) {
    // Depth 0 must draw every visible wall — the wall surfaces ARE the mirrors.
    // Deeper reflections recurse only into the nearest few walls so the
    // recursion (cost ~ walls^depth) can't explode.
    const levelWalls = depth === 0 ? ctx.walls : ctx.walls.slice(0, ctx.reflectCap);
    for (const w of levelWalls) {
      const d = wallData(w.dir, w.i, w.j);

      // (1) stamp the mirror silhouette into the stencil (color/depth masked
      //     off, INCR-on-pass set by the caller).
      r.cullFace(face);
      r.stencilFunc(GL.EQUAL, id, 0xFF);
      r.setMatrices(ctx.proj, M.multiply(ctx.view, model));
      r.drawQuad(d.quad);

      // (2) recurse: draw the scene reflected across this wall, clipped to its
      //     half-space (eye-space plane added to the stack).
      const planeEye = M.transformPlane(M.multiply(ctx.view, model), d.clip);
      const childClips = clips.concat([planeEye]);
      const childModel = M.multiply(model, d.reflect);
      recurse(ctx, depth + 1, nextId, childModel, childClips);

      // (3) lay the textured, semi-transparent mirror over the reflection;
      //     REPLACE resets the stencil to `id` and depth is written so the
      //     mirror occludes like a wall.
      r.cullFace(face);
      r.stencilFunc(GL.LEQUAL, id, 0xFF);
      r.stencilOp(GL.KEEP, GL.KEEP, GL.REPLACE);
      r.colorMask(true);
      r.depthMask(true);
      r.setClipPlanes(clips);
      r.setMatrices(ctx.proj, M.multiply(ctx.view, model));
      r.setMaterial(ctx.mirrorMat);
      r.drawQuad(d.quad);

      r.depthMask(false);
      r.colorMask(false);
      r.stencilOp(GL.KEEP, GL.KEEP, GL.INCR);
    }
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
  recurse(ctx, 0, 0, M.identity(), []);
  // restore sane defaults for any non-mirror drawing
  r.stencilOp(GL.KEEP, GL.KEEP, GL.KEEP);
  r.depthMask(true);
  r.colorMask(true);
  gl.disable(gl.STENCIL_TEST);
}
