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
      case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4':
      case 'Digit5': case 'Digit6': case 'Digit7': case 'Digit8':
        app.setViewDist(+e.code.slice(-1)); syncUI(); break;
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
    // Swipe right → turn right (see the right side), swipe up → look up.
    app.look(-(e.clientX - lx), -(e.clientY - ly));
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
    app.input.jx = dx / R;  // screen-right (dx>0) → strafe right (negative str)
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
