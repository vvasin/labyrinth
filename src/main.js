// Bootstrap: build the App on the canvas, wire the on-screen controls, and
// expose it as window.__app for debugging.

import { App } from './game.js';
import { bindControls } from './controls.js';

const $ = (id) => document.getElementById(id);

function boot() {
  const canvas = $('glcanvas');
  let app;
  try {
    app = new App(canvas);
  } catch (e) {
    document.body.insertAdjacentHTML('beforeend',
      `<div id="gl-error">Could not start WebGL: ${e.message}</div>`);
    throw e;
  }

  bindControls(app, {
    joystick: $('joystick'), joyNub: $('joy-nub'),
    lookstick: $('lookstick'), lookNub: $('look-nub'),
    presets: $('size-presets'),
    btnStart: $('btn-start'), btnRegen: $('btn-regen'),
    btnGiveUp: $('btn-giveup'), btnRestart: $('btn-restart'),
    confirm: $('confirm-overlay'), confirmYes: $('confirm-yes'), confirmNo: $('confirm-no'),
    hintHud: $('hint-hud'),
    result: $('result-overlay'), resultTitle: $('result-title'), resultSub: $('result-sub'),
    dist: $('dist'), distVal: $('dist-val'),
    menuBtn: $('menu-button'), menu: $('menu-overlay'), menuClose: $('menu-close'),
  });

  window.__app = app;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
