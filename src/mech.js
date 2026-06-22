// The player avatar. The original linked in glutmech — a 700-line articulated
// battlemech. In first person you never see yourself directly, so the avatar's
// whole job is to look right reflected in the mirror-walls. We keep that spirit
// with a compact box-built walker whose legs/arms swing on a walk phase, rather
// than porting the full joint hierarchy.
//
// Local space: feet at y≈0, "up" is +Y, facing +Z; the caller's placement
// matrix carries the world position, heading, and overall scale.

import * as M from './mat4.js';

function unitCube() {
  const f = [];
  const face = (nx, ny, nz, verts) => {
    const [a, b, c, d] = verts;
    const mk = (p, u, v) => [...p, nx, ny, nz, u, v];
    f.push(mk(a, 0, 0), mk(b, 1, 0), mk(c, 1, 1), mk(a, 0, 0), mk(c, 1, 1), mk(d, 0, 1));
  };
  const h = 0.5;
  face(0, 0, 1, [[-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]]);
  face(0, 0, -1, [[h, -h, -h], [-h, -h, -h], [-h, h, -h], [h, h, -h]]);
  face(1, 0, 0, [[h, -h, h], [h, -h, -h], [h, h, -h], [h, h, h]]);
  face(-1, 0, 0, [[-h, -h, -h], [-h, -h, h], [-h, h, h], [-h, h, -h]]);
  face(0, 1, 0, [[-h, h, h], [h, h, h], [h, h, -h], [-h, h, -h]]);
  face(0, -1, 0, [[-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h]]);
  return new Float32Array(f.flat());
}

const MATERIALS = {
  // Brushed gunmetal plating, warm amber joint actuators, and a glowing cyan
  // visor head — high spec so it catches the flashlight and reads in mirrors.
  body: { base: [0.32, 0.36, 0.44], spec: [0.85, 0.9, 1.0], shininess: 64 },
  joint: { base: [0.85, 0.45, 0.16], emission: [0.18, 0.07, 0.0], spec: [0.9, 0.7, 0.4], shininess: 40 },
  head: { base: [0.2, 0.7, 0.85], emission: [0.1, 0.5, 0.65], spec: [0.95, 1.0, 1.0], shininess: 90 },
};

export class Mech {
  constructor(renderer) {
    this.mesh = renderer.createMesh(unitCube());
  }

  // `place` already includes world position, heading, and scale; `phase`
  // drives the gait.
  draw(r, proj, view, accumModel, place, clips, phase) {
    r.setClipPlanes(clips);
    const swingA = Math.sin(phase) * 26;          // arms
    const swingB = Math.sin(phase + Math.PI) * 26;
    const legA = Math.sin(phase + Math.PI) * 26;  // legs opposite arms
    const legB = Math.sin(phase) * 26;
    const bob = Math.abs(Math.sin(phase)) * 0.05;

    const pelvis = M.translate(place, 0, 1.18 + bob, 0);

    const part = (local, sx, sy, sz, mat) => {
      const model = M.multiply(accumModel, M.multiply(local, M.scale(M.identity(), sx, sy, sz)));
      r.setMatrices(proj, M.multiply(view, model));
      r.setMaterial(mat);
      r.drawMesh(this.mesh);
    };

    // torso, shoulders, head
    part(M.translate(pelvis, 0, 0.3, 0), 0.42, 0.6, 0.26, MATERIALS.body);
    part(M.translate(pelvis, 0, 0.62, 0), 0.62, 0.12, 0.22, MATERIALS.body);
    part(M.translate(pelvis, 0, 0.86, 0.02), 0.2, 0.2, 0.2, MATERIALS.head);

    // arms — pivot at the shoulder
    for (const side of [-1, 1]) {
      const shoulder = M.translate(pelvis, side * 0.34, 0.6, 0);
      const swung = M.rotateX(shoulder, side < 0 ? swingA : swingB);
      part(M.translate(swung, 0, -0.3, 0), 0.13, 0.56, 0.13, MATERIALS.body);
      part(M.translate(swung, 0, -0.6, 0.04), 0.16, 0.14, 0.18, MATERIALS.joint);
    }

    // legs — pivot at the hip
    for (const side of [-1, 1]) {
      const hip = M.translate(pelvis, side * 0.15, -0.05, 0);
      const swung = M.rotateX(hip, side < 0 ? legA : legB);
      part(M.translate(swung, 0, -0.45, 0), 0.17, 0.7, 0.17, MATERIALS.body);
      part(M.translate(swung, 0, -0.85, 0.05), 0.2, 0.12, 0.28, MATERIALS.joint);
    }
  }
}
