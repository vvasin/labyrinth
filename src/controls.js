// Input wiring: keyboard (desktop), on-screen buttons + sliders, a drag-to-look
// gesture on the canvas, and a touch joystick for movement. All of it just
// nudges the App; the App owns game state.

export function bindControls(app, dom) {
  // --- iOS: kill native zoom --------------------------------------------
  // Tapping the on-screen controls quickly triggers Safari's double-tap zoom,
  // and a stray two-finger touch triggers pinch zoom; either leaves the app
  // stuck zoomed with no way back, since the controls intercept the touches you
  // would pinch out with. `touch-action: manipulation` (CSS) is supposed to stop
  // double-tap zoom, but iOS Safari ignores it on some elements/versions, so we
  // also guard it here. Pinch: cancel Safari's gesture events outright.
  for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
  }
  // Double-tap: a single-finger tap within ~300ms of the last is the zoom
  // gesture. Cancelling its touchend default stops the zoom — but that also
  // suppresses the synthetic click, so re-fire it on the tapped element (a
  // synthetic, non-trusted click) and swallow the real one if it still slips
  // through, so the control fires exactly once and never zooms. The canvas runs
  // its own pointer-based look gesture (and doesn't zoom), so it's left alone.
  let lastTap = 0, eatRealClickUntil = 0;
  document.addEventListener('touchend', (e) => {
    const now = Date.now(), dt = now - lastTap;
    lastTap = now;
    if (dt < 0 || dt > 300 || e.touches.length || e.target === app.canvas) return;
    e.preventDefault();
    const el = e.target;
    if (el && el.tagName !== 'INPUT' && typeof el.click === 'function') {
      eatRealClickUntil = now + 700;
      el.click();
    }
  }, { passive: false });
  document.addEventListener('click', (e) => {
    if (e.isTrusted && Date.now() < eatRealClickUntil) {
      eatRealClickUntil = 0;
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  }, true);

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
    }
  });
  window.addEventListener('keyup', (e) => {
    if (keymap[e.code]) app.input[keymap[e.code]] = false;
  });

  // --- drag to look (mouse + touch) on the canvas ------------------------
  const canvas = app.canvas;
  let dragId = null, lx = 0, ly = 0;

  canvas.addEventListener('pointerdown', (e) => {
    if (dragId !== null) return;
    dragId = e.pointerId; lx = e.clientX; ly = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== dragId) return;
    // Swipe right → turn right (see the right side), swipe up → look up.
    app.look(-(e.clientX - lx), -(e.clientY - ly));
    lx = e.clientX; ly = e.clientY;
  });
  const endDrag = (e) => { if (e.pointerId === dragId) dragId = null; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // --- on-screen joysticks (left = move, right = look) -------------------
  // Both behave identically; only the input fields they drive differ. The nub
  // follows the finger, clamped to radius R, reporting a normalised −1..1 vector.
  bindJoystick(dom.joystick, dom.joyNub, (x, y) => {
    app.input.jx = x;  // screen-right (x>0) → strafe right (negative str)
    app.input.jy = y;  // screen-up (y<0) → forward
  });
  bindJoystick(dom.lookstick, dom.lookNub, (x, y) => {
    app.input.lx = x;  // screen-right (x>0) → turn right
    app.input.ly = y;  // screen-up (y<0) → look up
  });

  // --- buttons + sliders -------------------------------------------------
  // The play actions live in the menu now; close it so the game is visible.
  const closeMenu = () => dom.menu.classList.add('hidden');
  dom.btnStart.addEventListener('click', () => { app.startGame(); closeMenu(); });
  dom.btnGen.addEventListener('click', () => { app.regenerate(); closeMenu(); });
  dom.btnGiveUp.addEventListener('click', () => { app.giveUp(); closeMenu(); });
  dom.btnPath.addEventListener('click', () => app.togglePath());
  dom.btnBigger.addEventListener('click', () => { app.resize(+1); syncUI(); });
  dom.btnSmaller.addEventListener('click', () => { app.resize(-1); syncUI(); });

  dom.dist.addEventListener('input', () => { app.setViewDist(+dom.dist.value); syncUI(); });
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
    dom.dist.value = app.viewDist;
    dom.distVal.textContent = app.viewDist;
    dom.sizeVal.textContent = `${app.maze.N}×${app.maze.M}`;
    dom.pSlider.value = app.maze.p;
    dom.qSlider.value = app.maze.q;
    dom.pVal.textContent = app.maze.p.toFixed(1);
    dom.qVal.textContent = app.maze.q.toFixed(1);
  }
  syncUI();
  app._syncUI = syncUI;
}

// A round thumbstick: the nub tracks the active pointer (clamped to radius R) and
// `onChange` receives the normalised offset (−1..1 on each axis), zeroed on release.
function bindJoystick(joy, nub, onChange) {
  const R = 42;
  let id = null;
  const set = (dx, dy) => {
    const len = Math.hypot(dx, dy);
    if (len > R) { dx = (dx / len) * R; dy = (dy / len) * R; }
    nub.style.transform = `translate(${dx}px, ${dy}px)`;
    onChange(dx / R, dy / R);
  };
  const track = (e) => {
    const rc = joy.getBoundingClientRect();
    set(e.clientX - (rc.left + rc.width / 2), e.clientY - (rc.top + rc.height / 2));
  };
  joy.addEventListener('pointerdown', (e) => {
    id = e.pointerId; joy.setPointerCapture(e.pointerId);
    track(e);
    e.stopPropagation();
  });
  joy.addEventListener('pointermove', (e) => { if (e.pointerId === id) track(e); });
  const end = (e) => {
    if (e.pointerId !== id) return;
    id = null; nub.style.transform = 'translate(0,0)';
    onChange(0, 0);
  };
  joy.addEventListener('pointerup', end);
  joy.addEventListener('pointercancel', end);
}
