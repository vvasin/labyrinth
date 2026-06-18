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
npm install          # only needed for `npm run lint`
npm start            # dev server (scripts/serve.js) at http://localhost:8792
npm run lint         # ESLint
```

No build step — `index.html` loads `src/*.js` as ES modules directly. There are no unit
tests. The app exposes `window.__app` for introspection/control:

```js
const a = window.__app;
a.startGame();             // preview → first person
a.state = 'g';             // force gameplay (skip the fog-in animation)
a.camX = 2.5; a.camZ = 1.5; a.yaw = 120; a.pitch = -5;   // place the camera
a.setDepth(2);             // mirror reflection depth (0–4)
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
  emission (the coloured markers), and **up to `MAX_CLIP` shader clip planes** the mirror
  recursion needs. All lighting is in **eye space**.
- `src/renderer.js` — WebGL context, the shader program, texture loading (BMP decodes in
  the browser via `<img>`; we redraw onto a power-of-two canvas so WebGL 1.0 can mipmap +
  REPEAT), mesh buffers, an immediate-mode `drawQuad` (one scratch buffer, for mirror
  quads), and thin **GL-state wrappers named after the C calls** (`colorMask`, `depthMask`,
  `stencilFunc`, `stencilOp`, `cullFace`).
- `src/scene.js` — static geometry (textured floor over open cells; the red **start** and
  green **exit** markers; the black boundary box for the finish flash; the path polyline)
  plus `visibleWalls()` — the camera-facing-mirror-within-fog test, **nearest first**.
- `src/mirrors.js` — **the heart**: `drawMirrors()` / `recurse()`, the port of
  `DrawMirrors()`. See below.
- `src/mech.js` — the player avatar, a box-built walker with a phase-driven gait. The
  original linked the 700-line `glutmech`; we keep only the role (something that reads right
  reflected) with a compact model. Drawn **only in reflections**.
- `src/game.js` — `App`: maze lifecycle, the camera, collision (`_parseMove`), the
  preview→play→finish state machine, per-mode lighting, and the render loop that wires the
  mirror recursion to the scene draw. The desktop-only frame recorder was dropped.
- `src/controls.js` — keyboard, drag-to-look (pointer), the touch joystick, and the menu
  wiring.
- `src/persistence.js` — best-effort `localStorage` for size / `p` / `q` / mirror depth.
- `scripts/serve.js` — zero-dependency static dev server (sets ESM + `.bmp` MIME types).

## The mirror renderer (`mirrors.js`) — read before touching rendering

Ported from `DrawMirrors(depth, id)`. For each visible mirror wall, at each recursion level:

1. **Stamp** the mirror's silhouette into the stencil buffer (colour/depth masked off,
   `INCR` on pass), marking the region its reflection will fill.
2. **Recurse**: draw the *entire scene reflected* across that wall — via a reflection matrix
   (`scale(-1)·translate`) accumulated into the model matrix — clipped to the wall's
   half-space and to the stencil region. The reflection is drawn one stencil level deeper.
3. **Overlay** the semi-transparent mirror texture (`REPLACE` resets the stencil, depth is
   written) so the mirror reads as a real wall and occludes correctly.

After the per-wall loop, the **un-reflected** scene is drawn at that level too.

Fixed-function pieces re-created by hand, because WebGL 1.0 lacks them:

- **Matrix stack** → an accumulated `model` matrix threaded through the recursion.
- **`glClipPlane`** → planes transformed to eye space (`mat4.transformPlane`) and pushed on
  a stack; the fragment shader discards anything behind any active plane. The clip-plane
  signs/values are copied verbatim from the C (they're in world space at definition; the
  shader compares the interpolated eye position).
- **Winding flip** → each reflection inverts winding, so **odd recursion depths cull
  `FRONT`** (even cull `BACK`), exactly as the C toggled `glCullFace`.

### Invariant: depth 0 vs deeper levels

The wall list at **depth 0 must be drawn in full** — those textured mirror quads *are* the
visible walls; capping it would punch holes in the maze. Only the **recursive reflections**
(depth ≥ 1) are capped to the nearest `reflectCap` (default 3) walls. This bounds the cost
(naively `walls^depth`, which explodes) while losing nothing visible — deep reflections are
tiny. If you raise `reflectCap` or the max depth, watch software-renderer / mobile perf.

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
- The **entrance cell `[1][0]`** is opened only during the render pass (floor + mirror
  finding) and restored after, so the entrance isn't itself a mirror — matching the C.

## Lighting (`shaders.js`)

Eye-space. Ambient + a directional key light (its world direction is transformed by the
view each frame) + a positional **spotlight at the camera** aimed down −Z (cutoff 35°,
exponent 40, linear attenuation) that gives the dim corridors their flashlight look. Linear
fog (black in play; ramps in on entry, white-out on finish). Two-sided shading (`N` flipped
toward the viewer) because reflected/inside-out faces are common.

## How the port diverges from the C (all intentional)

- The **frame recorder** (ffmpeg PPM dump) and fullscreen toggle are gone.
- The **glutmech** avatar is a compact box model, not the original 700-line mech, and is
  drawn **only in reflections** (you'd otherwise be staring at the inside of your own torso;
  the C scaled it to 0.1 at your feet — same intent, cleaner result).
- Mirror **recursion is capped** at deeper levels (see the invariant above).
- Fixed-function `glClipPlane` / matrix stack / `GL_MODULATE` lighting are re-implemented in
  the single shader + JS matrix code.
- UI became **mobile-first on-screen controls** (joystick + buttons + menu) instead of the
  keyboard/right-mouse-look-only desktop build.

## Invariants to preserve

- Walls are mirrors — don't add separate wall geometry; the reflection pass draws them.
- Depth-0 wall list stays complete; only deeper reflections are capped.
- Centering of game logic vs rendering: maze state (`wall`/`next`) is integer/grid; the
  renderer never mutates it except the temporary entrance-open toggle during a frame.
- No build step, no runtime deps, WebGL 1.0 only.
