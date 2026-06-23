# Labyrinth — agent brief

A first-person **mirror maze**, ported to **WebGL 1.0** from an OpenGL/GLUT C project
(the original C lives in git history / the import archive). Pure client-side vanilla JS
(ES modules, WebGL 1.0), no build step, no dependencies.

The defining feature — and the reason the port is interesting — is that **every maze wall
is a mirror**. There is no separate "wall" geometry: the visible walls are drawn by the
recursive reflection pass itself. So the renderer is built around a faithful port of the
original's stencil-buffer planar-reflection recursion, adapted to WebGL (which has no
stencil-clip-plane fixed-function path).

Read this before changing the renderer — most of the mirror code looks fiddly out of
context and is a direct translation of specific fixed-function GL behaviour.

## Run & test

```bash
npm install          # needed for `npm run lint` and the tests
npm start            # dev server (scripts/serve.js) at http://localhost:8792
npm run lint         # ESLint
npm run test:unit    # pure unfolding-algorithm checks (test/unfold.test.mjs, no browser)
npm run test:e2e     # Playwright smoke test (test/smoke.mjs)
```

`test/unfold.test.mjs` exercises `unfoldSections()` with no renderer: it checks
which sections are drawn, in what order, with which parameters (reference real
cell, mirrored, body) and how they are culled — including the key correctness
cases (a cell behind two mirrors holding a different reflection per mirror; no
virtual-cell dedup; termination between facing mirrors).

`test/smoke.mjs` boots the app in a headless browser, drives it through
`window.__app`, and asserts the section renderer draws real pixels in every state
with the GL error register staying clean (`glGetError === 0`) and no JS errors.

**Browser to use:** on a local machine run `npx playwright install chromium`
once. In the sandboxed/remote agent environment the Playwright download CDN is
blocked, but a Chromium build ships pre-installed under `/opt/pw-browsers` — so
**when you are NOT on the user's local machine, use the browser from there.** The
test auto-detects it (and honours a `PLAYWRIGHT_CHROMIUM=/path/to/chrome`
override); set `SHOTS=<dir>` to also dump screenshots.

No build step — `index.html` loads `src/*.js` as ES modules directly. There are no unit
tests. The app exposes `window.__app` for introspection/control:

```js
const a = window.__app;
a.newGame(8);              // generate an 8×8 maze → 'generated' state (top-down map)
a.startGame();             // 'generated' → 'started' (first person at the entrance)
a.animT = 1;               // skip the fog-in animation
a.state;                   // 'initial' | 'generated' | 'started' | 'surrendered' | 'finished'
a.camX = 2.5; a.camZ = 1.5; a.yaw = 120; a.pitch = -5;   // place the camera
a.setViewDist(4);          // how many sections deep the unfolding reaches (4–16)
a.surrender();             // 'started' → 'surrendered' (review map)
a.toInitial();             // back to the size chooser; clears the saved session
a.maze.solutionPath();     // list of cells from entrance to exit
a._frames;                 // frame counter (cheap liveness check for tests)
```

The canvas uses `preserveDrawingBuffer`, so it can be read back via a 2D canvas in tests.

## Files

- `index.html` / `style.css` — mobile-first shell: full-area canvas, a top bar (menu, state
  hint, play HUD + give-up), the two movement/look joysticks, the initial **size-preset
  chooser** overlay, the **generated** action bar (enter / new maze), and the **result**
  overlay (surrendered / finished verdict + play-again). Visibility is driven entirely by a
  `body.state-<name>` class set from `App.onStateChange`. `dvh` + safe-area insets.
  Responsive: in **portrait** the map fills the width with the generated/result
  controls stacked above/below it; in **landscape** the map (framed by height,
  so it fills the screen vertically) shrinks to a right-hand column and the
  controls move into a left column — driven by CSS, with a `ResizeObserver` in
  `game.js` reframing the maze to the canvas's new size. Nothing overlaps or
  overflows at any width.
- `src/mat4.js` — column-major 4×4/3×3 matrix helpers. Each `*` helper **post-multiplies**,
  so chaining reproduces the GL matrix-stack order. `transformPlane` emulates `glClipPlane`
  (plane → eye space via inverse-transpose of the modelview).
- `src/maze.js` — `Maze`: generation + solution pathfinding, a faithful port of
  `maze_module.c` (randomized carving with twistiness `p` / branchiness `q`, then a BFS that
  fills `next[i][j]` pointing toward the exit). Grid is (2N+1)×(2M+1); index `i`=row=world Z,
  `j`=col=world X. Generation is **seeded** (a mulberry32 PRNG): the maze is a pure function
  of `(N, M, p, q, seed)`, so a session persists as just those five numbers. Also exposes
  `pathFrom(i,j)` (route from any cell to the exit) and `deadEnds()` (room cells with a single
  opening — where hints are dropped).
- `src/shaders.js` — GLSL. One program: ambient + a directional key light + a
  camera-mounted **spotlight (the flashlight)**, **radial** linear fog (by distance from the
  eye, so it matches the radial section cull), optional texturing, material emission (the
  coloured markers), a `uPathFlow` branch (the **hint reveal ribbon**: an emissive pulse that
  flows along U toward the exit, fog-dimmed but never lit/reflected), and up to `MAX_CLIP`
  shader clip planes (the section renderer leaves these off, but they stay available). All
  lighting is in **eye space**.
- `src/textures.js` — the **procedural** floor / mirror / start / end textures, drawn onto
  power-of-two canvases at runtime (replacing the original hand-painted BMPs — no binary
  assets, crisp at any resolution, tuned to the shader's gamma/tonemap pipeline).
- `src/renderer.js` — WebGL context, the shader program, texture upload
  (`textureFromCanvas`, used for the procedural textures; a `loadTexture` URL/BMP path also
  exists but is currently unused — both redraw onto a power-of-two canvas so WebGL 1.0 can
  mipmap + REPEAT), mesh buffers, an immediate-mode `drawQuad` (one scratch buffer, for wall
  quads), and thin **GL-state wrappers named after the C calls** (`colorMask`, `depthMask`,
  `cullFace`, `enableCull`).
- `src/scene.js` — static geometry: the full floor; a single **unit floor tile**
  (`buildUnitFloor`, one drawn per section); the red **start** and green **exit** markers; the
  overview **base plate** (`buildPlate`, the dark wall slab the readable map's bright floor
  channels sit on) and flat **decal** quad (`buildDecal`, the start/exit/you emblems on the
  maps); the floating **hint gem** (`buildHint`, an octahedron drawn in the section pass so it
  reflects); the **path ribbon** (`buildPathRibbon`, the reveal line — arc length in U for the
  flowing pulse); the review path polyline; and `wallQuad(vi,vj,dir)` — a mirror-wall quad in
  unfolded ("virtual") world space.
- `src/unfold.js` — **the heart**: `unfoldSections()`, the recursive portal walk that unfolds
  the maze across its mirrors into a *tree* of drawable sections. Pure (no GL); unit-tested.
  See below.
- `src/mech.js` — the player avatar, a box-built walker with a phase-driven gait. The
  original linked the 700-line `glutmech`; we keep only the role (something that reads right
  reflected) with a compact model. Drawn on the player's cell and its mirror images.
- `src/game.js` — `App`: maze lifecycle, the camera, collision (`_parseMove`), the **five-state
  user journey** (see below), the hint system, per-mode lighting, session persistence, and the
  render loop — `_drawOverview` (the readable top-down map used by generated/surrendered/
  finished) and `_renderSections` (the first-person unfolding) + `_drawReveal` (the hint
  ribbon). Exports `STATE` and `SIZE_PRESETS`.
- `src/controls.js` — keyboard, drag-to-look (pointer), the touch joysticks, the size-preset
  buttons, and the per-state UI wiring (body class, result verdict, HUD). Every key/button is
  gated by state so it only does what the current screen declares.
- `src/persistence.js` — best-effort `localStorage`: durable **settings** (last size, view
  distance) plus a resumable **session** (maze as `{N,M,p,q,seed}`, state, camera position,
  surrender point, and hint layout incl. the absolute end-time of an active reveal so the
  countdown continues — never resets — across a reload).
- `scripts/serve.js` — zero-dependency static dev server (sets ESM + `.bmp` MIME types).

## The section renderer (`unfold.js` + `game.js`) — read before touching rendering

The visible world is the maze **unfolded** across its mirror walls. `unfoldSections()` does a
depth-first **portal walk** from the cell the eye stands in. For each of a section's sides
(skipping the one we came through):

- an **opening** (the real neighbour cell is open) steps to that real cell — same orientation
  and `model`, a real piece of the maze;
- a **wall** (the neighbour cell is solid → a mirror) steps to a **reflection of the current
  cell** — its reference real cell `(ri,rj)` is unchanged, one axis-aligned reflection is
  composed into `model`, the orientation `sx/sz` flips and `mirrored` toggles.

Each section keeps its virtual cell `(vi,vj)`, reference real cell `(ri,rj)`, `sx/sz` (world
±X/±Z → real direction), the reflection `model` (real → unfolded world), `hasBody` (`ri,rj`
== the eye's cell, so your body draws on your cell **and every reflected copy of it**), the
**portal** it is seen through (`portalDir/portalVi/portalVj` — its stencil mask), and
`solidWalls` (wall sides whose reflection was culled, drawn opaque so no void shows). A world
step `dir={dj,di}` maps to a real step `(dj·sx, di·sz)`.

**No dedup.** The same virtual cell can hold *different* reflections seen through different
mirrors (e.g. one cell showing a reflection of its left neighbour through one wall and of its
lower neighbour through another), so each is a separate tree node, each clipped to its own
portal. Culling is by a **2-D view sector** narrowed at every portal (measured from the fixed
eye in unfolded space), a **distance** bound (`viewDist`, in section units), and a per-path
**cycle** guard — together these bound the walk and guarantee termination through facing
mirrors. The result is a tree (`root`) plus a flat depth-first `visits` log and a `draws`
list sorted far → near.

The **initial** sector is deliberately wide — the game passes `minHalf = π/2`, a full 180°
forward hemisphere, rather than the true horizontal FOV (which is awkward to reproduce from
the aspect ratio and would wrongly cull on-screen sections on wide screens); the first portal
narrows it sharply anyway, so erring wide is cheap. One special case: when the eye sits **in**
an opening — on its plane and laterally within it (a cell border, the `NEAR_DOORWAY` test the
renderer also uses) — that portal occludes nothing, so the cell beyond keeps the **full**
parent sector instead of being narrowed to the portal's (then-degenerate ~180°) span. Without
that, an eye exactly on a border collapses the sector through the doorway and blacks out
everything seen through it.

`game.js`'s `_renderSections` walks the tree with the **stencil buffer** (this is the
original `DrawMirrors` structure, now with the sector/distance/cycle filters it lacked). For
each child: increment the stencil inside the portal's silhouette (`EQUAL level` → `level+1`),
recurse to draw the subtree masked to `level+1`, lay the semi-transparent mirror **glass**
over a wall portal, then restore the silhouette to `level` (`LESS level` → REPLACE). After
its children, the section draws **itself** (floor, body, markers, solid walls) where
`stencil == level` — children first, so far → near. Backface culling is **off** for the whole
pass (reflections flip winding; the shader is two-sided).

### Invariant: the walk is bounded and masked, never deduped

Do not reintroduce virtual-cell dedup — it is wrong (different mirrors give different
reflections at the same cell). Termination and cost are bounded by the view sector + distance
+ cycle guard, and correctness of overlapping reflections comes from the per-portal stencil
mask, not from drawing each cell once. Raising `viewDist` deepens the recursion; watch
software-renderer / mobile perf and the 8-bit stencil depth at the high end.

## Coordinate & camera model (`game.js`)

- World: `x` = maze column `j`, `z` = maze row `i`, `y` up. Cells are unit squares; walls
  are unit cubes between rooms; floor at `y=0`, walls `y∈[0,1]`.
- Camera: `camX/camY/camZ` + `yaw`/`pitch`. View = `rotateX(-pitch)·rotateY(yaw)·
  translate(-cam)`; projection = `perspective(55°)·translate(0,0,-0.7)` (the small shove is
  from the original). Collision (`_parseMove`) pushes the camera out of wall cells using a
  `RADIUS` = 0.24 disc, then checks the exit cell.
- **States** (`STATE` in `game.js`) — the user journey, each persisted so a reload resumes
  in place:
  - `initial` — no maze drawn; the size-preset chooser overlay invites a `newGame(n)`.
  - `generated` — the readable **top-down map** (`_drawOverview`: dark wall plate + bright
    floor channels + start/exit emblems, no path, no mirrors). Enter (`startGame`) or restart
    (`toInitial`).
  - `started` — first person. The camera spawns at the entrance facing the first open passage;
    a one-second fog-in (`animT`) ramps the fog/flashlight. Reach the exit → `finished`; give
    up → `surrendered`. Hints (glowing gems in dead ends) are picked up by walking onto them
    and reveal the path from your cell for `REVEAL_MS`.
  - `surrendered` — the map again, with the spot you stopped at and the path from there out.
  - `finished` — the map with the whole solution path.
  The original's `s`/`f` transition animations are folded into `started`'s fog-in and DOM
  overlays; there is no separate white-out finish state.
- The **entrance cell `[1][0]`** is opened only during the `started` render pass (so the portal
  walk treats it as a passage) and restored after, so the entrance isn't itself a mirror —
  matching the C.

## Lighting (`shaders.js`)

Eye-space. Ambient + a directional key light (its world direction is transformed by the
view each frame) + a positional **spotlight at the camera** aimed down −Z (cutoff 35°,
exponent 40, linear attenuation) that gives the dim corridors their flashlight look.
**Radial** linear fog (by distance from the eye, not forward depth, so it dissolves the far
walls evenly in every direction and stays synced to the radial section cull — dark tint in
play, ramps in on entry; the overview/review maps are flat full-bright with no fog). Two-sided
shading (`N` flipped toward the viewer) because reflected/inside-out faces are common.

## How the port diverges from the C (all intentional)

- The **frame recorder** (ffmpeg PPM dump) and fullscreen toggle are gone.
- The **glutmech** avatar is a compact box model, not the original 700-line mech, drawn on
  the player's cell and its mirror images (you'd otherwise be staring at the inside of your
  own torso; the C scaled it to 0.1 at your feet — same intent, cleaner result).
- The recursive **stencil-buffer reflection** is kept in spirit but reorganised around
  per-cell **sections** and bounded by a view sector + distance + cycle guard (the original
  recursed on `walls^depth` with only a depth cap). `GL_MODULATE` lighting is re-implemented
  in the single shader; `glClipPlane` is no longer needed (each section is a finite cell,
  masked by the stencil rather than clip planes).
- UI became **mobile-first on-screen controls** (joysticks + buttons + menu) instead of the
  keyboard/right-mouse-look-only desktop build, and grew a real **user journey**: a five-state
  machine with size presets (the only exposed generation knob — `p`/`q` are locked at the
  best-playing 0.9/0.1), a readable top-down map for the non-play states, full session
  persistence (seeded maze), and a **hint** system (collectible gems → a temporary, flowing,
  fog-dimmed reveal of the way out).

## Invariants to preserve

- Walls are mirrors — don't add separate wall geometry; the section pass draws them.
- The portal walk is bounded by the view sector + distance + cycle guard and masked by the
  per-portal stencil; don't reintroduce virtual-cell dedup (a cell can hold different
  reflections through different mirrors). Keep `test/unit` green if you touch `unfold.js`.
- Centering of game logic vs rendering: maze state (`wall`/`next`) is integer/grid; the
  renderer never mutates it except the temporary entrance-open toggle during a frame.
- No build step, no runtime deps, WebGL 1.0 only.
