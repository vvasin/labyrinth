// WebGL 1.0 renderer: owns the GL context, the single shader program, texture
// loading, mesh buffers, and thin wrappers over the depth/stencil/cull/blend
// state that the mirror recursion flips around. Geometry is fed as interleaved
// [x,y,z, nx,ny,nz, u,v] vertices.

import { VERT, FRAG, MAX_CLIP } from './shaders.js';
import * as M from './mat4.js';

const STRIDE = 8 * 4; // bytes per vertex

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('shader compile: ' + gl.getShaderInfoLog(sh));
  }
  return sh;
}

const UNIFORMS = [
  'uProj', 'uMV', 'uNormalMat',
  'uAmbient', 'uLight0Dir', 'uLight0Color',
  'uSpotOn', 'uSpotColor', 'uSpotCutoff', 'uSpotExp', 'uSpotAtten',
  'uBaseColor', 'uSpecColor', 'uShininess', 'uEmission', 'uAlpha', 'uUnlit',
  'uUseTex', 'uTex',
  'uFogOn', 'uFogColor', 'uFogStart', 'uFogEnd',
  'uClipCount',
];

export class Renderer {
  constructor(canvas) {
    const opts = { antialias: true, stencil: true, depth: true, alpha: false, preserveDrawingBuffer: true };
    const gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
    if (!gl) throw new Error('WebGL 1.0 not available');
    this.gl = gl;
    this.canvas = canvas;

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('program link: ' + gl.getProgramInfoLog(prog));
    }
    this.prog = prog;
    gl.useProgram(prog);

    this.attr = {
      aPos: gl.getAttribLocation(prog, 'aPos'),
      aNormal: gl.getAttribLocation(prog, 'aNormal'),
      aUV: gl.getAttribLocation(prog, 'aUV'),
    };
    this.u = {};
    for (const name of UNIFORMS) this.u[name] = gl.getUniformLocation(prog, name);
    this.uClip = [];
    for (let i = 0; i < MAX_CLIP; i++) this.uClip.push(gl.getUniformLocation(prog, `uClip[${i}]`));

    this._dynBuf = gl.createBuffer();           // immediate-mode scratch (mirror quads)
    this._dyn = new Float32Array(8 * 6);

    gl.clearColor(0, 0, 0, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1i(this.u.uTex, 0);
  }

  // --- meshes -------------------------------------------------------------
  createMesh(vertices) {
    const gl = this.gl;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    return { buf, count: vertices.length / 8 };
  }

  _bindAttribs() {
    const gl = this.gl, a = this.attr;
    gl.enableVertexAttribArray(a.aPos);
    gl.vertexAttribPointer(a.aPos, 3, gl.FLOAT, false, STRIDE, 0);
    gl.enableVertexAttribArray(a.aNormal);
    gl.vertexAttribPointer(a.aNormal, 3, gl.FLOAT, false, STRIDE, 12);
    gl.enableVertexAttribArray(a.aUV);
    gl.vertexAttribPointer(a.aUV, 2, gl.FLOAT, false, STRIDE, 24);
  }

  drawMesh(mesh, mode) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buf);
    this._bindAttribs();
    gl.drawArrays(mode === undefined ? gl.TRIANGLES : mode, 0, mesh.count);
  }

  // Immediate-mode quad (4 verts → 2 triangles), reusing one scratch buffer.
  drawQuad(verts) {
    const gl = this.gl;
    const d = this._dyn;
    const order = [0, 1, 2, 0, 2, 3];
    for (let k = 0; k < 6; k++) {
      const v = verts[order[k]];
      d.set(v, k * 8);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this._dynBuf);
    gl.bufferData(gl.ARRAY_BUFFER, d, gl.DYNAMIC_DRAW);
    this._bindAttribs();
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // --- per-draw transform/material --------------------------------------
  setMatrices(proj, mv) {
    const gl = this.gl;
    gl.uniformMatrix4fv(this.u.uProj, false, proj);
    gl.uniformMatrix4fv(this.u.uMV, false, mv);
    gl.uniformMatrix3fv(this.u.uNormalMat, false, M.normalMat3(mv));
  }

  setMaterial(mat) {
    const gl = this.gl, u = this.u;
    gl.uniform3fv(u.uBaseColor, mat.base || [1, 1, 1]);
    gl.uniform3fv(u.uEmission, mat.emission || [0, 0, 0]);
    gl.uniform3fv(u.uSpecColor, mat.spec || [0, 0, 0]);
    gl.uniform1f(u.uShininess, mat.shininess || 0);
    gl.uniform1f(u.uAlpha, mat.alpha === undefined ? 1 : mat.alpha);
    gl.uniform1f(u.uUnlit, mat.unlit ? 1 : 0);
    gl.uniform1f(u.uUseTex, mat.tex ? 1 : 0);
    if (mat.tex) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, mat.tex);
    }
  }

  setLighting(L) {
    const gl = this.gl, u = this.u;
    gl.uniform3fv(u.uAmbient, L.ambient);
    gl.uniform3fv(u.uLight0Dir, L.light0Dir);
    gl.uniform3fv(u.uLight0Color, L.light0Color);
    gl.uniform1f(u.uSpotOn, L.spotOn ? 1 : 0);
    gl.uniform3fv(u.uSpotColor, L.spotColor);
    gl.uniform1f(u.uSpotCutoff, L.spotCutoff);
    gl.uniform1f(u.uSpotExp, L.spotExp);
    gl.uniform1f(u.uSpotAtten, L.spotAtten);
    gl.uniform1f(u.uFogOn, L.fogOn ? 1 : 0);
    gl.uniform3fv(u.uFogColor, L.fogColor);
    gl.uniform1f(u.uFogStart, L.fogStart);
    gl.uniform1f(u.uFogEnd, L.fogEnd);
  }

  setClipPlanes(planes) {
    const gl = this.gl;
    gl.uniform1i(this.u.uClipCount, planes.length);
    for (let i = 0; i < planes.length && i < MAX_CLIP; i++) {
      gl.uniform4fv(this.uClip[i], planes[i]);
    }
  }

  // --- GL state wrappers (named to match the C calls) --------------------
  colorMask(on) { this.gl.colorMask(on, on, on, on); }
  depthMask(on) { this.gl.depthMask(on); }
  cullFace(front) { this.gl.cullFace(front ? this.gl.FRONT : this.gl.BACK); }
  stencilFunc(func, ref, mask) { this.gl.stencilFunc(func, ref, mask); }
  stencilOp(fail, zfail, zpass) { this.gl.stencilOp(fail, zfail, zpass); }
  enableCull(on) { on ? this.gl.enable(this.gl.CULL_FACE) : this.gl.disable(this.gl.CULL_FACE); }

  resize(w, h, dpr) {
    const gl = this.gl;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  beginFrame(clearColor) {
    const gl = this.gl;
    gl.clearColor(clearColor[0], clearColor[1], clearColor[2], 1);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
  }

  // Load a texture from a URL. BMPs decode in modern browsers via <img>; we
  // draw onto a power-of-two canvas so WebGL 1.0 can mipmap and REPEAT-wrap.
  loadTexture(url) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([128, 128, 128, 255]));
    const img = new Image();
    img.onload = () => {
      const pot = (x) => { let p = 1; while (p < x) p <<= 1; return Math.min(p, 1024); };
      const cv = document.createElement('canvas');
      cv.width = pot(img.width);
      cv.height = pot(img.height);
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    };
    img.onerror = () => { /* keep the grey placeholder */ };
    img.src = url;
    return tex;
  }
}
