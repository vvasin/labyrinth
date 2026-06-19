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
npm install          # needed for `npm run lint` and `npm run test:e2e`
npm start            # dev server (scripts/serve.js) at http://localhost:8792
npm run lint         # ESLint
npm run test:e2e     # Playwright smoke test (test/smoke.mjs)
```

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
a.startGame();             // preview → first person
a.state = 'g';             // force gameplay (skip the fog-in animation)
a.camX = 2.5; a.camZ = 1.5; a.yaw = 120; a.pitch = -5;   // place the camera
a.setViewDist(4);          // how many sections deep the unfolding reaches (1–8)
a.regenerate();            // new maze, back to preview
a.maze.solutionPath();     // list of cells from entrance to exit
a._frames;                 // frame counter (cheap liveness check for tests)
```

The canvas uses `preserveDrawingBuffer`, so it can be read back via a 2D canvas in tests.

## Files

- `index.html` / `style.css` — mobile-first shell: full-area canvas, a top bar (menu +
  hint), a movement joystick (bottom-left), action buttons (bottom-right), and the options
  overlay. `dvh` + safe-area insets.
- `src/mat4.js` — column-major 4×4/3×3 matrix helpers. Each `*` helper **post-multiplies**,
  so chaining reproduces the GL matrix-stack order. `transformPlane` emulates `glClipPlane`
  (plane → eye space via inverse-transpose of the modelview).
- `src/maze.js` — `Maze`: generation + solution pathfinding, a faithful port of
  `maze_module.c` (randomized carving with twistiness `p` / branchiness `q`, then a BFS that
  fills `next[i][j]` pointing toward the exit). Grid is (2N+1)×(2M+1); index `i`=row=world Z,
  `j`=col=world X.
- `src/shaders.js` — GLSL. One program: ambient + a directional key light + a
  camera-mounted **spotlight (the flashlight)**, linear fog, optional texturing, material
  emission (the coloured markers), and up to `MAX_CLIP` shader clip planes (the section
  renderer leaves these off, but they stay available). All lighting is in **eye space**.
- `src/renderer.js` — WebGL context, the shader program, texture loading (BMP decodes in
  the browser via `<img>`; we redraw onto a power-of-two canvas so WebGL 1.0 can mipmap +
  REPEAT), mesh buffers, an immediate-mode `drawQuad` (one scratch buffer, for wall
  quads), and thin **GL-state wrappers named after the C calls** (`colorMask`, `depthMask`,
  `cullFace`, `enableCull`).
- `src/scene.js` — static geometry: the full preview floor; a single **unit floor tile**
  (`buildUnitFloor`, one drawn per section); the red **start** and green **exit** markers;
  the black finish box; the path polyline; and `wallQuad(vi,vj,dir)` — a mirror-wall quad in
  unfolded ("virtual") world space.
- `src/sections.js` — **the heart**: `computeSections()`, the flood-fill that unfolds the
  maze across its mirrors into a disk of drawable sections. See below.
- `src/mech.js` — the player avatar, a box-built walker with a phase-driven gait. The
  original linked the 700-line `glutmech`; we keep only the role (something that reads right
  reflected) with a compact model. Drawn on the player's cell and its mirror images.
- `src/game.js` — `App`: maze lifecycle, the camera, collision (`_parseMove`), the
  preview→play→finish state machine, per-mode lighting, and the render loop — `_drawPreview`
  (top-down, no walls) and `_renderSections` (the first-person unfolding). The desktop-only
  frame recorder was dropped.
- `src/controls.js` — keyboard, drag-to-look (pointer), the touch joystick, and the menu
  wiring.
- `src/persistence.js` — best-effort `localStorage` for size / `p` / `q` / view distance.
- `scripts/serve.js` — zero-dependency static dev server (sets ESM + `.bmp` MIME types).

## The section renderer (`sections.js`) — read before touching rendering

The visible world is the maze **unfolded** across its mirror walls. From the cell the camera
stands in we flood-fill outward over a grid of **sections** placed in unfolded ("virtual")
world space (`computeSections`):

- crossing an **open passage** steps to the real neighbouring cell — a real piece of the
  maze, same orientation, model matrix unchanged;
- crossing a **wall** steps to a section that is the **reflection of the cell in front of
  it** — same real cell, one more axis-aligned reflection composed into its `model` matrix.

Each section records its virtual cell `(vi,vj)`, the real cell it draws `(ri,rj)`, the
orientation signs `sx/sz` (world ±X/±Z → real direction), the accumulated reflection `model`
(real-maze coords → unfolded world), and `hasBody` (does the player's body ride this cell —
true on the camera's cell and carried only through mirrors, so you see yourself in the
glass). A world step `dir={dj,di}` maps to a real step `(dj·sx, di·sz)`; the maze cell there
being a wall means a mirror, open means a passage.

`game.js`'s `_renderSections` then draws **far → near**: per section a unit floor tile (at
`model·translate(rj,0,ri)`), the body where `hasBody`, and the start/end markers only on
their own cell; then the deduped **walls**, also far → near, so the semi-transparent mirror
glass composites over the reflections already laid behind it. A wall with a section behind it
(within view) is semi-transparent; one with nothing behind is **solid** (so you don't see the
void). Backface culling is **off** for the whole pass — reflections flip winding and the
shader is two-sided — so no per-section winding bookkeeping is needed.

### Invariant: the view disk is bounded by area

Sections are keyed by virtual cell and bounded by `viewDist` (in section units) plus a
forward view-angle cull, so the structure is a **disk** of cells — cost grows with area, not
the old recursion's `walls^depth`. Two different mirrors reaching the same virtual cell give
the same reflection, so each cell is computed and drawn once. Raising `viewDist` widens the
disk; watch software-renderer / mobile perf at the high end.

## Coordinate & camera model (`game.js`)

- World: `x` = maze column `j`, `z` = maze row `i`, `y` up. Cells are unit squares; walls
  are unit cubes between rooms; floor at `y=0`, walls `y∈[0,1]`.
- Camera: `camX/camY/camZ` + `yaw`/`pitch`. View = `rotateX(-pitch)·rotateY(yaw)·
  translate(-cam)`; projection = `perspective(55°)·translate(0,0,-0.7)` (the small shove is
  from the original). Collision (`_parseMove`) pushes the camera out of wall cells using a
  `RADIUS` = 0.24 disc, then checks the exit cell.
- **States**: `p` preview (top-down, full-bright, no fog/flashlight, solution path shown) →
  `s` fog-in transition → `g` gameplay (flashlight + fog) → `f` white-out finish flash →
  back to `p`. The original's longer GLUT scenario animations are compressed to short timed
  transitions.
- The **entrance cell `[1][0]`** is opened only during the render pass (so the section
  flood-fill treats it as a passage) and restored after, so the entrance isn't itself a
  mirror — matching the C.

## Lighting (`shaders.js`)

Eye-space. Ambient + a directional key light (its world direction is transformed by the
view each frame) + a positional **spotlight at the camera** aimed down −Z (cutoff 35°,
exponent 40, linear attenuation) that gives the dim corridors their flashlight look. Linear
fog (black in play; ramps in on entry, white-out on finish). Two-sided shading (`N` flipped
toward the viewer) because reflected/inside-out faces are common.

## How the port diverges from the C (all intentional)

- The **frame recorder** (ffmpeg PPM dump) and fullscreen toggle are gone.
- The **glutmech** avatar is a compact box model, not the original 700-line mech, drawn on
  the player's cell and its mirror images (you'd otherwise be staring at the inside of your
  own torso; the C scaled it to 0.1 at your feet — same intent, cleaner result).
- The recursive **stencil-buffer reflection** is replaced by the bounded section unfolding
  (see above): a painter's pass over a disk of reflected cells, far → near, instead of
  `walls^depth` recursion. `GL_MODULATE` lighting is re-implemented in the single shader.
- UI became **mobile-first on-screen controls** (joystick + buttons + menu) instead of the
  keyboard/right-mouse-look-only desktop build.

## Invariants to preserve

- Walls are mirrors — don't add separate wall geometry; the section pass draws them.
- The section grid is keyed by virtual cell and bounded by view distance + angle, so it
  stays a disk (area-bounded), never an exploding recursion.
- Centering of game logic vs rendering: maze state (`wall`/`next`) is integer/grid; the
  renderer never mutates it except the temporary entrance-open toggle during a frame.
- No build step, no runtime deps, WebGL 1.0 only.
