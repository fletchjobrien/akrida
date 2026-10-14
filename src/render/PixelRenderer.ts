import {
  DepthTexture,
  GLSL3,
  Matrix4,
  Mesh,
  MeshDepthMaterial,
  NearestFilter,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  RGBADepthPacking,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  UnsignedIntType,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  WebGLRenderer,
} from 'three';
import { shared } from './shared';
import { glslRgb, PALETTE } from './palette';

/** Layer used for objects that cast shadows. */
export const SHADOW_LAYER = 1;

/** Low-res pixels per world unit at the normal art density. */
const BASE_PPU = 18;
const ZOOM_KEY = 'akrida.zoom';

/**
 * Zoom levels. `rows` is the target height of the low-res image; `world` is
 * how much more of the world to fit in it. Up to the default level, zooming
 * changes the pixel size. Past it, the pixel size stays and the world gets
 * smaller in pixels, so the chunky pixel-art look stays.
 */
const ZOOM_LEVELS = [
  { rows: 150, world: 1 },
  { rows: 180, world: 1 },
  { rows: 210, world: 1 },
  { rows: 250, world: 1 },
  { rows: 300, world: 1 },
  { rows: 300, world: 1.25 },
  { rows: 300, world: 1.5 },
];
const DEFAULT_ZOOM = 4;

function loadZoom(): number {
  try {
    const n = Number.parseInt(localStorage.getItem(ZOOM_KEY) ?? '', 10);
    if (Number.isInteger(n) && n >= 0 && n < ZOOM_LEVELS.length) return n;
  } catch {
    // storage blocked: use the default
  }
  return DEFAULT_ZOOM;
}

function saveZoom(i: number) {
  try {
    localStorage.setItem(ZOOM_KEY, String(i));
  } catch {
    // storage blocked: the zoom is simply not remembered
  }
}

const FULLSCREEN_VERT = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/**
 * Low-resolution post pass: outlines on silhouettes (depth edges), soft
 * highlights on creases (normal edges), the pixel cursor and the fade in.
 * Edge rules follow the approach t3ssel8r described for 3D pixel art.
 */
const POST_FRAG = /* glsl */ `
precision highp float;
precision highp int;
layout(location = 0) out vec4 outColor;
uniform sampler2D tColor;
uniform sampler2D tInfo;
uniform sampler2D tDepth;
uniform float uDepthRange;
uniform vec2 uCursor;
uniform float uCursorAlpha;
uniform float uCursorGlow;
uniform float uDark;
uniform float uBlur;
uniform float uGhost;
uniform float uDesat;
uniform float uVignette;
uniform vec3 uPersp;
uniform float uFeed;
uniform float uFeedFlash;
uniform float uFeedTime;
uniform float uFeedId;
uniform float uVoidOn;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float bayer4(vec2 p) {
  ivec2 i = ivec2(mod(p, 4.0));
  int idx = i.x + i.y * 4;
  const float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0,
                                3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[idx] + 0.5) / 16.0;
}

float depthAt(ivec2 p) {
  float z = texelFetch(tDepth, p, 0).r;
  if (uPersp.z < 0.5) return z * uDepthRange;
  // a perspective camera (a security camera's feed): back to distance along the view
  float n = uPersp.x;
  float f = uPersp.y;
  return 2.0 * n * f / (f + n - (z * 2.0 - 1.0) * (f - n));
}
vec3 normalAt(ivec2 p) {
  vec2 xy = texelFetch(tInfo, p, 0).rg * 2.0 - 1.0;
  return vec3(xy, sqrt(max(0.0, 1.0 - dot(xy, xy))));
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  // a security camera's feed: now and then a line of it slips sideways
  if (uFeed > 0.5) {
    float row = floor(gl_FragCoord.y);
    float tick = floor(uFeedTime * 12.0);
    if (hash12(vec2(row * 0.37, tick)) < 0.025 + 0.2 * uFeedFlash) p.x += int(hash12(vec2(row, tick + 7.0)) * 4.0) - 1;
  }
  vec4 c = texelFetch(tColor, p, 0);
  vec4 info = texelFetch(tInfo, p, 0);
  float d = depthAt(p);
  vec3 n = normalAt(p);

  ivec2 offs[4] = ivec2[4](ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1));
  float depthEdge = 0.0;
  float normalEdge = 0.0;
  const vec3 bias = normalize(vec3(1.0, 1.0, 0.6));
  for (int i = 0; i < 4; i++) {
    ivec2 q = p + offs[i];
    float dq = depthAt(q);
    float diff = dq - d;
    depthEdge += clamp(diff - 0.25, 0.0, 1.0);
    if (abs(diff) < 0.25) {
      vec3 nq = normalAt(q);
      float side = dot(n - nq, bias);
      normalEdge += side > 0.05 ? (1.0 - dot(n, nq)) : 0.0;
    }
  }

  vec3 col = c.rgb;
  // nothing drawn: inside the buried facility, the dark round its rooms
  if (c.a < 0.5 && uVoidOn > 0.5) col = ${glslRgb(0x0c0a0b)};
  if (depthEdge > 0.0 && info.b > 0.0) {
    col *= mix(1.0, 0.64, info.b);
  } else if (normalEdge > 0.18 && info.a > 0.0) {
    col = min(col * (1.0 + 0.32 * info.a) + 0.035 * info.a, vec3(1.0));
  }

  ivec2 size = textureSize(tColor, 0);

  // Waking up: blurred, doubled, drained of colour and swallowed by darkness.
  if (uBlur > 0.01) {
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 24; i++) {
      float r = sqrt((float(i) + 0.5) / 24.0) * uBlur;
      float a = float(i) * 2.39996;
      ivec2 q = clamp(p + ivec2(round(vec2(cos(a), sin(a)) * r)), ivec2(0), size - 1);
      acc += texelFetch(tColor, q, 0).rgb;
    }
    col = mix(col, acc / 24.0, clamp(uBlur, 0.0, 1.0));
  }
  if (uGhost > 0.01) {
    ivec2 q = clamp(p + ivec2(round(uGhost), 0), ivec2(0), size - 1);
    col = mix(col, texelFetch(tColor, q, 0).rgb, 0.4);
  }
  if (uDesat > 0.0) {
    float lum = dot(col, vec3(0.3, 0.59, 0.11));
    col = mix(col, vec3(lum) * vec3(1.0, 0.94, 0.9), uDesat);
  }
  if (uDark > 0.0 || uVignette > 0.0) {
    vec2 uv = (vec2(p) - vec2(size) * 0.5) / float(size.y);
    float vig = smoothstep(0.12, 0.85, length(uv)) * uVignette;
    float dark = clamp(uDark + vig * (1.0 - uDark), 0.0, 1.0);
    // fade in dithered steps, the way pixel art fades
    float dq = clamp(floor(dark * 8.0 + bayer4(gl_FragCoord.xy)) / 8.0, 0.0, 1.0);
    col = mix(col, ${glslRgb(0x140b0d)}, dq);
  }

  // A security camera's feed: grainy green-grey monochrome on a worn monitor,
  // scan lines, a slow rolling bar, snow, the corners of its frame, a blinking
  // record light and the camera's number as tally marks; a burst of snow when
  // it switches.
  if (uFeed > 0.5) {
    // a low-light camera: it sees warm things brighter than cold ones
    float lum = dot(col, vec3(0.62, 0.3, 0.08));
    lum = clamp((lum - 0.06) * 1.55, 0.0, 1.0);
    float bars = floor(lum * 6.0 + bayer4(gl_FragCoord.xy)) / 6.0;
    vec3 mono = mix(${glslRgb(0x0a120e)}, ${glslRgb(0xc8f0d0)}, bars);
    float roll = fract(uFeedTime * 0.11);
    float fy = gl_FragCoord.y / float(size.y);
    mono *= 1.0 + 0.12 * smoothstep(0.06, 0.0, abs(fy - (1.0 - roll)));
    if (int(gl_FragCoord.y) % 2 == 0) mono *= 0.8;
    float sn = hash12(gl_FragCoord.xy + floor(uFeedTime * 24.0) * 17.0);
    if (sn < 0.015 + 0.9 * uFeedFlash) mono = mix(mono, vec3(sn < 0.015 + 0.45 * uFeedFlash ? 0.85 : 0.05), 0.75);
    vec2 uv = (vec2(p) - vec2(size) * 0.5) / vec2(size) * 2.0;
    float vig = smoothstep(0.55, 1.35, length(uv * vec2(1.0, 0.9)));
    mono *= 1.0 - vig * 0.85;
    // its frame's corners
    ivec2 sz = size;
    ivec2 q = ivec2(gl_FragCoord.xy);
    int m = 5;
    int L = 9;
    bool cx = q.x == m || q.x == sz.x - 1 - m;
    bool cy = q.y == m || q.y == sz.y - 1 - m;
    bool nearX = q.x >= m && q.x < m + L || q.x <= sz.x - 1 - m && q.x > sz.x - 1 - m - L;
    bool nearY = q.y >= m && q.y < m + L || q.y <= sz.y - 1 - m && q.y > sz.y - 1 - m - L;
    if ((cx && nearY) || (cy && nearX)) mono = ${glslRgb(0xd8f8e0)};
    // the record light, blinking, and the camera's number in tally marks beside it
    vec2 rec = vec2(float(m + 5), float(sz.y - m - 6));
    if (length(gl_FragCoord.xy - rec) < 2.2 && fract(uFeedTime * 0.8) < 0.6) mono = ${glslRgb(0xff3a2a)};
    for (int k = 0; k < 4; k++) {
      if (float(k) > uFeedId) break;
      int tx = m + 11 + k * 3;
      if (q.x == tx && q.y <= sz.y - m - 3 && q.y >= sz.y - m - 9) mono = ${glslRgb(0xd8f8e0)};
    }
    col = mono;
  }

  // Pixel cursor: a small plus that fades out when the mouse rests. Over
  // something that can be used, it turns light blue.
  if (uCursorAlpha > 0.0) {
    ivec2 cp = ivec2(floor(uCursor));
    ivec2 dd = p - cp;
    int ad = abs(dd.x) + abs(dd.y);
    bool arm = (dd.x == 0 || dd.y == 0) && ad <= 2;
    if (arm) {
      vec3 cc = ad == 0 ? mix(${glslRgb(PALETTE.sandHi)}, ${glslRgb(0xe6f6ff)}, uCursorGlow)
                        : mix(${glslRgb(PALETTE.furDark)}, ${glslRgb(0x8ccaf2)}, uCursorGlow);
      col = mix(col, cc, uCursorAlpha);
    }
  }

  outColor = vec4(col, 1.0);
}
`;

/** Nearest-neighbour upscale with sub-texel offset for smooth scrolling. */
const BLIT_FRAG = /* glsl */ `
precision highp float;
layout(location = 0) out vec4 outColor;
uniform sampler2D tLow;
uniform vec2 uLowSize;
uniform vec2 uScreenSize;
uniform float uScale;
uniform vec2 uOffset;
void main() {
  vec2 lc = (gl_FragCoord.xy - uScreenSize * 0.5) / uScale + uLowSize * 0.5 + uOffset;
  ivec2 ip = clamp(ivec2(floor(lc)), ivec2(0), ivec2(uLowSize) - 1);
  outColor = texelFetch(tLow, ip, 0);
}
`;

export class PixelRenderer {
  readonly renderer: WebGLRenderer;
  readonly camera: OrthographicCamera;
  readonly shadowCam: OrthographicCamera;
  /** Low-res pixels per world unit (changes with the far zoom levels). */
  ppu = BASE_PPU;
  readonly pitch = (38 * Math.PI) / 180;
  readonly R = new Vector3(1, 0, 0);
  readonly U = new Vector3();
  readonly F = new Vector3();
  scale = 5;
  lowW = 0;
  lowH = 0;
  screenW = 0;
  screenH = 0;
  dpr = 1;
  /** Current zoom level; remembered between visits. */
  zoomIndex = loadZoom();
  /** Extra continuous zoom for cutscenes (2 = twice as close); the pixel size stays. */
  zoomMul = 1;
  private appliedZoomMul = 1;
  private basePpu = BASE_PPU;
  /** Continuous (unsnapped) focus point of the camera. */
  readonly focus = new Vector3();
  private readonly offset = new Vector2();
  private readonly camDist = 100;

  private mainRT!: WebGLRenderTarget;
  private postRT!: WebGLRenderTarget;
  private readonly shadowRT: WebGLRenderTarget;
  private readonly shadowSize = 2048;
  private readonly shadowExtent = 40;
  private readonly depthMat = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });

  private readonly quadCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly postScene = new Scene();
  private readonly blitScene = new Scene();
  private readonly postMat: ShaderMaterial;
  private readonly blitMat: ShaderMaterial;

  cursorScreen = new Vector2(-100, -100);
  cursorAlpha = 0;
  /** 0..1: the cursor is over something that can be clicked. */
  cursorGlow = 0;
  /** Screen effects, 0 = none. `dark` 1 is black; `blur` is a radius in low-res pixels. */
  dark = 1;
  blur = 0;
  ghost = 0;
  desat = 0;
  vignette = 0;
  /**
   * A security camera's feed: while set, the scene is drawn from this camera
   * instead, as a grainy monitor picture (`feedId` is its number, `feedFlash`
   * the snow of switching to it).
   */
  feedCam: PerspectiveCamera | null = null;
  feedId = 0;
  feedFlash = 0;
  feedTime = 0;
  /** Debugging: draw a feed without the monitor's look. */
  feedRaw = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    this.renderer.autoClear = false;
    this.renderer.setPixelRatio(1);

    const c = Math.cos(this.pitch);
    const s = Math.sin(this.pitch);
    this.U.set(0, c, -s);
    this.F.set(0, -s, -c);

    this.camera = new OrthographicCamera(-1, 1, 1, -1, 1, 220);
    const basis = new Matrix4().makeBasis(this.R, this.U, this.F.clone().negate());
    this.camera.quaternion.setFromRotationMatrix(basis);

    const e = this.shadowExtent;
    this.shadowCam = new OrthographicCamera(-e, e, e, -e, 1, 160);
    this.shadowCam.layers.set(SHADOW_LAYER);
    this.shadowRT = new WebGLRenderTarget(this.shadowSize, this.shadowSize, {
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      generateMipmaps: false,
      depthBuffer: true,
    });
    this.shadowRT.depthTexture = new DepthTexture(this.shadowSize, this.shadowSize, UnsignedIntType);
    shared.uShadowMap.value = this.shadowRT.depthTexture;

    const quad = new PlaneGeometry(2, 2);
    this.postMat = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: POST_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tColor: { value: null },
        tInfo: { value: null },
        tDepth: { value: null },
        uDepthRange: { value: 1 },
        uCursor: { value: new Vector2() },
        uCursorAlpha: { value: 0 },
        uCursorGlow: { value: 0 },
        uDark: { value: 1 },
        uBlur: { value: 0 },
        uGhost: { value: 0 },
        uDesat: { value: 0 },
        uVignette: { value: 0 },
        uPersp: { value: new Vector3(0, 1, 0) },
        uFeed: { value: 0 },
        uFeedFlash: { value: 0 },
        uFeedTime: { value: 0 },
        uFeedId: { value: 0 },
        uVoidOn: { value: 0 },
      },
    });
    const postMesh = new Mesh(quad, this.postMat);
    postMesh.frustumCulled = false;
    this.postScene.add(postMesh);

    this.blitMat = new ShaderMaterial({
      glslVersion: GLSL3,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: BLIT_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tLow: { value: null },
        uLowSize: { value: new Vector2() },
        uScreenSize: { value: new Vector2() },
        uScale: { value: 1 },
        uOffset: { value: this.offset },
      },
    });
    const blitMesh = new Mesh(quad, this.blitMat);
    blitMesh.frustumCulled = false;
    this.blitScene.add(blitMesh);

    this.resize();
  }

  private scaleFor(i: number) {
    return Math.max(1, Math.round(this.screenH / ZOOM_LEVELS[i].rows));
  }

  /** Step the zoom, skipping levels that look the same on this screen. */
  zoom(dir: number) {
    const look = (i: number) => `${this.scaleFor(i)}:${ZOOM_LEVELS[i].world}`;
    const current = look(this.zoomIndex);
    let i = this.zoomIndex;
    for (;;) {
      const next = Math.min(ZOOM_LEVELS.length - 1, Math.max(0, i + dir));
      if (next === i) break;
      i = next;
      if (look(i) !== current) break;
    }
    if (look(i) === current) return;
    this.zoomIndex = i;
    saveZoom(i);
    this.resize();
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.max(1, Math.floor(window.innerWidth * this.dpr));
    const h = Math.max(1, Math.floor(window.innerHeight * this.dpr));
    this.screenW = w;
    this.screenH = h;
    this.renderer.setSize(w, h, false);
    this.scale = this.scaleFor(this.zoomIndex);
    this.basePpu = BASE_PPU / ZOOM_LEVELS[this.zoomIndex].world;
    const lowW = Math.ceil(w / this.scale) + 2;
    const lowH = Math.ceil(h / this.scale) + 2;
    if (lowW !== this.lowW || lowH !== this.lowH || !this.mainRT) {
      this.lowW = lowW;
      this.lowH = lowH;
      this.allocateTargets();
    }

    this.applyProjection();
    this.updateBlitUniforms();
  }

  private applyProjection() {
    this.appliedZoomMul = this.zoomMul;
    this.ppu = this.basePpu * this.zoomMul;
    const hw = this.lowW / 2 / this.ppu;
    const hh = this.lowH / 2 / this.ppu;
    this.camera.left = -hw;
    this.camera.right = hw;
    this.camera.top = hh;
    this.camera.bottom = -hh;
    this.camera.updateProjectionMatrix();
    // Ground detail (pebbles, glints, ragged edges) sits on a world grid sized to one
    // pixel at the player's zoom. The cutscene zoom must not resize it, or the
    // pattern slides across the sand while the camera moves.
    shared.uPixelWorld.value.set(1 / this.basePpu, 1 / (this.basePpu * Math.sin(this.pitch)));
  }

  private allocateTargets() {
    const lowW = this.lowW;
    const lowH = this.lowH;
    this.mainRT?.dispose();
    this.mainRT?.depthTexture?.dispose();
    this.postRT?.dispose();

    this.mainRT = new WebGLRenderTarget(lowW, lowH, {
      count: 2,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      generateMipmaps: false,
      type: UnsignedByteType,
      depthBuffer: true,
    });
    this.mainRT.depthTexture = new DepthTexture(lowW, lowH, UnsignedIntType);
    this.postRT = new WebGLRenderTarget(lowW, lowH, {
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      generateMipmaps: false,
      depthBuffer: false,
    });
  }

  private updateBlitUniforms() {
    this.blitMat.uniforms.uLowSize.value.set(this.lowW, this.lowH);
    this.blitMat.uniforms.uScreenSize.value.set(this.screenW, this.screenH);
    this.blitMat.uniforms.uScale.value = this.scale;
  }

  /** View height in world units at the player's zoom, ignoring `zoomMul`. */
  get baseViewHeight() {
    return this.lowH / this.basePpu;
  }

  /** Visible half extents of the view in world units on the camera plane. */
  get halfView() {
    return { w: this.lowW / 2 / this.ppu, h: this.lowH / 2 / this.ppu };
  }

  /** Place the camera on `focus`, snapped to the texel grid. */
  setFocus(focus: Vector3) {
    if (this.zoomMul !== this.appliedZoomMul) this.applyProjection();
    this.focus.copy(focus);
    const fr = focus.dot(this.R);
    const fu = focus.dot(this.U);
    const ff = focus.dot(this.F);
    const tr = Math.round(fr * this.ppu);
    const tu = Math.round(fu * this.ppu);
    this.offset.set(fr * this.ppu - tr, fu * this.ppu - tu);
    shared.uCamTexel.value.set(tr, tu);
    const snapped = new Vector3()
      .addScaledVector(this.R, tr / this.ppu)
      .addScaledVector(this.U, tu / this.ppu)
      .addScaledVector(this.F, ff);
    this.camera.position.copy(snapped).addScaledVector(this.F, -this.camDist);
    this.camera.updateMatrixWorld();
  }

  /**
   * World offset (on the ground plane) that moves `p` onto the texel grid, so
   * a moving character keeps a stable pixel pattern.
   */
  snapDelta(p: Vector3, out: Vector3): Vector3 {
    const pr = p.dot(this.R) * this.ppu;
    const pu = p.dot(this.U) * this.ppu;
    const dr = (Math.round(pr) - pr) / this.ppu;
    const du = (Math.round(pu) - pu) / this.ppu;
    return out.set(dr, 0, -du / Math.sin(this.pitch));
  }

  /** Keep the shadow camera on `center`, snapped to shadow texels. */
  updateShadow(center: Vector3) {
    const L = shared.uSunDir.value;
    const cam = this.shadowCam;
    const up = Math.abs(L.y) > 0.99 ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0);
    const lz = L.clone();
    const lx = new Vector3().crossVectors(up, lz).normalize();
    const ly = new Vector3().crossVectors(lz, lx);
    const texel = (2 * this.shadowExtent) / this.shadowSize;
    const cx = Math.round(center.dot(lx) / texel) * texel;
    const cy = Math.round(center.dot(ly) / texel) * texel;
    const cz = center.dot(lz);
    const c = new Vector3().addScaledVector(lx, cx).addScaledVector(ly, cy).addScaledVector(lz, cz);
    cam.position.copy(c).addScaledVector(lz, 80);
    cam.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(lx, ly, lz));
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    const m = shared.uShadowMatrix.value;
    m.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    m.multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
  }

  /** Mouse (CSS px) to low-res pixel coordinates (before the blit offset). */
  screenToLow(mx: number, my: number, out: Vector2): Vector2 {
    const sx = mx * this.dpr;
    const sy = this.screenH - my * this.dpr;
    return out.set(
      (sx - this.screenW * 0.5) / this.scale + this.lowW * 0.5 + this.offset.x,
      (sy - this.screenH * 0.5) / this.scale + this.lowH * 0.5 + this.offset.y,
    );
  }

  /** Mouse (CSS px) to a point on the ground. */
  screenToGround(mx: number, my: number, height: (x: number, z: number) => number, out: Vector3) {
    const sx = ((mx * this.dpr - this.screenW * 0.5) / this.scale) / this.ppu;
    const sy = (-(my * this.dpr - this.screenH * 0.5) / this.scale) / this.ppu;
    const origin = new Vector3()
      .copy(this.focus)
      .addScaledVector(this.R, sx)
      .addScaledVector(this.U, sy)
      .addScaledVector(this.F, -this.camDist);
    let h = this.focus.y;
    for (let i = 0; i < 4; i++) {
      const t = (h - origin.y) / this.F.y;
      out.copy(origin).addScaledVector(this.F, t);
      h = height(out.x, out.z);
    }
    return out;
  }

  /**
   * Compile every shader the scene and the post passes need, in the
   * background where the browser can (KHR_parallel_shader_compile), so the
   * first frame does not stall the page.
   */
  precompile(scene: Scene) {
    const r = this.renderer;
    return Promise.all([
      r.compileAsync(scene, this.camera),
      r.compileAsync(this.postScene, this.quadCam),
      r.compileAsync(this.blitScene, this.quadCam),
    ]).then(() => undefined);
  }

  render(scene: Scene) {
    const r = this.renderer;

    // 1. Shadow depth from the sun.
    scene.overrideMaterial = this.depthMat;
    r.setRenderTarget(this.shadowRT);
    r.setClearColor(0xffffff, 1);
    r.clear(true, true, false);
    r.render(scene, this.shadowCam);
    scene.overrideMaterial = null;

    // 2. Scene into the low-res colour + normal/flags targets.
    r.setRenderTarget(this.mainRT);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    const cam = this.feedCam ?? this.camera;
    r.render(scene, cam);

    // 3. Edges, cursor, fade.
    const pu = this.postMat.uniforms;
    pu.tColor.value = this.mainRT.textures[0];
    pu.tInfo.value = this.mainRT.textures[1];
    pu.tDepth.value = this.mainRT.depthTexture;
    pu.uDepthRange.value = this.camera.far - this.camera.near;
    const fc = this.feedCam;
    (pu.uPersp.value as Vector3).set(fc ? fc.near : 0, fc ? fc.far : 1, fc ? 1 : 0);
    pu.uFeed.value = fc && !this.feedRaw ? 1 : 0;
    pu.uFeedFlash.value = this.feedFlash;
    pu.uFeedTime.value = this.feedTime;
    pu.uFeedId.value = this.feedId;
    pu.uVoidOn.value = shared.uVoid.value;
    this.screenToLow(this.cursorScreen.x, this.cursorScreen.y, pu.uCursor.value);
    pu.uCursorAlpha.value = this.cursorAlpha;
    pu.uCursorGlow.value = this.cursorGlow;
    pu.uDark.value = this.dark;
    pu.uBlur.value = this.blur;
    pu.uGhost.value = this.ghost;
    pu.uDesat.value = this.desat;
    pu.uVignette.value = this.vignette;
    r.setRenderTarget(this.postRT);
    r.render(this.postScene, this.quadCam);

    // 4. Upscale to the screen.
    this.blitMat.uniforms.tLow.value = this.postRT.texture;
    r.setRenderTarget(null);
    r.render(this.blitScene, this.quadCam);
  }
}
