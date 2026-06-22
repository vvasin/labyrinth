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
    btnStart: $('btn-start'), btnGen: $('btn-gen'), btnGiveUp: $('btn-giveup'),
    btnPath: $('btn-path'), btnBigger: $('btn-bigger'), btnSmaller: $('btn-smaller'),
    dist: $('dist'), distVal: $('dist-val'), sizeVal: $('size-val'),
    pSlider: $('p-slider'), qSlider: $('q-slider'),
    pVal: $('p-val'), qVal: $('q-val'),
    menuBtn: $('menu-button'), menu: $('menu-overlay'), menuClose: $('menu-close'),
  });

  window.__app = app;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
