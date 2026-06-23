// Input wiring: keyboard (desktop), on-screen buttons, the size-preset chooser,
// a drag-to-look gesture on the canvas, and two touch joysticks. Everything just
// nudges the App; the App owns game state. Actions are gated by state so no key
// or button ever performs something undeclared for the screen you're on.

import { STATE, SIZE_PRESETS } from './game.js';

export function bindControls(app, dom) {
  // --- iOS: kill native zoom --------------------------------------------
  for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
  }
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

  // --- size-preset chooser (initial state) ------------------------------
  for (const preset of SIZE_PRESETS) {
    const b = document.createElement('button');
    b.className = 'preset';
    b.innerHTML = `<span class="preset-label">${preset.label}</span>` +
      `<span class="preset-size">${preset.n}×${preset.n}</span>`;
    b.addEventListener('click', () => app.newGame(preset.n));
    dom.presets.appendChild(b);
  }

  // --- keyboard ----------------------------------------------------------
  const keymap = { KeyW: 'f', KeyS: 'b', KeyA: 'l', KeyD: 'rt' };
  window.addEventListener('keydown', (e) => {
    if (keymap[e.code]) { app.input[keymap[e.code]] = true; return; }
    switch (e.code) {
      case 'Space':
        if (app.state === STATE.GENERATED) app.startGame();
        break;
      case 'KeyR':
        if (app.state === STATE.STARTED) askGiveUp();
        break;
      case 'Escape':
        if (app.state !== STATE.INITIAL) app.toInitial();
        break;
      case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4': {
        if (app.state !== STATE.INITIAL) break;
        const preset = SIZE_PRESETS[+e.code.slice(-1) - 1];
        if (preset) app.newGame(preset.n);
        break;
      }
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
    app.look(-(e.clientX - lx), -(e.clientY - ly));
    lx = e.clientX; ly = e.clientY;
  });
  const endDrag = (e) => { if (e.pointerId === dragId) dragId = null; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // --- on-screen joysticks (left = move, right = look) -------------------
  bindJoystick(dom.joystick, dom.joyNub, (x, y) => { app.input.jx = x; app.input.jy = y; });
  bindJoystick(dom.lookstick, dom.lookNub, (x, y) => { app.input.lx = x; app.input.ly = y; });

  // --- buttons -----------------------------------------------------------
  const closeMenu = () => dom.menu.classList.add('hidden');
  // Give up is destructive (it ends the run), so confirm before surrendering.
  const askGiveUp = () => { if (app.state === STATE.STARTED) dom.confirm.classList.remove('hidden'); };
  const closeConfirm = () => dom.confirm.classList.add('hidden');
  dom.btnStart.addEventListener('click', () => app.startGame());
  dom.btnRegen.addEventListener('click', () => { app.toInitial(); closeMenu(); });
  dom.btnGiveUp.addEventListener('click', askGiveUp);
  dom.confirmYes.addEventListener('click', () => { closeConfirm(); app.surrender(); });
  dom.confirmNo.addEventListener('click', closeConfirm);
  dom.btnRestart.addEventListener('click', () => { app.toInitial(); closeMenu(); });

  dom.dist.addEventListener('input', () => { app.setViewDist(+dom.dist.value); syncUI(); });

  dom.menuBtn.addEventListener('click', () => dom.menu.classList.toggle('hidden'));
  dom.menuClose.addEventListener('click', () => dom.menu.classList.add('hidden'));

  // --- reflect app → UI --------------------------------------------------
  // Body class drives per-state visibility (see style.css). Also set the
  // result verdict and any context-specific copy.
  const STATES = Object.values(STATE);
  app.onStateChange = (st) => {
    for (const s of STATES) document.body.classList.toggle(`state-${s}`, s === st);
    if (st !== STATE.STARTED) closeConfirm();
    if (st === STATE.FINISHED || st === STATE.SURRENDERED) {
      const win = st === STATE.FINISHED;
      dom.result.classList.toggle('win', win);
      dom.result.classList.toggle('lose', !win);
      dom.resultTitle.textContent = win ? 'You escaped!' : 'You gave up';
      dom.resultSub.textContent = win
        ? 'The full path from start to exit is traced below.'
        : 'Here you stood — the line traces the way out you missed.';
    }
    if (st !== STATE.INITIAL) closeMenu();
  };

  app.onHud = ({ hintsLeft, revealMs }) => {
    const parts = [`Hints: ${hintsLeft}`];
    if (revealMs > 0) parts.push(`path ${Math.ceil(revealMs / 1000)}s`);
    dom.hintHud.textContent = parts.join(' · ');
  };

  function syncUI() {
    dom.dist.value = app.viewDist;
    dom.distVal.textContent = app.viewDist;
  }
  syncUI();
  app.onStateChange(app.state);
  app._syncUI = syncUI;
}

// A round thumbstick: nub tracks the pointer (clamped to radius R); `onChange`
// gets the normalised offset shaped by t² for fine aim near the centre.
function bindJoystick(joy, nub, onChange) {
  const R = 42;
  let id = null;
  const set = (dx, dy) => {
    const len = Math.hypot(dx, dy);
    if (len > R) { dx = (dx / len) * R; dy = (dy / len) * R; }
    nub.style.transform = `translate(${dx}px, ${dy}px)`;
    const nx = dx / R, ny = dy / R, t = Math.hypot(nx, ny);
    onChange(nx * t, ny * t);
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
