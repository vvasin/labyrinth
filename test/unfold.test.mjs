// Unit test for the recursive portal unfolding (src/unfold.js). No renderer:
// this verifies which sections get drawn, in what order, with which parameters
// (reference real cell, mirrored, body) and how they are culled.
//
//   npm run test:unit

import assert from 'node:assert/strict';
import { unfoldSections } from '../src/unfold.js';

// Build a maze.wall grid from rows of '0' (open) / '1' (wall). Row index i is Z,
// column index j is X — matching the renderer's convention.
function maze(rows) {
  const wall = rows.map((r) => [...r].map((c) => (c === '1' ? 1 : 0)));
  return { wall, n: wall.length, m: wall[0].length };
}

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('ok   ' + name); pass++; }
  catch (e) { console.error('FAIL ' + name + '\n     ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n     ')); fail++; }
}

// A 3×3 open room (rows/cols 1..3) walled in. Eye in the centre cell (2,2).
const ROOM = maze([
  '11111',
  '10001',
  '10001',
  '10001',
  '11111',
]);

// --- straight-ahead chain: opening → wall → reflection, with body tracking ---
// Narrow FOV facing +X so only the forward axis (vi === 2) survives; this
// isolates the hall-of-mirrors down the +X corridor.
test('opening then wall reflection, reference + mirrored + body track correctly', () => {
  const { draws } = unfoldSections({
    maze: ROOM, camX: 2.5, camZ: 2.5, yaw: 90, // forward = +X
    viewDist: 5, fovy: 10, aspect: 1,
  });
  const line = draws.filter((d) => d.vi === 2).sort((a, b) => a.vj - b.vj)
    .map((d) => ({ vj: d.vj, ri: d.ri, rj: d.rj, mirrored: d.mirrored, body: d.hasBody, kind: d.kind }));

  assert.deepEqual(line, [
    { vj: 2, ri: 2, rj: 2, mirrored: false, body: true, kind: 'start' },   // the eye
    { vj: 3, ri: 2, rj: 3, mirrored: false, body: false, kind: 'opening' },// real neighbour
    { vj: 4, ri: 2, rj: 3, mirrored: true, body: false, kind: 'wall' },    // reflection of (2,3)
    { vj: 5, ri: 2, rj: 2, mirrored: true, body: true, kind: 'opening' },  // reflected copy of the eye's cell → body
    { vj: 6, ri: 2, rj: 1, mirrored: true, body: false, kind: 'opening' },
    { vj: 7, ri: 2, rj: 1, mirrored: false, body: false, kind: 'wall' },   // 2nd reflection flips parity back
  ]);
});

// --- distance cull -----------------------------------------------------------
test('sections beyond the view distance are culled (cull = distance)', () => {
  const { visits } = unfoldSections({
    maze: ROOM, camX: 2.5, camZ: 2.5, yaw: 90, viewDist: 5, fovy: 10, aspect: 1,
  });
  // (2,8) centre is 6.0 from the eye → beyond viewDist 5.
  const far = visits.find((v) => v.vi === 2 && v.vj === 8);
  assert.ok(far, 'the far cell was considered');
  assert.equal(far.drawn, false);
  assert.equal(far.cull, 'distance');
});

// --- angle cull keeps the reference it WOULD have drawn ----------------------
test('a side outside the view sector is culled (cull = angle) but keeps its reference', () => {
  const { visits } = unfoldSections({
    maze: ROOM, camX: 2.5, camZ: 2.5, yaw: 90, viewDist: 5, fovy: 10, aspect: 1,
  });
  // Facing +X with a narrow cone, the eye's side neighbour (2,1) (straight left,
  // i.e. behind/left of the cone) must be angle-culled.
  const left = visits.find((v) => v.vi === 2 && v.vj === 1 && v.depth === 1);
  assert.ok(left, 'the left side was considered');
  assert.equal(left.drawn, false);
  assert.equal(left.cull, 'angle');
  assert.equal(left.ri, 2); assert.equal(left.rj, 1); // still reports its reference cell
});

// --- the body is only on sections whose reference is the eye's cell ----------
test('body flag follows the reference cell, not the path', () => {
  const { draws } = unfoldSections({
    maze: ROOM, camX: 2.5, camZ: 2.5, yaw: 90, viewDist: 5, fovy: 10, aspect: 1,
  });
  for (const d of draws) {
    assert.equal(d.hasBody, d.ri === 2 && d.rj === 2,
      `section v(${d.vi},${d.vj}) ref(${d.ri},${d.rj}) body=${d.hasBody}`);
  }
});

// --- NO dedup: one virtual cell reached by two portals is drawn twice --------
test('no virtual-cell dedup: a cell reachable two ways is drawn for each path', () => {
  // Wide cone facing up-right (toward the (1,3) corner) so both routes
  // (2,2)→(2,3)→(1,3) and (2,2)→(1,2)→(1,3) are in view.
  const { draws } = unfoldSections({
    maze: ROOM, camX: 2.5, camZ: 2.5, yaw: 45, viewDist: 6, fovy: 90, aspect: 1.5,
  });
  const at13 = draws.filter((d) => d.vi === 1 && d.vj === 3);
  assert.equal(at13.length, 2, 'virtual cell (1,3) drawn once per portal path');
  // both are the same real cell, un-mirrored (reached only through openings)
  for (const d of at13) { assert.equal(d.ri, 1); assert.equal(d.rj, 3); assert.equal(d.mirrored, false); }
});

// --- one virtual cell, two DIFFERENT reflections (the sketch's section 6) -----
// A cell walled off but visible past two of its mirrors must hold a different
// reflection per mirror — so it is drawn once per portal, each to be stencilled
// to its own wall. This is why the old "draw a virtual cell once" dedup is wrong.
test('a cell behind two mirrors holds a different reflection per mirror', () => {
  // eye 8=(2,2); 5=(1,2) open above; 9=(2,3) open right; 6=(1,3) WALL up-right.
  const M = maze(['11111', '10011', '10001', '11111']);
  const { draws } = unfoldSections({
    maze: M, camX: 2.5, camZ: 2.5, yaw: 45, viewDist: 6, fovy: 110, aspect: 1.4,
  });
  const at = draws.filter((d) => d.vi === 1 && d.vj === 3)
    .map((d) => ({ ri: d.ri, rj: d.rj, mirrored: d.mirrored, kind: d.kind }))
    .sort((a, b) => a.ri - b.ri || a.rj - b.rj);
  assert.equal(at.length, 2, 'drawn once per mirror, not deduped');
  assert.deepEqual(at, [
    { ri: 1, rj: 2, mirrored: true, kind: 'wall' }, // reflection of (1,2) through its left mirror
    { ri: 2, rj: 3, mirrored: true, kind: 'wall' }, // reflection of (2,3) through the mirror below
  ]);
});

// --- the view sector is measured from the eye, not the body ------------------
test('eyeX/eyeZ (not camX/camZ) drive the view-angle culling', () => {
  const view = (extra) => unfoldSections({
    maze: ROOM, camX: 2.5, camZ: 2.5, yaw: 90, viewDist: 6, fovy: 30, aspect: 1, ...extra,
  });
  const cells = (r) => new Set(r.draws.map((d) => `${d.vi},${d.vj}`));
  const body = cells(view({}));                       // viewpoint = body centre
  const shifted = cells(view({ eyeX: 1.7, eyeZ: 2.5 })); // eye well behind the body
  // The eye moving changes which sections fall inside the cone.
  assert.notDeepEqual([...shifted].sort(), [...body].sort());
  // Same start cell / body cell either way (only the angle origin moved).
  assert.ok(body.has('2,2') && shifted.has('2,2'));
});

// --- the result is a tree whose drawn children carry their portal mask -------
test('drawn sections form a tree; each child records the portal it is seen through', () => {
  const { root } = unfoldSections({
    maze: ROOM, camX: 2.5, camZ: 2.5, yaw: 90, viewDist: 4, fovy: 60, aspect: 1,
  });
  assert.equal(root.kind, 'start');
  assert.equal(root.portalDir, null);
  let count = 0;
  const walk = (n) => {
    count++;
    for (const c of n.children) {
      assert.ok(c.portalDir && c.portalVi === n.vi && c.portalVj === n.vj,
        'child portal edge sits on its parent');
      assert.ok(c.kind === 'wall' || c.kind === 'opening');
      walk(c);
    }
  };
  walk(root);
  assert.ok(count > 1, 'tree has more than just the root');
});

// --- draw order is far → near, eye's section last ----------------------------
test('draw list is sorted far → near with the eye section drawn last', () => {
  const { draws } = unfoldSections({
    maze: ROOM, camX: 2.5, camZ: 2.5, yaw: 90, viewDist: 5, fovy: 60, aspect: 1,
  });
  for (let i = 1; i < draws.length; i++) {
    assert.ok(draws[i - 1].dist >= draws[i].dist, 'distances are non-increasing');
  }
  const last = draws[draws.length - 1];
  assert.equal(last.dist, 0);
  assert.equal(last.kind, 'start');
  assert.equal(last.hasBody, true);
});

// --- the parent side is never re-expanded -----------------------------------
test('the side we entered through is skipped (3 sides processed, not 4)', () => {
  // Narrow FOV facing +X so the only depth-1 section is (2,3); then every
  // depth-2 visit is a side of (2,3), and the parent (2,2) must not reappear.
  const { visits } = unfoldSections({
    maze: ROOM, camX: 2.5, camZ: 2.5, yaw: 90, viewDist: 5, fovy: 10, aspect: 1,
  });
  const depth2 = visits.filter((v) => v.depth === 2);
  assert.equal(depth2.length, 3, 'exactly the three non-parent sides considered');
  assert.ok(!depth2.some((v) => v.vi === 2 && v.vj === 2), 'parent (2,2) not re-expanded from (2,3)');
});

// --- termination through facing mirrors (no infinite recursion) -------------
test('parallel mirrors terminate (distance + cycle bounds)', () => {
  // A 1-wide corridor capped by walls at both ends → infinitely many
  // reflections without a bound. It must still return.
  const corridor = maze([
    '1111111',
    '1000001',
    '1111111',
  ]);
  const { draws } = unfoldSections({
    maze: corridor, camX: 3.5, camZ: 1.5, yaw: 90, viewDist: 8, fovy: 60, aspect: 1,
  });
  assert.ok(draws.length > 0 && draws.length < 5000, `bounded draw count: ${draws.length}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
