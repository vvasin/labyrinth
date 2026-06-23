// App: maze lifecycle, camera, collision, and the five-state user journey:
//
//   initial    → no maze; the UI offers fixed size presets to generate one
//   generated  → a readable top-down map of the maze (no path); start or restart
//   started    → first-person play; find the exit or surrender
//   surrendered→ the spot you gave up at + the path from there to the exit
//   finished   → congratulations + the whole solution path
//
// Generation parameters are locked (low branchiness, high twistiness); only the
// size varies, via presets. The whole session — the maze (as N/M/p/q/seed), the
// state, the camera position, the surrender point and the hint layout — persists
// to localStorage, so a reload resumes exactly where you left off. Ported from
// the original preview→play→finish state machine, expanded.

import * as M from './mat4.js';
import { Maze } from './maze.js';
import { Renderer } from './renderer.js';
import { Mech } from './mech.js';
import { unfoldSections } from './unfold.js';
import {
  buildFloor, buildUnitFloor, buildStartWall, buildEndWall,
  buildPathLine, buildPlate, buildDecal, buildHint, buildPathRibbon, wallQuad,
} from './scene.js';
import { floorTexture, mirrorTexture, startTexture, endTexture } from './textures.js';
import {
  loadSettings, saveSettings, loadSession, saveSession, clearSession,
} from './persistence.js';

// The five declared states (see the file header).
export const STATE = {
  INITIAL: 'initial', GENERATED: 'generated', STARTED: 'started',
  SURRENDERED: 'surrendered', FINISHED: 'finished',
};

// Size presets offered in the initial state. `n` is the rooms-per-side (the maze
// grid is 2n+1); the label is what a player intuitively picks.
export const SIZE_PRESETS = [
  { n: 8, label: 'Easy' },
  { n: 12, label: 'Medium' },
  { n: 16, label: 'Hard' },
  { n: 20, label: 'Expert' },
];

// Locked generation knobs: low branchiness (few junctions) + high twistiness
// (long winding corridors) make the best maze, per the design brief.
const GEN_P = 0.9, GEN_Q = 0.1;

const FOVY = 65, RADIUS = 0.24;
const FOG_NEAR_FRAC = 0.35;
const SPOT_CUTOFF = Math.cos((35 * Math.PI) / 180), SPOT_EXP = 40, SPOT_ATTEN = 0.2;
const MOVE_SPEED = 1.9, LOOK_SPEED = 0.22, ANIM_TIME = 1.0;
const LOOK_RATE = 150;
const AVATAR_SCALE = 0.23, EYE_FWD = 0.1, BOB_AMP = 0.02;
const NEAR_CLIP = 0.05, NEAR_DOORWAY = 0.12;

// Hints: glowing pickups dropped in dead ends. Walking onto one reveals the path
// from your spot to the exit for a short while. Count scales with the maze area
// but is capped to the number of dead ends available (done at placement time).
const REVEAL_MS = 6000;
const hintBudget = (N) => Math.max(2, Math.round((N * N) / 50));

const FLOOR_MAT = { base: [0.55, 0.58, 0.72], spec: [0.7, 0.78, 0.95], shininess: 24 };
const MIRROR_MAT = { base: [0.6, 0.68, 0.8], alpha: 0.2, spec: [1.0, 1.0, 1.0], shininess: 90 };
const FOG_TINT = [0.015, 0.022, 0.038];
const START_MAT = { base: [0.95, 0.32, 0.34], emission: [0.85, 0.18, 0.2], spec: [0.8, 0.5, 0.5], shininess: 30, alpha: 0.9 };
const END_MAT = { base: [0.32, 0.95, 0.5], emission: [0.16, 0.8, 0.4], spec: [0.5, 0.8, 0.6], shininess: 30, alpha: 0.9 };
// Overview "wall" base: a dark slab the bright floor channels sit on top of, so
// the map reads clearly as carved-out corridors. The floor texture is reused but
// dimmed almost to black.
const PLATE_MAT = { base: [0.06, 0.07, 0.11], spec: [0.1, 0.12, 0.18], shininess: 8 };
// Floating hint gem + the "you are here" marker on the review maps. Used gems
// fade to a dim grey so the review map shows where every hint sat and which
// were collected.
const HINT_MAT = { base: [0.25, 0.85, 1.0], emission: [0.2, 0.75, 1.0], spec: [1, 1, 1], shininess: 80, alpha: 0.95 };
const HINT_USED_MAT = { base: [0.45, 0.48, 0.56], emission: [0.1, 0.11, 0.14], spec: [0.4, 0.45, 0.55], shininess: 30, alpha: 0.7 };
const YOU_MAT = { base: [1.0, 0.85, 0.3], emission: [1.0, 0.7, 0.15], spec: [1, 1, 1], shininess: 40, alpha: 0.95 };
// The reveal ribbon's flowing pulse (see shaders.js uPathFlow).
const PATH_MAT = { base: [0.1, 0.28, 0.5], emission: [0.25, 0.9, 1.2], pathFlow: true, alpha: 0.95 };

export class App {
  constructor(canvas) {
    this.canvas = canvas;
    this.r = new Renderer(canvas);
    this.maze = new Maze();
    this.mech = new Mech(this.r);

    this.tex = {
      floor: this.r.textureFromCanvas(floorTexture()),
      mirror: this.r.textureFromCanvas(mirrorTexture()),
      start: this.r.textureFromCanvas(startTexture()),
      end: this.r.textureFromCanvas(endTexture()),
    };

    const s = loadSettings();
    this.lastN = s.N;
    this.viewDist = s.viewDist;
    this.unitFloorMesh = this.r.createMesh(buildUnitFloor());
    this.hintMesh = this.r.createMesh(buildHint());
    this.decalMesh = this.r.createMesh(buildDecal());

    this.input = { f: false, b: false, l: false, rt: false, jx: 0, jy: 0, lx: 0, ly: 0 };
    this.walkPhase = 0;
    this.animT = 0;       // fog-in timer at the start of play
    this.bob = 0;
    this.moving = false;
    this._uiState = null;

    // Hint / reveal state.
    this.hints = [];           // [{ i, j, used }]
    this.revealUntil = 0;      // epoch ms; an active path reveal ends at this time
    this._revealKey = null;    // cell the current reveal ribbon was built from
    this.revealMesh = null;
    this.reviewPathMesh = null; // path drawn on the surrendered/finished maps
    this.surrenderAt = null;    // { x, z } world position the player gave up at

    this._restoreOrInit();

    this._dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._resize();
    window.addEventListener('resize', () => this._resize());
    // Persist on the way out (tab hide / close) so an interrupted game resumes.
    const flush = () => this._save();
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

    this._last = performance.now();
    this._saveAccum = 0;
    this._frame = this._frame.bind(this);
    requestAnimationFrame(this._frame);
  }

  // --- session restore / boot --------------------------------------------
  _restoreOrInit() {
    const sess = loadSession();
    if (sess && this._restore(sess)) return;
    // Fresh: build a default maze so meshes exist, but show the initial chooser.
    this.maze.generate(this.lastN, this.lastN, GEN_P, GEN_Q);
    this._rebuild();
    this.state = STATE.INITIAL;
    this._frameOverview();
  }

  _restore(sess) {
    try {
      const m = sess.maze || {};
      const ok = [m.N, m.M, m.seed].every((v) => Number.isFinite(v));
      if (!ok || !Object.values(STATE).includes(sess.state)) return false;
      this.maze.generate(m.N, m.M, GEN_P, GEN_Q, m.seed >>> 0);
      this._rebuild();
      this.lastN = m.N;
      this.hints = Array.isArray(sess.hints)
        ? sess.hints.filter((h) => Number.isFinite(h.i) && Number.isFinite(h.j))
          .map((h) => ({ i: h.i | 0, j: h.j | 0, used: !!h.used }))
        : [];
      this.revealUntil = Number.isFinite(sess.revealUntil) ? sess.revealUntil : 0;
      this.surrenderAt = sess.surrender || null;
      this.state = sess.state;

      if (this.state === STATE.STARTED) {
        const c = sess.cam || {};
        this.camX = c.x ?? 1.5; this.camY = c.y ?? 0.5; this.camZ = c.z ?? 1.5;
        this.yaw = c.yaw ?? 90; this.pitch = c.pitch ?? 0;
        this.animT = 1; // skip the fog-in on resume
      } else if (this.state === STATE.SURRENDERED) {
        this._buildReview(this.surrenderAt);
        this._frameOverview();
      } else if (this.state === STATE.FINISHED) {
        this._buildReview(null);
        this._frameOverview();
      } else { // generated / initial
        this._frameOverview();
      }
      return true;
    } catch {
      return false;
    }
  }

  // --- maze + meshes ------------------------------------------------------
  _rebuild() {
    const r = this.r, mz = this.maze;
    mz.wall[1][0] = 0; // open the entrance so the floor tile & side walls read right
    this.floorMesh = r.createMesh(buildFloor(mz));
    mz.wall[1][0] = 1;
    this.plateMesh = r.createMesh(buildPlate(mz));
    this.startMesh = r.createMesh(buildStartWall());
    this.endMesh = r.createMesh(buildEndWall(mz));
  }

  // Choose hint cells: a random subset of the dead ends, sized to the maze.
  _placeHints() {
    const dead = this.maze.deadEnds();
    for (let i = dead.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [dead[i], dead[j]] = [dead[j], dead[i]];
    }
    const count = Math.min(hintBudget(this.maze.N), dead.length);
    this.hints = dead.slice(0, count).map((c) => ({ i: c.x, j: c.y, used: false }));
    this.revealUntil = 0;
    this._dropReveal();
  }

  // --- state transitions --------------------------------------------------
  newGame(n) {
    const N = Math.max(3, Math.min(40, n | 0));
    this.lastN = N;
    this.maze.generate(N, N, GEN_P, GEN_Q);
    this._rebuild();
    this._placeHints();
    this.surrenderAt = null;
    this._dropReview();
    this.state = STATE.GENERATED;
    this._frameOverview();
    this._save();
  }

  // From the generated map, drop into first-person at the entrance, facing into
  // the maze (not at the entrance wall).
  startGame() {
    if (this.state !== STATE.GENERATED) return;
    this.camX = 1.5; this.camY = 0.5; this.camZ = 1.5;
    this.pitch = 0; this.yaw = this._entranceYaw();
    this.animT = 0; // run the fog-in
    this.bob = 0;
    this.state = STATE.STARTED;
    this._save();
  }

  // Yaw that faces the first open interior passage out of the start room.
  _entranceYaw() {
    const w = this.maze.wall;
    if (!w[1][2]) return 90;   // +X
    if (!w[2][1]) return 180;  // +Z
    if (!w[0][1]) return 0;    // -Z
    return 90;
  }

  surrender() {
    if (this.state !== STATE.STARTED) return;
    this.surrenderAt = { x: this.camX, z: this.camZ };
    this._dropReveal();
    this._buildReview(this.surrenderAt);
    this.state = STATE.SURRENDERED;
    this._frameOverview();
    this._save();
  }

  _finish() {
    if (this.state !== STATE.STARTED) return;
    this.surrenderAt = null;
    this._dropReveal();
    this._buildReview(null);
    this.state = STATE.FINISHED;
    this._frameOverview();
    this._save();
  }

  // Restart the whole journey: back to the size chooser. A fresh maze is rolled
  // so the next "generate" is a clean slate.
  toInitial() {
    this._dropReveal();
    this._dropReview();
    this.surrenderAt = null;
    this.hints = [];
    this.state = STATE.INITIAL;
    this.maze.generate(this.lastN, this.lastN, GEN_P, GEN_Q);
    this._rebuild();
    this._frameOverview();
    clearSession();
  }

  setViewDist(d) {
    this.viewDist = Math.max(4, Math.min(16, d | 0));
    saveSettings({ N: this.lastN, viewDist: this.viewDist });
  }

  // --- review (surrendered / finished) maps ------------------------------
  _buildReview(from) {
    const mz = this.maze;
    const cells = from
      ? mz.pathFrom(Math.floor(from.z), Math.floor(from.x))
      : mz.solutionPath();
    this._dropReview();
    this.reviewPathMesh = this.r.createMesh(buildPathLine(cells));
    // Where to plant the "you" marker: the surrender spot, or the exit on a win.
    this._youAt = from
      ? { x: from.x, z: from.z }
      : { x: mz.m - 1.5, z: mz.n - 1.5 };
  }

  _dropReview() {
    if (this.reviewPathMesh) { this.r.gl.deleteBuffer(this.reviewPathMesh.buf); this.reviewPathMesh = null; }
  }

  _dropReveal() {
    if (this.revealMesh) { this.r.gl.deleteBuffer(this.revealMesh.buf); this.revealMesh = null; }
    this._revealKey = null;
  }

  // --- persistence --------------------------------------------------------
  _save() {
    const mz = this.maze;
    saveSettings({ N: this.lastN, viewDist: this.viewDist });
    if (this.state === STATE.INITIAL) { clearSession(); return; }
    saveSession({
      maze: { N: mz.N, M: mz.M, p: mz.p, q: mz.q, seed: mz.seed },
      state: this.state,
      cam: this.state === STATE.STARTED
        ? { x: this.camX, y: this.camY, z: this.camZ, yaw: this.yaw, pitch: this.pitch }
        : null,
      surrender: this.surrenderAt,
      hints: this.hints,
      revealUntil: this.revealUntil,
    });
  }

  // --- camera & movement --------------------------------------------------
  _parseMove() {
    const mz = this.maze, w = mz.wall, r = RADIUS;
    let ix = this.camX | 0, iz = this.camZ | 0;
    let t;
    t = Math.floor(this.camZ - r); if (w[t]?.[ix]) this.camZ = t + r + 1;
    t = Math.floor(this.camZ + r); if (w[t]?.[ix]) this.camZ = t - r;
    t = Math.floor(this.camX - r); if (w[iz]?.[t]) this.camX = t + r + 1;
    t = Math.floor(this.camX + r); if (w[iz]?.[t]) this.camX = t - r;
    ix = this.camX | 0; iz = this.camZ | 0;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      if (!w[iz + sz]?.[ix + sx]) continue;
      if (w[iz]?.[ix + sx] || w[iz + sz]?.[ix]) continue;
      const cx = sx < 0 ? ix : ix + 1, cz = sz < 0 ? iz : iz + 1;
      const dx = this.camX - cx, dz = this.camZ - cz, d = Math.hypot(dx, dz);
      if (d < r && d > 1e-6) { this.camX = cx + (dx / d) * r; this.camZ = cz + (dz / d) * r; }
    }
    this._collectHint(iz, ix);
    if (ix === mz.m - 1 && iz === mz.n - 2) this._finish();
  }

  // Walking onto an unused hint cell collects it and reveals the path from here.
  _collectHint(iz, ix) {
    for (const h of this.hints) {
      if (h.used || h.i !== iz || h.j !== ix) continue;
      h.used = true;
      this.revealUntil = Date.now() + REVEAL_MS;
      this._dropReveal();          // force a rebuild from the current cell
      this._save();
    }
  }

  look(dx, dy) {
    if (this.state !== STATE.STARTED) return;
    this.pitch = Math.max(-90, Math.min(90, this.pitch + dy * LOOK_SPEED));
    this.yaw -= dx * LOOK_SPEED;
  }

  _look(dt) {
    if (this.state !== STATE.STARTED) return;
    const i = this.input;
    if (i.lx === 0 && i.ly === 0) return;
    this.yaw += i.lx * LOOK_RATE * dt;
    this.pitch = Math.max(-90, Math.min(90, this.pitch - i.ly * LOOK_RATE * dt));
  }

  _move(dt) {
    this.moving = false;
    if (this.state !== STATE.STARTED) return;
    const i = this.input;
    const fwd = (i.f ? 1 : 0) - (i.b ? 1 : 0) - i.jy;
    const str = (i.l ? 1 : 0) - (i.rt ? 1 : 0) - i.jx;
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
    if (this.state === STATE.STARTED && this.animT < 1) {
      this.animT = Math.min(1, this.animT + dt / ANIM_TIME);
    }
    this._move(dt);
    this._look(dt);
    const target = this.moving ? Math.abs(Math.sin(this.walkPhase)) * BOB_AMP : 0;
    this.bob += (target - this.bob) * Math.min(1, dt * 12);
    // Throttled autosave while playing, so an unexpected reload loses little.
    if (this.state === STATE.STARTED) {
      this._saveAccum += dt;
      if (this._saveAccum > 1.5) { this._saveAccum = 0; this._save(); }
    }
  }

  _lighting() {
    const view = this._viewMatrix();
    const l0 = M.transformVec4(view, [-1.5, 0.5, -1.0, 0]);
    const len = Math.hypot(l0[0], l0[1], l0[2]) || 1;
    const dir = [l0[0] / len, l0[1] / len, l0[2] / len];
    const flat = this.state !== STATE.STARTED; // overview/initial are flat & bright
    let fogColor = flat ? [0, 0, 0] : FOG_TINT.slice(), fogOn = !flat;
    let fogStart = this.viewDist * FOG_NEAR_FRAC, fogEnd = this.viewDist - 0.5;
    if (this.state === STATE.STARTED && this.animT < 1) {
      fogStart *= this.animT; fogEnd *= this.animT;
    }
    const flick = flat ? 1 : 0.92 + 0.08 * Math.sin(performance.now() * 0.011)
      + 0.03 * Math.sin(performance.now() * 0.047);
    return {
      ambient: flat ? [0.5, 0.52, 0.6] : [0.07, 0.09, 0.14],
      light0Dir: dir,
      light0Color: flat ? [0.95, 0.95, 1.05] : [0.16, 0.2, 0.32],
      spotOn: !flat,
      spotColor: [1.08 * flick, 0.9 * flick, 0.64 * flick],
      spotCutoff: SPOT_CUTOFF, spotExp: SPOT_EXP, spotAtten: SPOT_ATTEN,
      fogOn, fogColor, fogStart, fogEnd,
    };
  }

  // Top-down framing for the overview / review maps.
  _frameOverview() {
    const mz = this.maze;
    const aspect = this.canvas.width / this.canvas.height || 1;
    const t = Math.tan((FOVY * Math.PI) / 360);
    this.camX = mz.m / 2;
    this.camZ = mz.n / 2;
    this.camY = Math.max((mz.n / 2 + 1) / t, (mz.m / 2 + 1) / (t * aspect));
    this.pitch = -90; this.yaw = 0; this.bob = 0;
  }

  _viewMatrix() {
    const ya = (this.yaw * Math.PI) / 180;
    const ex = this.camX + EYE_FWD * Math.sin(ya);
    const ez = this.camZ - EYE_FWD * Math.cos(ya);
    let v = M.rotateX(M.identity(), -this.pitch);
    v = M.rotateY(v, this.yaw);
    v = M.translate(v, -ex, -(this.camY + this.bob), -ez);
    return v;
  }

  // --- rendering ----------------------------------------------------------
  // Readable top-down map: a dark wall slab with the open corridors as bright
  // floor channels, the start/exit emblems, and (on review maps) the route plus
  // a "you are here" marker. No mirrors, no fog.
  _drawOverview() {
    const r = this.r, proj = this._proj, view = this._view, mz = this.maze;
    r.setClipPlanes([]);
    r.enableCull(true);

    // Dark base then the floor channels lifted just above it (avoids z-fight).
    r.setMatrices(proj, view);
    r.setMaterial({ ...PLATE_MAT, tex: this.tex.floor });
    r.drawMesh(this.plateMesh);
    r.setMatrices(proj, M.translate(view, 0, 0.02, 0));
    r.setMaterial({ ...FLOOR_MAT, tex: this.tex.floor });
    r.drawMesh(this.floorMesh);

    // Start / exit emblems, stamped flat on the floor on the border opening
    // cells — one cell outside the start/exit rooms, where you actually enter
    // and leave the maze.
    r.depthMask(false);
    const decal = (cx, cz, mat, tex) => {
      let m = M.translate(view, cx, 0.04, cz);
      m = M.scale(m, 0.8, 1, 0.8);
      r.setMatrices(proj, m);
      r.setMaterial({ ...mat, tex, emission: mat.emission, alpha: 1 });
      r.drawMesh(this.decalMesh);
    };
    decal(0.5, 1.5, START_MAT, this.tex.start);       // entrance border cell (1,0)
    decal(mz.m - 0.5, mz.n - 1.5, END_MAT, this.tex.end); // exit border cell (n-2, m-1)

    // Review overlays: the path and the marker for where the player stands.
    if (this.reviewPathMesh) {
      r.setMatrices(proj, view);
      r.setMaterial({ base: [1, 0.95, 0.3], unlit: true });
      r.drawMesh(this.reviewPathMesh, r.gl.LINE_STRIP);
    }
    if (this._youAt && (this.state === STATE.SURRENDERED || this.state === STATE.FINISHED)) {
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.005);
      let m = M.translate(view, this._youAt.x, 0.06, this._youAt.z);
      m = M.scale(m, 0.5 + 0.12 * pulse, 1, 0.5 + 0.12 * pulse);
      r.setMatrices(proj, m);
      r.setMaterial({ ...YOU_MAT, tex: this.tex.start });
      r.drawMesh(this.decalMesh);
    }
    r.depthMask(true);

    // On the review maps, show where every hint sat — bright cyan if untouched,
    // faded grey once collected — as little floating gems above the path.
    if (this.state === STATE.SURRENDERED || this.state === STATE.FINISHED) {
      const t = performance.now() * 0.001;
      for (const h of this.hints) {
        let m = M.translate(view, h.j + 0.5, 0.18, h.i + 0.5);
        m = M.rotateY(m, t * 50);
        m = M.scale(m, 0.18, 0.18, 0.18);
        r.setMatrices(proj, m);
        r.setMaterial(h.used ? HINT_USED_MAT : HINT_MAT);
        r.drawMesh(this.hintMesh);
      }
    }
  }

  // First-person: the recursive portal unfolding (mirror walls).
  _renderSections() {
    const r = this.r, gl = r.gl, proj = this._proj, view = this._view, mz = this.maze;
    const aspect = this.canvas.width / this.canvas.height || 1;
    const ya = (this.yaw * Math.PI) / 180;
    const eyeX = this.camX + EYE_FWD * Math.sin(ya), eyeZ = this.camZ - EYE_FWD * Math.cos(ya);
    const { root } = unfoldSections({
      maze: mz, camX: this.camX, camZ: this.camZ, yaw: this.yaw, pitch: this.pitch,
      eyeX, eyeZ, viewDist: this.viewDist, fovy: FOVY, aspect,
      minHalf: Math.PI / 2,
    });

    const sI = 1, sJ = 1;
    const eI = mz.n - 2, eJ = mz.m - 2;
    const showBody = this.state === STATE.STARTED;
    const BR = 0.16;
    const bodyHits = (ri, rj) => showBody &&
      this.camX > rj - BR && this.camX < rj + 1 + BR &&
      this.camZ > ri - BR && this.camZ < ri + 1 + BR;
    const floorMat = { ...FLOOR_MAT, tex: this.tex.floor };
    const glassMat = { ...MIRROR_MAT, tex: this.tex.mirror };
    const solidMat = { ...MIRROR_MAT, alpha: 1, tex: this.tex.mirror };
    const tsec = performance.now() * 0.001;

    r.setClipPlanes([]);
    r.enableCull(false);
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
      r.setMatrices(proj, M.multiply(view, M.multiply(node.model, M.translate(M.identity(), node.rj, 0, node.ri))));
      r.setMaterial(floorMat); r.drawMesh(this.unitFloorMesh);
      for (const w of node.solidWalls) {
        r.setMatrices(proj, view); r.setMaterial(solidMat); r.drawQuad(wallQuad(w.vi, w.vj, w.dir));
      }
      if (bodyHits(node.ri, node.rj)) {
        let base = M.translate(M.identity(), this.camX, 0, this.camZ);
        base = M.rotateY(base, 180 - this.yaw);
        base = M.scale(base, AVATAR_SCALE, AVATAR_SCALE, AVATAR_SCALE);
        r.stencilFunc(gl.EQUAL, level, 0xFF);
        this.mech.draw(r, proj, view, node.model, base, [], this.walkPhase);
      }
      r.stencilFunc(gl.EQUAL, level, 0xFF); r.depthMask(false);
      if (node.ri === sI && node.rj === sJ) {
        r.setMatrices(proj, M.multiply(view, node.model));
        r.setMaterial({ ...START_MAT, tex: this.tex.start }); r.drawMesh(this.startMesh);
      }
      if (node.ri === eI && node.rj === eJ) {
        r.setMatrices(proj, M.multiply(view, node.model));
        r.setMaterial({ ...END_MAT, tex: this.tex.end }); r.drawMesh(this.endMesh);
      }
      // Floating hint gems, drawn through the reflection so they appear in mirrors.
      for (const h of this.hints) {
        if (h.used || node.ri !== h.i || node.rj !== h.j) continue;
        let base = M.translate(M.identity(), h.j + 0.5, 0.5 + Math.sin(tsec * 2) * 0.06, h.i + 0.5);
        base = M.rotateY(base, tsec * 60);
        base = M.scale(base, 0.13, 0.18, 0.13);
        r.stencilFunc(gl.EQUAL, level, 0xFF);
        r.setMatrices(proj, M.multiply(view, M.multiply(node.model, base)));
        r.setMaterial(HINT_MAT); r.drawMesh(this.hintMesh);
      }
      r.depthMask(true);
    };

    const render = (node, level) => {
      if (level > 240) return;
      for (const child of node.children) {
        const d = child.portalDir;
        const planeC = d.dj ? (d.dj === 1 ? child.portalVj + 1 : child.portalVj)
          : (d.di === 1 ? child.portalVi + 1 : child.portalVi);
        const planeDist = Math.abs((d.dj ? eyeX : eyeZ) - planeC);
        const within = d.dj
          ? eyeZ > child.portalVi && eyeZ < child.portalVi + 1
          : eyeX > child.portalVj && eyeX < child.portalVj + 1;
        if (planeDist < NEAR_DOORWAY && within) { render(child, level); continue; }

        const q = wallQuad(child.portalVi, child.portalVj, child.portalDir);
        stamp(q, gl.EQUAL, level, gl.INCR);
        render(child, level + 1);
        if (child.kind === 'wall') {
          r.colorMask(true); r.depthMask(true);
          r.stencilFunc(gl.EQUAL, level + 1, 0xFF); r.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
          r.setMatrices(proj, view); r.setMaterial(glassMat); r.drawQuad(q);
        }
        stamp(q, gl.LESS, level, gl.REPLACE);
      }
      drawSelf(node, level);
    };

    render(root, 0);

    gl.disable(gl.STENCIL_TEST);
    r.colorMask(true); r.depthMask(true);
    r.enableCull(true);

    // The hint reveal: a flowing, fog-dimmed ribbon in the real (un-reflected)
    // frame, from the player's cell to the exit.
    this._drawReveal();
  }

  _drawReveal() {
    if (Date.now() >= this.revealUntil) { if (this.revealMesh) this._dropReveal(); return; }
    const r = this.r, mz = this.maze;
    const ci = this.camZ | 0, cj = this.camX | 0;
    const key = ci * 100000 + cj;
    if (key !== this._revealKey || !this.revealMesh) {
      if (this.revealMesh) r.gl.deleteBuffer(this.revealMesh.buf);
      this.revealMesh = r.createMesh(buildPathRibbon(mz.pathFrom(ci, cj)));
      this._revealKey = key;
    }
    if (!this.revealMesh.count) return;
    r.enableCull(false);
    r.depthMask(false);
    r.setMatrices(this._proj, this._view);
    r.setMaterial(PATH_MAT);
    r.drawMesh(this.revealMesh);
    r.depthMask(true);
    r.enableCull(true);
  }

  _frame(now) {
    const dt = Math.min(0.05, (now - this._last) / 1000);
    this._last = now;
    this._frames = (this._frames || 0) + 1;
    this._update(dt);

    if (this.state !== this._uiState) {
      this._uiState = this.state;
      this.onStateChange?.(this.state);
    }
    // Live HUD (hints left + reveal countdown) while playing.
    if (this.state === STATE.STARTED) {
      this.onHud?.({
        hintsLeft: this.hints.filter((h) => !h.used).length,
        revealMs: Math.max(0, this.revealUntil - Date.now()),
      });
    }

    const r = this.r, gl = r.gl, mz = this.maze;
    const flat = this.state !== STATE.STARTED;
    if (flat) this._frameOverview();
    const aspect = this.canvas.width / this.canvas.height || 1;
    const far = Math.max(mz.n + mz.m, this.camY + 2);
    this._proj = M.perspective(FOVY, aspect, NEAR_CLIP, far);
    this._view = this._viewMatrix();

    const clear = this.state === STATE.STARTED ? FOG_TINT : [0.04, 0.05, 0.08];
    r.beginFrame(clear);
    r.setLighting(this._lighting());

    if (this.state === STATE.INITIAL) {
      // Nothing to draw; the chooser overlay sits on the cleared background.
    } else if (this.state === STATE.STARTED) {
      mz.wall[1][0] = 0;
      this._renderSections();
      mz.wall[1][0] = 1;
    } else {
      this._drawOverview();
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
