// Input wiring: keyboard (desktop), on-screen buttons + sliders, a drag-to-look
// gesture on the canvas, and a touch joystick for movement. All of it just
// nudges the App; the App owns game state.

export function bindControls(app, dom) {
  // --- keyboard ----------------------------------------------------------
  const keymap = { KeyW: 'f', KeyS: 'b', KeyA: 'l', KeyD: 'rt' };
  window.addEventListener('keydown', (e) => {
    if (keymap[e.code]) { app.input[keymap[e.code]] = true; return; }
    switch (e.code) {
      case 'Space': app.startGame(); break;
      case 'KeyG': app.regenerate(); break;
      case 'KeyR': app.giveUp(); break;
      case 'KeyP': if (e.altKey) app.togglePath(); break;
      case 'Equal': case 'NumpadAdd': app.resize(+1); syncUI(); break;
      case 'Minus': case 'NumpadSubtract': app.resize(-1); syncUI(); break;
      case 'ArrowUp': app.look(0, 10); break;
      case 'ArrowDown': app.look(0, -10); break;
      case 'ArrowLeft': app.look(10, 0); break;
      case 'ArrowRight': app.look(-10, 0); break;
      case 'Digit0': case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4':
        app.setDepth(+e.code.slice(-1)); syncUI(); break;
    }
  });
  window.addEventListener('keyup', (e) => {
    if (keymap[e.code]) app.input[keymap[e.code]] = false;
  });

  // --- drag to look (mouse + touch) on the canvas ------------------------
  const canvas = app.canvas;
  let dragId = null, lx = 0, ly = 0, joyId = null;

  canvas.addEventListener('pointerdown', (e) => {
    if (dragId !== null) return;
    dragId = e.pointerId; lx = e.clientX; ly = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== dragId) return;
    app.look(e.clientX - lx, -(e.clientY - ly));
    lx = e.clientX; ly = e.clientY;
  });
  const endDrag = (e) => { if (e.pointerId === dragId) dragId = null; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // --- on-screen movement joystick --------------------------------------
  const joy = dom.joystick, nub = dom.joyNub;
  const setJoy = (dx, dy) => {
    const R = 42;
    const len = Math.hypot(dx, dy);
    if (len > R) { dx = (dx / len) * R; dy = (dy / len) * R; }
    nub.style.transform = `translate(${dx}px, ${dy}px)`;
    app.input.jx = -dx / R; // screen-right → strafe right (negative str)
    app.input.jy = dy / R;  // screen-up (dy<0) → forward
  };
  joy.addEventListener('pointerdown', (e) => {
    joyId = e.pointerId; joy.setPointerCapture(e.pointerId);
    const rc = joy.getBoundingClientRect();
    setJoy(e.clientX - (rc.left + rc.width / 2), e.clientY - (rc.top + rc.height / 2));
    e.stopPropagation();
  });
  joy.addEventListener('pointermove', (e) => {
    if (e.pointerId !== joyId) return;
    const rc = joy.getBoundingClientRect();
    setJoy(e.clientX - (rc.left + rc.width / 2), e.clientY - (rc.top + rc.height / 2));
  });
  const endJoy = (e) => {
    if (e.pointerId !== joyId) return;
    joyId = null; nub.style.transform = 'translate(0,0)';
    app.input.jx = app.input.jy = 0;
  };
  joy.addEventListener('pointerup', endJoy);
  joy.addEventListener('pointercancel', endJoy);

  // --- buttons + sliders -------------------------------------------------
  dom.btnStart.addEventListener('click', () => app.startGame());
  dom.btnGen.addEventListener('click', () => app.regenerate());
  dom.btnGiveUp.addEventListener('click', () => app.giveUp());
  dom.btnPath.addEventListener('click', () => app.togglePath());
  dom.btnBigger.addEventListener('click', () => { app.resize(+1); syncUI(); });
  dom.btnSmaller.addEventListener('click', () => { app.resize(-1); syncUI(); });

  dom.depth.addEventListener('input', () => { app.setDepth(+dom.depth.value); syncUI(); });
  dom.pSlider.addEventListener('change', () => {
    app.adjustParam('p', +dom.pSlider.value - app.maze.p); syncUI();
  });
  dom.qSlider.addEventListener('change', () => {
    app.adjustParam('q', +dom.qSlider.value - app.maze.q); syncUI();
  });

  // menu open/close
  dom.menuBtn.addEventListener('click', () => dom.menu.classList.toggle('hidden'));
  dom.menuClose.addEventListener('click', () => dom.menu.classList.add('hidden'));

  function syncUI() {
    dom.depth.value = app.maxDepth;
    dom.depthVal.textContent = app.maxDepth;
    dom.sizeVal.textContent = `${app.maze.N}×${app.maze.M}`;
    dom.pSlider.value = app.maze.p;
    dom.qSlider.value = app.maze.q;
    dom.pVal.textContent = app.maze.p.toFixed(1);
    dom.qVal.textContent = app.maze.q.toFixed(1);
  }
  syncUI();
  app._syncUI = syncUI;
}
