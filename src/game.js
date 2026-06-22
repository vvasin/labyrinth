// App: maze lifecycle, camera, collision, the preview→play→finish state
// machine, lighting per mode, and the render loop that drives the mirror
// recursion. Ported from labyrinth.c / display / game / control modules, with
// the desktop-only frame recorder dropped.

import * as M from './mat4.js';
import { Maze } from './maze.js';
import { Renderer } from './renderer.js';
import { Mech } from './mech.js';
import { unfoldSections } from './unfold.js';
import {
  buildFloor, buildUnitFloor, buildStartWall, buildEndWall, buildBoundary,
  buildPathLine, wallQuad,
} from './scene.js';
import { loadSettings, saveSettings } from './persistence.js';

const FOVY = 65, RADIUS = 0.24;
// Fog is tied to the view distance (see _lighting): it reaches fully opaque at
// the radial cutoff where the section walk stops, and starts fading in at this
// fraction of that distance.
const FOG_NEAR_FRAC = 0.35;
const SPOT_CUTOFF = Math.cos((35 * Math.PI) / 180), SPOT_EXP = 40, SPOT_ATTEN = 0.2;
const MOVE_SPEED = 1.9, LOOK_SPEED = 0.22, ANIM_TIME = 1.0;
// First-person avatar: camX/camZ is the actor's body centre — the vertical yaw
// axis and the collision point. The eye sits EYE_FWD in front of that axis (at
// the actor's "eyes"), so the body never blocks the forward view yet stays
// right behind the camera. AVATAR_SCALE puts the head just below eye level;
// BOB_AMP is the walk-driven head bob applied to the eye.
const AVATAR_SCALE = 0.23, EYE_FWD = 0.1, BOB_AMP = 0.02;
// Near clip, and the eye-to-portal distance under which we stop masking the cell
// ahead (the portal would be in front of the near plane and stamp nothing).
const NEAR_CLIP = 0.05, NEAR_DOORWAY = 0.12;

const FLOOR_MAT = { base: [0.78, 0.74, 0.95], spec: [0.5, 0.42, 0.42], shininess: 10 };
const MIRROR_MAT = { base: [0.62, 0.66, 0.72], alpha: 0.22, spec: [0.9, 0.9, 0.9], shininess: 60 };
// The markers carry emission so they still glow, but are lit (not `unlit`) so
// they pass through fog and depth like real geometry — otherwise the unlit
// branch in the shader skips fog and the exit shows through distant walls that
// (being beyond fog range) were never drawn to occlude it.
const START_MAT = { base: [0.85, 0.3, 0.3], emission: [0.55, 0.14, 0.14], alpha: 0.85 };
const END_MAT = { base: [0.3, 0.85, 0.3], emission: [0.14, 0.55, 0.14], alpha: 0.85 };

export class App {
  constructor(canvas) {
    this.canvas = canvas;
    this.r = new Renderer(canvas);
    this.maze = new Maze();
    this.mech = new Mech(this.r);

    this.tex = {
      floor: this.r.loadTexture('textures/floor.bmp'),
      mirror: this.r.loadTexture('textures/mirror.bmp'),
      start: this.r.loadTexture('textures/start.bmp'),
      end: this.r.loadTexture('textures/end.bmp'),
    };

    const s = loadSettings();
    this.viewDist = s.viewDist;
    this.unitFloorMesh = this.r.createMesh(buildUnitFloor());
    this.input = { f: false, b: false, l: false, rt: false, jx: 0, jy: 0 };
    this.cheat = false;
    this.walkPhase = 0;
    this.animT = 0;
    this.bob = 0;        // current camera head-bob offset (eased)
    this.moving = false; // did the player move this frame

    this.maze.generate(s.N, s.M, s.p, s.q);
    this._rebuild();
    this._enterPreview();

    this._dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._resize();
    window.addEventListener('resize', () => this._resize());

    this._last = performance.now();
    this._frame = this._frame.bind(this);
    requestAnimationFrame(this._frame);
  }

  // --- maze + meshes ------------------------------------------------------
  _rebuild() {
    const r = this.r, mz = this.maze;
    mz.wall[1][0] = 0; // open the entrance so the floor tile & side walls read right
    this.floorMesh = r.createMesh(buildFloor(mz));
    mz.wall[1][0] = 1;
    this.startMesh = r.createMesh(buildStartWall());
    this.endMesh = r.createMesh(buildEndWall(mz));
    this.boundaryMesh = r.createMesh(buildBoundary(mz));
    this.pathMesh = r.createMesh(buildPathLine(mz.solutionPath()));
  }

  regenerate() {
    this.maze.generate();
    this._rebuild();
    this._enterPreview();
  }

  resize(dN) {
    const N = Math.max(3, Math.min(40, this.maze.N + dN));
    this.maze.generate(N, N, this.maze.p, this.maze.q);
    this._rebuild();
    this._enterPreview();
    this._save();
  }

  adjustParam(which, delta) {
    const clamp = (x) => Math.max(0, Math.min(1, +x.toFixed(3)));
    if (which === 'p') this.maze.p = clamp(this.maze.p + delta);
    else this.maze.q = clamp(this.maze.q + delta);
    this.maze.generate();
    this._rebuild();
    this._enterPreview();
    this._save();
  }

  setViewDist(d) { this.viewDist = Math.max(4, Math.min(16, d | 0)); this._save(); }

  _save() {
    saveSettings({
      N: this.maze.N, M: this.maze.M, p: this.maze.p, q: this.maze.q, viewDist: this.viewDist,
    });
  }

  // --- state machine ------------------------------------------------------
  _enterPreview() {
    this.state = 'p';
    this.pitch = -90;
    this.yaw = 0;
    this.cheat = false;
    this._framePreview();
  }

  // Place the top-down preview camera so the whole maze fits the viewport,
  // accounting for the (often portrait) aspect: the vertical FOV frames the
  // maze depth (n), the horizontal FOV (= vertical · aspect) frames its width
  // (m), and we take whichever height satisfies both. The +1 pads a half-cell
  // border.
  _framePreview() {
    const mz = this.maze;
    const aspect = this.canvas.width / this.canvas.height || 1;
    const t = Math.tan((FOVY * Math.PI) / 360);
    this.camX = mz.m / 2;
    this.camZ = mz.n / 2;
    this.camY = Math.max((mz.n / 2 + 1) / t, (mz.m / 2 + 1) / (t * aspect));
  }

  startGame() {
    if (this.state !== 'p') return;
    this.state = 's';
    this.animT = 0;
    this.camX = 1.5; this.camY = 0.5; this.camZ = 1.5;
    this.pitch = 0; this.yaw = 90;
  }

  giveUp() { if (this.state === 'g') this._enterPreview(); }
  togglePath() { if (this.state === 'g') this.cheat = !this.cheat; }

  // --- camera & movement --------------------------------------------------
  _parseMove() {
    const mz = this.maze, w = mz.wall, r = RADIUS;
    let ix = this.camX | 0, iz = this.camZ | 0;
    let t;
    t = Math.floor(this.camZ - r); if (w[t]?.[ix]) this.camZ = t + r + 1;
    t = Math.floor(this.camZ + r); if (w[t]?.[ix]) this.camZ = t - r;
    t = Math.floor(this.camX - r); if (w[iz]?.[t]) this.camX = t + r + 1;
    t = Math.floor(this.camX + r); if (w[iz]?.[t]) this.camX = t - r;
    // Corner (diagonal) push-out: a wall cell touching the current cell only at a
    // corner is missed by the axis checks above (it shares neither the row nor the
    // column we test), so a diagonal approach lets the disc — and the body it
    // carries — poke into it, glitching the view. Only the corner case is left
    // here: if either orthogonal neighbour is a wall the axis push already cleared
    // it. Push the disc radially out of any such corner it overlaps.
    ix = this.camX | 0; iz = this.camZ | 0;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      if (!w[iz + sz]?.[ix + sx]) continue;                  // diagonal cell is open
      if (w[iz]?.[ix + sx] || w[iz + sz]?.[ix]) continue;    // an axis face already handled it
      const cx = sx < 0 ? ix : ix + 1, cz = sz < 0 ? iz : iz + 1; // shared grid corner
      const dx = this.camX - cx, dz = this.camZ - cz, d = Math.hypot(dx, dz);
      if (d < r && d > 1e-6) { this.camX = cx + (dx / d) * r; this.camZ = cz + (dz / d) * r; }
    }
    if (ix === mz.m - 1 && iz === mz.n - 2) this._finish();
  }

  _finish() {
    if (this.state === 'g') { this.state = 'f'; this.animT = 0; }
  }

  look(dx, dy) {
    if (this.state !== 'g') return; // no free-look on the preview/transition screens
    this.pitch = Math.max(-90, Math.min(90, this.pitch + dy * LOOK_SPEED));
    this.yaw -= dx * LOOK_SPEED;
  }

  _move(dt) {
    this.moving = false;
    if (this.state !== 'g') return;
    const i = this.input;
    let fwd = (i.f ? 1 : 0) - (i.b ? 1 : 0) - i.jy;
    let str = (i.l ? 1 : 0) - (i.rt ? 1 : 0) - i.jx;
    if (fwd === 0 && str === 0) return;
    const mag = Math.hypot(fwd, str) || 1;
    const step = (MOVE_SPEED * dt) / (mag > 1 ? mag : 1);
    const ya = (this.yaw * Math.PI) / 180;
    const px = this.camX, pz = this.camZ;
    this.camX += step * fwd * Math.sin(ya) - step * str * Math.cos(ya);
    this.camZ += -step * fwd * Math.cos(ya) - step * str * Math.sin(ya);
    this._parseMove();
    const moved = Math.hypot(this.camX - px, this.camZ - pz);
    this.walkPhase += moved * 9;
    this.moving = moved > 1e-5;
  }

  // --- per-frame update + lighting ---------------------------------------
  _update(dt) {
    if (this.state === 's') {
      this.animT += dt / ANIM_TIME;
      if (this.animT >= 1) { this.animT = 0; this.state = 'g'; }
    } else if (this.state === 'f') {
      this.animT += dt / ANIM_TIME;
      if (this.animT >= 1) this._enterPreview();
    }
    this._move(dt);
    // Head bob: the camera rides the avatar's gait while walking and eases back
    // to rest when stopped, so the eye stays "attached" to the head.
    const target = this.moving ? Math.abs(Math.sin(this.walkPhase)) * BOB_AMP : 0;
    this.bob += (target - this.bob) * Math.min(1, dt * 12);
  }

  _lighting() {
    const view = this._viewMatrix();
    const l0 = M.transformVec4(view, [-1.5, 0.5, -1.0, 0]);
    const len = Math.hypot(l0[0], l0[1], l0[2]) || 1;
    const dir = [l0[0] / len, l0[1] / len, l0[2] / len];
    const preview = this.state === 'p';
    // Sync the fog to the view distance so the world dissolves into fog exactly
    // where the section walk stops drawing cells — geometry never pops in/out at
    // the recursion boundary. The cull is radial (distance to the cell) while fog
    // is by forward depth, so on a wide screen a diagonal sight-line reaches a
    // touch farther than a straight-ahead one; that's the intended corner case.
    // The cull drops a cell when its CENTRE passes `viewDist`, but that cell's
    // near wall edge is up to half a cell closer (forward depth ≈ viewDist-0.5).
    // So fog must reach full half a cell BEFORE the cull radius — otherwise the
    // near edge is still semi-transparent when its cell is dropped and the wall
    // snaps out. (Fog is by forward depth while the cull is radial, so on a wide
    // screen a diagonal sight-line fades a touch later — the intended corner case.)
    let fogColor = [0, 0, 0], fogOn = !preview;
    let fogEnd = this.viewDist - 0.5, fogStart = this.viewDist * FOG_NEAR_FRAC;
    if (this.state === 's') { fogStart *= this.animT; fogEnd *= this.animT; }
    if (this.state === 'f') {
      const t = this.animT;
      fogColor = [t, t, t];
      fogStart *= (1 - t); fogEnd *= (1 - t);
    }
    return {
      ambient: [0.2, 0.2, 0.2],
      light0Dir: dir,
      light0Color: preview ? [1, 1, 1] : [0.55, 0.55, 0.55],
      spotOn: !preview,
      spotColor: [1, 1, 0.7], spotCutoff: SPOT_CUTOFF, spotExp: SPOT_EXP, spotAtten: SPOT_ATTEN,
      fogOn, fogColor, fogStart, fogEnd,
    };
  }

  _viewMatrix() {
    // Yaw turns about the actor's body axis (camX,camZ); the eye is EYE_FWD in
    // front of it, so the camera arcs around the body as it turns instead of the
    // body swinging behind a self-pivoting camera. Bob rides the eye vertically.
    const ya = (this.yaw * Math.PI) / 180;
    const ex = this.camX + EYE_FWD * Math.sin(ya);
    const ez = this.camZ - EYE_FWD * Math.cos(ya);
    let v = M.rotateX(M.identity(), -this.pitch);
    v = M.rotateY(v, this.yaw);
    v = M.translate(v, -ex, -(this.camY + this.bob), -ez);
    return v;
  }

  // --- rendering ----------------------------------------------------------
  // Top-down overview: the whole maze drawn flat, with no mirror walls.
  _drawPreview() {
    const r = this.r, proj = this._proj, view = this._view;
    r.setClipPlanes([]);
    r.enableCull(true);

    r.setMatrices(proj, view);
    r.setMaterial({ ...FLOOR_MAT, tex: this.tex.floor });
    r.drawMesh(this.floorMesh);

    r.depthMask(false);
    r.setMaterial({ ...START_MAT, tex: this.tex.start });
    r.drawMesh(this.startMesh);
    r.setMaterial({ ...END_MAT, tex: this.tex.end });
    r.drawMesh(this.endMesh);
    r.depthMask(true);

    r.setMaterial({ base: [1, 1, 0], unlit: true });
    r.drawMesh(this.pathMesh, r.gl.LINE_STRIP);
  }

  // First-person: the recursive portal unfolding. We walk the section tree
  // depth-first; each child is masked into its portal's silhouette with the
  // stencil buffer (so two different reflections that land on the same virtual
  // cell never bleed into each other), the subtree is drawn, then — for a wall —
  // the semi-transparent mirror glass is laid over it, and finally each section's
  // own floor/body/markers are drawn (children first, so far → near).
  _renderSections() {
    const r = this.r, gl = r.gl, proj = this._proj, view = this._view, mz = this.maze;
    const aspect = this.canvas.width / this.canvas.height || 1;
    // The eye sits EYE_FWD ahead of the body axis (see _viewMatrix); the view
    // sector is measured from there, not from the body centre.
    const ya = (this.yaw * Math.PI) / 180;
    const eyeX = this.camX + EYE_FWD * Math.sin(ya), eyeZ = this.camZ - EYE_FWD * Math.cos(ya);
    const { root } = unfoldSections({
      maze: mz, camX: this.camX, camZ: this.camZ, yaw: this.yaw, pitch: this.pitch,
      eyeX, eyeZ, viewDist: this.viewDist, fovy: FOVY, aspect,
    });

    const sI = 1, sJ = 1;                 // start room cell
    const eI = mz.n - 2, eJ = mz.m - 2;   // last room before the exit
    const showBody = this.state === 's' || this.state === 'g' || this.state === 'f';
    // The avatar straddles a cell border when you stand near one, so draw it on
    // every real cell its footprint overlaps (each reflection then shows its
    // own slice, stencil-clipped) — otherwise it gets truncated in mirrors.
    const BR = 0.16;
    const bodyHits = (ri, rj) => showBody &&
      this.camX > rj - BR && this.camX < rj + 1 + BR &&
      this.camZ > ri - BR && this.camZ < ri + 1 + BR;
    const floorMat = { ...FLOOR_MAT, tex: this.tex.floor };
    const glassMat = { ...MIRROR_MAT, tex: this.tex.mirror };
    const solidMat = { ...MIRROR_MAT, alpha: 1, tex: this.tex.mirror };

    r.setClipPlanes([]);
    r.enableCull(false);          // reflections flip winding; the shader is two-sided
    gl.enable(gl.STENCIL_TEST);

    const stamp = (q, func, ref, op) => {
      gl.disable(gl.DEPTH_TEST);
      r.colorMask(false); r.depthMask(false);
      r.stencilFunc(func, ref, 0xFF); r.stencilOp(gl.KEEP, gl.KEEP, op);
      r.setMatrices(proj, view); r.drawQuad(q);
      gl.enable(gl.DEPTH_TEST);
    };

    const drawSelf = (node, level) => {
      r.colorMask(true); r.depthMask(true);
      r.stencilFunc(gl.EQUAL, level, 0xFF); r.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
      // floor
      r.setMatrices(proj, M.multiply(view, M.multiply(node.model, M.translate(M.identity(), node.rj, 0, node.ri))));
      r.setMaterial(floorMat); r.drawMesh(this.unitFloorMesh);
      // solid mirror walls (reflection culled → no void behind)
      for (const w of node.solidWalls) {
        r.setMatrices(proj, view); r.setMaterial(solidMat); r.drawQuad(wallQuad(w.vi, w.vj, w.dir));
      }
      // your body, on every cell its footprint overlaps and every reflected copy
      if (bodyHits(node.ri, node.rj)) {
        let base = M.translate(M.identity(), this.camX, 0, this.camZ);
        base = M.rotateY(base, 180 - this.yaw);
        base = M.scale(base, AVATAR_SCALE, AVATAR_SCALE, AVATAR_SCALE);
        r.stencilFunc(gl.EQUAL, level, 0xFF);
        this.mech.draw(r, proj, view, node.model, base, [], this.walkPhase);
      }
      // markers, only on their own cell
      r.stencilFunc(gl.EQUAL, level, 0xFF); r.depthMask(false);
      if (node.ri === sI && node.rj === sJ) {
        r.setMatrices(proj, M.multiply(view, node.model));
        r.setMaterial({ ...START_MAT, tex: this.tex.start }); r.drawMesh(this.startMesh);
      }
      if (node.ri === eI && node.rj === eJ) {
        r.setMatrices(proj, M.multiply(view, node.model));
        r.setMaterial({ ...END_MAT, tex: this.tex.end }); r.drawMesh(this.endMesh);
      }
      r.depthMask(true);
    };

    const render = (node, level) => {
      if (level > 240) return;                 // stencil is 8-bit; keep well clear
      for (const child of node.children) {
        const d = child.portalDir;
        // Distance from the eye to this portal's plane. When the eye sits on the
        // portal plane (closer than the near clip), the portal quad straddles the
        // near plane and stamps nothing — masking would black out the cell beyond.
        // So draw that cell UNMASKED at this level. This is the doorway directly
        // ahead, but also a SIDE opening when you stand on a cell border: the
        // portal there is to your side (not "forward"), yet its plane runs through
        // the eye just the same, so gate on lateral containment (the eye is within
        // the opening's span across the plane) rather than on facing it.
        const planeC = d.dj ? (d.dj === 1 ? child.portalVj + 1 : child.portalVj)
          : (d.di === 1 ? child.portalVi + 1 : child.portalVi);
        const planeDist = Math.abs((d.dj ? eyeX : eyeZ) - planeC);
        const within = d.dj
          ? eyeZ > child.portalVi && eyeZ < child.portalVi + 1
          : eyeX > child.portalVj && eyeX < child.portalVj + 1;
        if (planeDist < NEAR_DOORWAY && within) { render(child, level); continue; }

        const q = wallQuad(child.portalVi, child.portalVj, child.portalDir);
        stamp(q, gl.EQUAL, level, gl.INCR);    // portal silhouette: level → level+1
        render(child, level + 1);              // draw the subtree, masked to level+1
        if (child.kind === 'wall') {           // mirror glass over the reflection
          r.colorMask(true); r.depthMask(true);
          r.stencilFunc(gl.EQUAL, level + 1, 0xFF); r.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
          r.setMatrices(proj, view); r.setMaterial(glassMat); r.drawQuad(q);
        }
        stamp(q, gl.LESS, level, gl.REPLACE);  // restore the silhouette to level
      }
      drawSelf(node, level);
    };

    render(root, 0);

    gl.disable(gl.STENCIL_TEST);
    r.colorMask(true); r.depthMask(true);
    r.enableCull(true);

    // solution path overlay (cheat) — in the real, un-reflected frame only
    if (this.cheat) {
      r.setMatrices(proj, view);
      r.setMaterial({ base: [1, 1, 0], unlit: true });
      r.drawMesh(this.pathMesh, r.gl.LINE_STRIP);
    }
  }

  _frame(now) {
    const dt = Math.min(0.05, (now - this._last) / 1000);
    this._last = now;
    this._frames = (this._frames || 0) + 1;
    this._update(dt);

    const r = this.r, gl = r.gl, mz = this.maze;
    if (this.state === 'p') this._framePreview(); // re-fit to the live aspect each frame
    const aspect = this.canvas.width / this.canvas.height || 1;
    const far = Math.max(mz.n + mz.m, this.camY + 2);
    // No projection shove: the centre of projection coincides with the rotation
    // pivot (the eye), so the camera turns about itself and sits just in front of
    // the head rather than behind it.
    const proj = M.perspective(FOVY, aspect, NEAR_CLIP, far);
    this._proj = proj;
    this._view = this._viewMatrix();

    const fog = this.state === 'f' ? [this.animT, this.animT, this.animT] : [0, 0, 0];
    r.beginFrame(this.state === 'p' ? [0.06, 0.06, 0.09] : fog);
    r.setLighting(this._lighting());

    mz.wall[1][0] = 0; // entrance open during the render pass
    if (this.state === 'p') this._drawPreview();
    else this._renderSections();
    mz.wall[1][0] = 1;

    if (this.state === 'f') {
      // black box closing in as the screen flashes white
      r.setMatrices(proj, M.multiply(this._view, M.identity()));
      r.setMaterial({ base: [0, 0, 0] });
      r.drawMesh(this.boundaryMesh);
    }
    gl.flush();

    requestAnimationFrame(this._frame);
  }

  _resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.r.resize(w, h, this._dpr);
  }
}
