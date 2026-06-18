// GLSL for the WebGL 1.0 port. One program does everything the fixed-function
// pipeline did: two lights (a directional key + a camera-mounted spotlight that
// acts as the player's flashlight), linear fog, optional texturing, material
// emission for the coloured start/end markers, and — since WebGL has no
// glClipPlane — up to MAX_CLIP shader clip planes used by the mirror recursion.
//
// All lighting is done in EYE space: the camera sits at the origin looking down
// -Z, so the spotlight is trivial and the clip planes (handed to us already in
// eye space) compare directly against the interpolated eye position.

export const MAX_CLIP = 6;

export const VERT = `
precision highp float;
attribute vec3 aPos;
attribute vec3 aNormal;
attribute vec2 aUV;

uniform mat4 uProj;
uniform mat4 uMV;       // modelview (view * model)
uniform mat3 uNormalMat;

varying vec3 vEye;      // eye-space position
varying vec3 vNormal;   // eye-space normal
varying vec2 vUV;

void main() {
  vec4 eye = uMV * vec4(aPos, 1.0);
  vEye = eye.xyz;
  vNormal = uNormalMat * aNormal;
  vUV = aUV;
  gl_Position = uProj * eye;
}
`;

export const FRAG = `
precision highp float;

varying vec3 vEye;
varying vec3 vNormal;
varying vec2 vUV;

uniform vec3 uAmbient;
uniform vec3 uLight0Dir;    // eye-space direction TO the key light
uniform vec3 uLight0Color;

uniform float uSpotOn;
uniform vec3 uSpotColor;
uniform float uSpotCutoff;  // cos of the cone half-angle
uniform float uSpotExp;
uniform float uSpotAtten;   // linear attenuation coefficient

uniform vec3 uBaseColor;
uniform vec3 uSpecColor;
uniform float uShininess;
uniform vec3 uEmission;
uniform float uAlpha;
uniform float uUnlit;       // 1.0 → emit uBaseColor flat (path line)

uniform float uUseTex;
uniform sampler2D uTex;

uniform float uFogOn;
uniform vec3 uFogColor;
uniform float uFogStart;
uniform float uFogEnd;

uniform int uClipCount;
uniform vec4 uClip[${MAX_CLIP}];

void main() {
  for (int i = 0; i < ${MAX_CLIP}; i++) {
    if (i >= uClipCount) break;
    if (dot(vEye, uClip[i].xyz) + uClip[i].w < 0.0) discard;
  }

  vec3 albedo = uBaseColor;
  if (uUseTex > 0.5) albedo *= texture2D(uTex, vUV).rgb;

  if (uUnlit > 0.5) {
    gl_FragColor = vec4(albedo, uAlpha);
    return;
  }

  vec3 N = normalize(vNormal);
  // Two-sided: walls/mech are viewed from inside reflected spaces too.
  vec3 V = normalize(-vEye);
  if (dot(N, V) < 0.0) N = -N;

  vec3 color = uEmission + uAmbient * albedo;

  // Key light (directional).
  vec3 L0 = normalize(uLight0Dir);
  color += uLight0Color * albedo * max(dot(N, L0), 0.0);

  // Camera spotlight / flashlight (positional at the eye, aimed down -Z).
  if (uSpotOn > 0.5) {
    vec3 toFrag = vEye;            // light is at the origin
    float dist = length(toFrag);
    vec3 L1 = -toFrag / max(dist, 1e-4);
    float spotCos = dot(normalize(toFrag), vec3(0.0, 0.0, -1.0));
    if (spotCos > uSpotCutoff) {
      float spot = pow(spotCos, uSpotExp);
      float atten = 1.0 / (1.0 + uSpotAtten * dist);
      float diff = max(dot(N, L1), 0.0);
      color += uSpotColor * albedo * diff * spot * atten;
      if (diff > 0.0 && uShininess > 0.0) {
        vec3 H = normalize(L1 + V);
        color += uSpecColor * pow(max(dot(N, H), 0.0), uShininess) * spot * atten;
      }
    }
  }

  if (uFogOn > 0.5) {
    float f = clamp((uFogEnd + vEye.z) / (uFogEnd - uFogStart), 0.0, 1.0);
    // vEye.z is negative in front of the camera, so -vEye.z is the distance.
    color = mix(uFogColor, color, f);
  }

  gl_FragColor = vec4(color, uAlpha);
}
`;
