# Labyrinth

A first-person **mirror maze**, ported to **WebGL 1.0** from an old OpenGL/GLUT C
project. Vanilla JS (ES modules), no build step, no runtime dependencies. Every wall in
the maze is a mirror, so the corridors become a recursive hall of mirrors — and you can
see your own walking avatar reflected in them.

## Run

```bash
npm start            # serves at http://localhost:8792
```

Then open http://localhost:8792/. The page loads `src/*.js` as ES modules directly — there
is **no bundler or build step**. `npm run lint` runs ESLint.

## Play

You start with a **top-down preview** of the whole maze and its solution path. Press
**Enter ▶** (or Space) to drop into first person at the entrance, then find the green exit.

| Action | Touch / on-screen | Keyboard |
|---|---|---|
| Look around | drag the view | arrow keys |
| Move | left joystick | W A S D |
| Enter the maze | **Enter ▶** | Space |
| Give up (back to preview) | **Give up** | R |
| Reveal the solution path | **Path** | Alt + P |
| New maze | menu → *Generate* | G |
| Maze size | menu → *Maze size* | + / − |
| Mirror reflection depth | menu → *Mirror depth* | 0–4 |

Maze **twistiness** and **branchiness** (the original's `p`/`q` generation parameters),
size, and mirror depth live in the **≡ menu** and persist across reloads.

## Layout

```
index.html, style.css     entry point + mobile-first UI
src/                       app source (ES modules)
  mat4.js                  matrix / vector / clip-plane math
  maze.js                  maze generation + solution pathfinding
  shaders.js               GLSL (two lights, fog, texture, shader clip planes)
  renderer.js              WebGL context, program, textures, GL-state wrappers
  scene.js                 floor / marker geometry + visible-mirror finder
  mirrors.js               the recursive stencil-buffer mirror renderer
  mech.js                  the player avatar (seen in reflections)
  game.js                  state machine, camera, collision, render loop
  controls.js              keyboard / pointer / touch input
  persistence.js           localStorage settings
  main.js                  bootstrap
scripts/serve.js           zero-dependency static dev server
textures/                  floor / mirror / start / end (original BMPs)
```

See [CLAUDE.md](CLAUDE.md) for the rendering model and the non-obvious decisions behind
the mirror port.
