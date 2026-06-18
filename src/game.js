// App: maze lifecycle, camera, collision, the preview→play→finish state
// machine, lighting per mode, and the render loop that drives the mirror
// recursion. Ported from labyrinth.c / display / game / control modules, with
// the desktop-only frame recorder dropped.

import * as M from './mat4.js';
import { Maze } from './maze.js';
import { Renderer } from './renderer.js';
import { Mech } from './mech.js';
import { drawMirrors } from './mirrors.js';
import {
  buildFloor, buildStartWall, buildEndWall, buildBoundary,
  buildPathLine,
} from './scene.js';
import { loadSettings, saveSettings } from './persistence.js';

const FOVY = 65, RADIUS = 0.24, FOG_START = 1, FOG_END = 3;
const SPOT_CUTOFF = Math.cos((35 * Math.PI) / 180), SPOT_EXP = 40, SPOT_ATTEN = 0.2;
const MOVE_SPEED = 1.9, LOOK_SPEED = 0.22, ANIM_TIME = 1.0;
// First-person avatar: camX/camZ is the actor's body centre — the vertical yaw
// axis and the collision point. The eye sits EYE_FWD in front of that axis (at
// the actor's "eyes"), so the body never blocks the forward view yet stays
// right behind the camera. AVATAR_SCALE puts the head just below eye level;
// BOB_AMP is the walk-driven head bob applied to the eye.
const AVATAR_SCALE = 0.23, EYE_FWD = 0.1, BOB_AMP = 0.02;

const FLOOR_MAT = { base: [0.78, 0.74, 0.95], spec: [0.5, 0.42, 0.42], shininess: 10 };
const MIRROR_MAT = { base: [0.62, 0.66, 0.72], alpha: 0.45, spec: [0.9, 0.9, 0.9], shininess: 60 };
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
    this.maxDepth = s.maxDepth;
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

  setDepth(d) { this.maxDepth = d | 0; this._save(); }

  _save() {
    saveSettings({
      N: this.maze.N, M: this.maze.M, p: this.maze.p, q: this.maze.q, maxDepth: this.maxDepth,
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
    const ix = this.camX | 0, iz = this.camZ | 0;
    let t;
    t = Math.floor(this.camZ - r); if (w[t]?.[ix]) this.camZ = t + r + 1;
    t = Math.floor(this.camZ + r); if (w[t]?.[ix]) this.camZ = t - r;
    t = Math.floor(this.camX - r); if (w[iz]?.[t]) this.camX = t + r + 1;
    t = Math.floor(this.camX + r); if (w[iz]?.[t]) this.camX = t - r;
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
    let fogColor = [0, 0, 0], fogStart = FOG_START, fogEnd = FOG_END, fogOn = !preview;
    if (this.state === 's') { fogStart = FOG_START * this.animT; fogEnd = FOG_END * this.animT; }
    if (this.state === 'f') {
      const t = this.animT;
      fogColor = [t, t, t];
      fogStart = FOG_START * (1 - t); fogEnd = FOG_END * (1 - t);
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
  _drawScene(model, clips, _depth) {
    const r = this.r, proj = this._proj, view = this._view;
    r.setClipPlanes(clips);

    // floor
    r.setMatrices(proj, M.multiply(view, model));
    r.setMaterial({ ...FLOOR_MAT, tex: this.tex.floor });
    r.drawMesh(this.floorMesh);

    // mech — the player's own body, drawn at every level so it shows both in the
    // direct first-person view and reflected in the mirror walls. It stands on
    // its body axis (camX,camZ) and rotates in place about it; the eye sits just
    // in front, so the head stays out of the forward view but the torso, arms and
    // legs swing into frame when you look down.
    if (this.state === 's' || this.state === 'g' || this.state === 'f') {
      r.enableCull(false);
      let base = M.translate(M.identity(), this.camX, 0, this.camZ);
      base = M.rotateY(base, 180 - this.yaw);
      base = M.scale(base, AVATAR_SCALE, AVATAR_SCALE, AVATAR_SCALE);
      this.mech.draw(r, proj, view, model, base, clips, this.walkPhase);
      r.enableCull(true);
    }

    // colored start/end markers — overlay (no depth write), like COLOR_WALLS
    r.depthMask(false);
    r.setMatrices(proj, M.multiply(view, model));
    r.setMaterial({ ...START_MAT, tex: this.tex.start });
    r.drawMesh(this.startMesh);
    r.setMaterial({ ...END_MAT, tex: this.tex.end });
    r.drawMesh(this.endMesh);
    r.depthMask(true);

    // solution path
    if (this.state === 'p' || this.cheat) {
      r.setMatrices(proj, M.multiply(view, model));
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
    const proj = M.perspective(FOVY, aspect, 0.1, far);
    this._proj = proj;
    this._view = this._viewMatrix();

    const fog = this.state === 'f' ? [this.animT, this.animT, this.animT] : [0, 0, 0];
    r.beginFrame(this.state === 'p' ? [0.06, 0.06, 0.09] : fog);
    r.setLighting(this._lighting());

    mz.wall[1][0] = 0; // entrance open during the render pass
    drawMirrors({
      r, proj, view: this._view, maze: mz, range: FOG_END,
      camX: this.camX, camZ: this.camZ,
      // maxDepth is interpreted as a reflection DISTANCE budget (in cells): a
      // mirror reflects only while the wall behind it is within this many cells
      // of optical path. A distance (not a count) keeps walls from flickering
      // between mirror and solid as the camera moves.
      reflectDist: this.maxDepth,
      mirrorMat: { ...MIRROR_MAT, tex: this.tex.mirror },
      mirrorOpaque: { ...MIRROR_MAT, alpha: 1, tex: this.tex.mirror },
      drawScene: (model, clips, depth) => this._drawScene(model, clips, depth),
    });
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
