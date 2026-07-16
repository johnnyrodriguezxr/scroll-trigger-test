import * as THREE from "three";

// ============================================================================
// Ink Box — the phone screen is the front pane of a sealed glass box holding
// a dark, viscous liquid (black ink / crude oil).
//
//  - Off-axis "fish-tank window" projection: the gyroscope quaternion moves a
//    virtual eye around the front pane, re-projecting the interior so you look
//    deeper into the box from new angles (all six interior walls exist).
//  - GPU shallow-water heightfield sim (ping-pong FBOs, fixed timestep): the
//    effective gravity vector from DeviceMotion accelerationIncludingGravity
//    tilts the equilibrium plane; plane *changes* are injected into the sim as
//    surface deviation, so tilting/shaking carries real momentum, waves
//    reflect off the walls, interfere, and settle with tunable viscosity.
//  - PBR-ish surface: Fresnel, analytic reflection of the box interior, sharp
//    specular from a procedural environment, refraction with Beer–Lambert
//    absorption (opaque at depth), meniscus, waterline caustic shimmer.
// ============================================================================

const params = new URLSearchParams(location.search);
const DEBUG = params.get("debug") === "1";
const AA = params.get("aa") !== "0";          // ?aa=0 → no MSAA (slow GPUs / tests)

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------
const SIM_DT = 1 / 240;        // fixed sim timestep (s)
const MAX_STEPS = 6;           // max sim substeps per rendered frame
const WAVE_SPEED = 0.42;       // target wave speed (m/s) — clamped for stability
const DAMP_V = 1.15;           // velocity damping (1/s): thick, overdamped settle
const H_SMOOTH = 0.045;        // per-step height diffusion: kills fine chop (viscosity)
const H_DECAY = 0.04;          // very slow drift of deviation back to 0 (1/s)
const FILL = 0.40;             // liquid fills 40% of the box
const EYE_DIST = 1.25;         // virtual head distance from the screen (box heights)
const SLOPE_TAU = 0.055;       // gravity → plane smoothing (s)
const ACC_TAU = 0.05;          // accelerometer low-pass (s)
const EYE_TAU = 0.09;          // eye smoothing (s)
const GRID_HI = THREE.MathUtils.clamp(parseInt(params.get("grid")) || 256, 64, 512);
const GRID_LO = Math.min(128, GRID_HI);
const DEGRADE_MS = 20;         // sustained frame time that triggers 128× degrade

// ---------------------------------------------------------------------------
// Box dimensions — height is 1 world unit, width follows the viewport aspect
// so the front face always maps exactly onto the screen.
// ---------------------------------------------------------------------------
function computeBox() {
  const aspect = window.innerWidth / window.innerHeight;
  const H = 1.0;
  const W = THREE.MathUtils.clamp(aspect, 0.42, 2.3) * H;
  const D = 1.25 * Math.max(W, H);           // interior depth (z ∈ [-D, 0])
  const floorY = -H / 2, topY = H / 2;
  const level = floorY + FILL * H;
  return { W, H, D, floorY, topY, level };
}
let BOX = computeBox();

// ---------------------------------------------------------------------------
// Renderer / camera. The camera never rotates: the box is glued to the screen
// and only the projection frustum (off-axis) + eye position change.
// ---------------------------------------------------------------------------
const app = document.getElementById("app");
const renderer = new THREE.WebGLRenderer({ antialias: AA });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 12);

// Generalized off-axis frustum through the front-face rectangle (Kooima).
const NEAR = 0.05, FAR = 12;
function applyOffAxis(eye) {
  const ez = Math.max(eye.z, 0.28);
  const s = NEAR / ez;
  camera.position.set(eye.x, eye.y, ez);
  camera.quaternion.identity();
  camera.projectionMatrix.makePerspective(
    (-BOX.W / 2 - eye.x) * s, (BOX.W / 2 - eye.x) * s,
    (BOX.H / 2 - eye.y) * s, (-BOX.H / 2 - eye.y) * s,
    NEAR, FAR
  );
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

// ---------------------------------------------------------------------------
// Shared shader chunk: sim-texture sampling, surface height, interior shading
// used by the surface, the walls and the liquid "skirts".
// ---------------------------------------------------------------------------
const COMMON_GLSL = /* glsl */`
  uniform vec2  uSize;      // (W, D)
  uniform float uFloorY;
  uniform float uTopY;
  uniform float uLevel;
  uniform vec2  uSlope;     // equilibrium plane gradient (dy/dx, dy/dz)
  uniform sampler2D uHeight;
  uniform vec2  uTexel;
  uniform float uTime;
  uniform vec3  uAbsorb;    // Beer–Lambert absorption per channel (1/m)
  uniform vec3  uInk;       // in-scatter tint of the ink

  const vec3 L1 = vec3(0.3491, 0.8479, 0.3990);   // key light dir
  const vec3 L2 = vec3(-0.6198, 0.7325, -0.2817); // cool fill dir

  vec2 simUV(vec2 xz) {
    return vec2(xz.x / uSize.x + 0.5, xz.y / uSize.y + 1.0);
  }
  float rawH(vec2 uv) { return texture2D(uHeight, uv).r; }

  // Total surface height: fill level + tilted equilibrium plane + sim deviation
  float surfaceY(vec2 xz) {
    float y = uLevel + uSlope.x * xz.x + uSlope.y * (xz.y + uSize.y * 0.5)
            + rawH(simUV(xz));
    return clamp(y, uFloorY + 0.006, uTopY - 0.006);
  }

  // Dark minimal interior — brighter upward and toward the glass front,
  // vignetted into the corners so the liquid stays the hero.
  vec3 wallBase(vec3 p) {
    float up = smoothstep(uFloorY, uTopY, p.y);
    vec3 col = mix(vec3(0.020, 0.021, 0.024), vec3(0.085, 0.088, 0.098), up * up);
    col *= mix(0.50, 1.12, smoothstep(-uSize.y, 0.0, p.z));
    vec2 q = vec2(p.x / (uSize.x * 0.5), (p.z + uSize.y * 0.5) / (uSize.y * 0.5));
    col *= 1.0 - 0.42 * smoothstep(0.55, 1.4, length(q));
    return col;
  }

  // What a ray sees when it leaves through the front glass: a dark room with
  // a soft overhead glow and the key light itself.
  vec3 envColor(vec3 d) {
    vec3 c = vec3(0.010, 0.011, 0.014);
    c += vec3(0.10, 0.10, 0.12) * pow(max(d.y, 0.0), 3.0);
    c += vec3(0.95, 0.88, 0.72) * pow(max(dot(d, L1), 0.0), 60.0) * 0.55;
    return c;
  }

  // Analytic ray → box-interior intersection, shading whichever wall is hit.
  // Rays exiting the front pane (z = 0) continue into the room env.
  vec3 shadeInterior(vec3 ro, vec3 rd) {
    vec3 t3;
    t3.x = abs(rd.x) > 1e-5 ? ((rd.x > 0.0 ? uSize.x * 0.5 : -uSize.x * 0.5) - ro.x) / rd.x : 1e9;
    t3.y = abs(rd.y) > 1e-5 ? ((rd.y > 0.0 ? uTopY : uFloorY) - ro.y) / rd.y : 1e9;
    t3.z = abs(rd.z) > 1e-5 ? ((rd.z > 0.0 ? 0.0 : -uSize.y) - ro.z) / rd.z : 1e9;
    float t = min(t3.x, min(t3.y, t3.z));
    if (t == t3.z && rd.z > 0.0) return envColor(rd);
    vec3 p = ro + rd * max(t, 0.0);
    vec3 c = wallBase(p);
    float yw = uLevel + uSlope.x * p.x + uSlope.y * (p.z + uSize.y * 0.5);
    if (p.y < yw) c *= 0.22;   // submerged walls read near-black
    return c;
  }

  // Tight glossy highlight + softer halo from the two procedural lights.
  vec3 specular(vec3 R) {
    float d1 = max(dot(R, L1), 0.0);
    float d2 = max(dot(R, L2), 0.0);
    float s1 = pow(d1, 1600.0) * 7.0 + pow(d1, 90.0) * 0.55;
    float s2 = pow(d2, 300.0) * 1.1;
    return vec3(1.0, 0.97, 0.90) * s1 + vec3(0.72, 0.80, 0.95) * s2;
  }
`;

const sharedUniforms = {
  uSize:   { value: new THREE.Vector2(BOX.W, BOX.D) },
  uFloorY: { value: BOX.floorY },
  uTopY:   { value: BOX.topY },
  uLevel:  { value: BOX.level },
  uSlope:  { value: new THREE.Vector2(0, 0) },
  uHeight: { value: null },
  uTexel:  { value: new THREE.Vector2(1 / GRID_HI, 1 / GRID_HI) },
  uTime:   { value: 0 },
  uAbsorb: { value: new THREE.Vector3(9.0, 14.0, 11.5) },  // warm-dark w/ blue hint
  uInk:    { value: new THREE.Vector3(0.016, 0.013, 0.018) },
  uEye:    { value: new THREE.Vector3(0, 0, EYE_DIST) },
};

// ---------------------------------------------------------------------------
// GPU shallow-water heightfield: ping-pong FBOs storing (height, velocity).
// Clamp-to-edge sampling gives Neumann boundaries → waves reflect off walls.
// The equilibrium-plane *delta* is subtracted from h each step: when gravity
// tilts, the absolute surface initially stays put (inertia) and then flows to
// the new plane through the wave equation — real slosh, not layered sines.
// ---------------------------------------------------------------------------
class LiquidSim {
  constructor(renderer, n) {
    this.renderer = renderer;
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.scene = new THREE.Scene();

    const gl = renderer.getContext();
    const floatOK = renderer.extensions.get("EXT_color_buffer_float") &&
                    gl.getExtension("OES_texture_float_linear");
    this.type = floatOK ? THREE.FloatType : THREE.HalfFloatType;

    this.updateMat = new THREE.ShaderMaterial({
      uniforms: {
        uPrev:    { value: null },
        uTexel:   { value: new THREE.Vector2() },
        uDomain:  { value: new THREE.Vector2(BOX.W, BOX.D) },
        uDt:      { value: SIM_DT },
        uC:       { value: WAVE_SPEED },
        uDampV:   { value: DAMP_V },
        uSmooth:  { value: H_SMOOTH },
        uDecay:   { value: H_DECAY },
        uDSlope:  { value: new THREE.Vector2() },
        uImpulse: { value: new THREE.Vector4(0, 0, 1, 0) }, // uv.xy, radius, strength
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */`
        precision highp float;
        uniform sampler2D uPrev;
        uniform vec2 uTexel, uDomain, uDSlope;
        uniform float uDt, uC, uDampV, uSmooth, uDecay;
        uniform vec4 uImpulse;
        varying vec2 vUv;
        void main() {
          vec2 cell = uDomain * uTexel;
          vec2 hv = texture2D(uPrev, vUv).rg;
          float h = hv.r, v = hv.g;
          float hl = texture2D(uPrev, vUv - vec2(uTexel.x, 0.0)).r;
          float hr = texture2D(uPrev, vUv + vec2(uTexel.x, 0.0)).r;
          float hb = texture2D(uPrev, vUv - vec2(0.0, uTexel.y)).r;
          float ht = texture2D(uPrev, vUv + vec2(0.0, uTexel.y)).r;
          float lap = (hl + hr - 2.0 * h) / (cell.x * cell.x)
                    + (hb + ht - 2.0 * h) / (cell.y * cell.y);
          v += uC * uC * lap * uDt;
          if (uImpulse.w != 0.0) {
            float d = length((vUv - uImpulse.xy) * uDomain);
            v += uImpulse.w * exp(-d * d / (uImpulse.z * uImpulse.z));
          }
          v *= exp(-uDampV * uDt);
          h += v * uDt;
          // gravity plane moved under the liquid → keep absolute surface,
          // store the new deviation (this is what injects slosh momentum)
          vec2 p = (vUv - 0.5) * uDomain;
          h -= uDSlope.x * p.x + uDSlope.y * p.y;
          float avg = (hl + hr + hb + ht) * 0.25;
          h = mix(h, avg, uSmooth);
          h *= exp(-uDecay * uDt);
          h = clamp(h, -0.5, 0.5);
          gl_FragColor = vec4(h, v, 0.0, 1.0);
        }
      `,
      depthTest: false, depthWrite: false,
    });

    this.blitMat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: null } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy,0.,1.); }`,
      fragmentShader: `precision highp float; uniform sampler2D uTex; varying vec2 vUv;
        void main(){ gl_FragColor = texture2D(uTex, vUv); }`,
      depthTest: false, depthWrite: false,
    });

    // 8-bit encode pass so debug probes can read the sim state anywhere
    this.encodeMat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: null } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy,0.,1.); }`,
      fragmentShader: `precision highp float; uniform sampler2D uTex; varying vec2 vUv;
        void main(){ vec2 hv = texture2D(uTex, vUv).rg;
          gl_FragColor = vec4(clamp(hv.r*1.5+0.5,0.,1.), clamp(hv.g*0.25+0.5,0.,1.), 0., 1.); }`,
      depthTest: false, depthWrite: false,
    });

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.updateMat);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    this.debugRT = new THREE.WebGLRenderTarget(32, 32, { depthBuffer: false });
    this._alloc(n);
  }

  _makeRT(n) {
    return new THREE.WebGLRenderTarget(n, n, {
      type: this.type,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
    });
  }

  _alloc(n) {
    this.n = n;
    this.rtA = this._makeRT(n);
    this.rtB = this._makeRT(n);
    for (const rt of [this.rtA, this.rtB]) {
      this.renderer.setRenderTarget(rt);
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.clear(true, false, false);
    }
    this.renderer.setRenderTarget(null);
    this.updateMat.uniforms.uTexel.value.set(1 / n, 1 / n);
  }

  get texture() { return this.rtA.texture; }

  step(dSlopeX, dSlopeZ, impulse) {
    const u = this.updateMat.uniforms;
    u.uPrev.value = this.rtA.texture;
    u.uDomain.value.set(BOX.W, BOX.D);
    u.uDSlope.value.set(dSlopeX, dSlopeZ);
    // explicit-scheme stability guard: c·dt/dx must stay below ~0.7
    const cell = Math.min(BOX.W, BOX.D) / this.n;
    u.uC.value = Math.min(WAVE_SPEED, 0.62 * cell / SIM_DT);
    if (impulse) u.uImpulse.value.set(impulse.u, impulse.v, impulse.r, impulse.s);
    else u.uImpulse.value.w = 0;
    this.quad.material = this.updateMat;
    this.renderer.setRenderTarget(this.rtB);
    this.renderer.render(this.scene, this.cam);
    this.renderer.setRenderTarget(null);
    [this.rtA, this.rtB] = [this.rtB, this.rtA];
  }

  resize(n) {
    if (n === this.n) return;
    const old = this.rtA, oldB = this.rtB;
    this._alloc(n);
    this.blitMat.uniforms.uTex.value = old.texture;   // carry the state over
    this.quad.material = this.blitMat;
    this.renderer.setRenderTarget(this.rtA);
    this.renderer.render(this.scene, this.cam);
    this.renderer.setRenderTarget(null);
    old.dispose(); oldB.dispose();
  }

  // max |height deviation| — used by the Playwright harness to prove sloshing
  probeMaxH() {
    this.encodeMat.uniforms.uTex.value = this.rtA.texture;
    this.quad.material = this.encodeMat;
    this.renderer.setRenderTarget(this.debugRT);
    this.renderer.render(this.scene, this.cam);
    const px = new Uint8Array(32 * 32 * 4);
    this.renderer.readRenderTargetPixels(this.debugRT, 0, 0, 32, 32, px);
    this.renderer.setRenderTarget(null);
    let m = 0;
    for (let i = 0; i < px.length; i += 4) m = Math.max(m, Math.abs(px[i] / 255 - 0.5));
    return m / 1.5;
  }
}

const sim = new LiquidSim(renderer, GRID_HI);
sharedUniforms.uTexel.value.set(1 / sim.n, 1 / sim.n);

// ---------------------------------------------------------------------------
// Meshes. All geometry is unit-sized; world size comes from uniforms/scales so
// resizes never rebuild buffers.
// ---------------------------------------------------------------------------
const TONEMAP = `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;

// --- interior walls (BackSide box: the front pane self-culls while the eye
// --- is outside, so the screen stays an open window into the box)
const wallMat = new THREE.ShaderMaterial({
  uniforms: sharedUniforms,
  side: THREE.BackSide,
  vertexShader: /* glsl */`
    varying vec3 vWorld;
    void main() {
      vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    ${COMMON_GLSL}
    varying vec3 vWorld;
    void main() {
      vec3 col = wallBase(vWorld);
      vec2 xz = clamp(vWorld.xz, vec2(-uSize.x * 0.5, -uSize.y), vec2(uSize.x * 0.5, 0.0));
      float yw = surfaceY(xz);
      if (vWorld.y < yw) { col *= 0.12; col += uInk * 0.4; }
      // faint caustic shimmer hugging the waterline, driven by the sim's
      // surface gradient so it dances only while waves are alive
      vec2 uv = simUV(xz);
      float e = 2.0 * uTexel.x;
      float gx = rawH(uv + vec2(e, 0.0)) - rawH(uv - vec2(e, 0.0));
      float gz = rawH(uv + vec2(0.0, e)) - rawH(uv - vec2(0.0, e));
      float band = exp(-pow((vWorld.y - yw) * 22.0, 2.0));
      float dance = 0.5 + 0.5 * sin(uTime * 3.1 + vWorld.x * 23.0 + vWorld.z * 17.0);
      col += band * (0.10 + 30.0 * (abs(gx) + abs(gz))) * dance * vec3(0.030, 0.038, 0.046);
      gl_FragColor = vec4(col, 1.0);
      ${"#include <tonemapping_fragment>"}
      ${"#include <colorspace_fragment>"}
    }
  `,
});
const wallMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), wallMat);
wallMesh.frustumCulled = false;
scene.add(wallMesh);

// subtle edge lines so the box volume reads even in the dark
const edgeMesh = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
  new THREE.LineBasicMaterial({ color: 0x30333b, transparent: true, opacity: 0.45 })
);
edgeMesh.frustumCulled = false;
scene.add(edgeMesh);

function layoutBoxMeshes() {
  wallMesh.scale.set(BOX.W, BOX.H, BOX.D);
  wallMesh.position.set(0, 0, -BOX.D / 2);
  edgeMesh.scale.copy(wallMesh.scale);
  edgeMesh.position.copy(wallMesh.position);
}
layoutBoxMeshes();

// --- liquid surface: displaced grid, shaded with Fresnel-weighted analytic
// --- interior reflection + Beer–Lambert refraction into the dark volume
const surfMat = new THREE.ShaderMaterial({
  uniforms: sharedUniforms,
  side: THREE.DoubleSide,
  vertexShader: /* glsl */`
    ${COMMON_GLSL}
    varying vec3 vWorld;
    varying float vEdge;
    void main() {
      vec2 xz = vec2((uv.x - 0.5) * uSize.x, (uv.y - 1.0) * uSize.y);
      float y = surfaceY(xz);
      // meniscus: a whisper of capillary rise against the glass
      float ew = min(min(uSize.x * 0.5 - abs(xz.x), -xz.y), xz.y + uSize.y);
      y += 0.006 * exp(-max(ew, 0.0) / 0.009);
      vEdge = ew;
      vWorld = vec3(xz.x, min(y, uTopY - 0.004), xz.y);
      gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    ${COMMON_GLSL}
    uniform vec3 uEye;
    varying vec3 vWorld;
    varying float vEdge;
    void main() {
      vec2 uv = simUV(vWorld.xz);
      float e = 1.5 * uTexel.x;
      float gx = uSlope.x + (rawH(uv + vec2(e, 0.0)) - rawH(uv - vec2(e, 0.0))) / (2.0 * e * uSize.x);
      float gz = uSlope.y + (rawH(uv + vec2(0.0, e)) - rawH(uv - vec2(0.0, e))) / (2.0 * e * uSize.y);
      // micro-shimmer so the gloss breaks up ever so slightly
      gx += 0.0045 * sin(vWorld.x * 160.0 + uTime * 2.1) * sin(vWorld.z * 140.0 - uTime * 1.7);
      gz += 0.0045 * sin(vWorld.x * 130.0 - uTime * 1.9) * sin(vWorld.z * 170.0 + uTime * 2.3);
      vec3 n = normalize(vec3(-gx, 1.0, -gz));

      vec3 V = normalize(uEye - vWorld);
      float cosT = clamp(dot(V, n), 0.0, 1.0);
      float F = 0.045 + 0.955 * pow(1.0 - cosT, 5.0);

      vec3 R = reflect(-V, n);
      if (R.y < 0.02) R.y = 0.02;                    // grazing rays skim the surface
      R = normalize(R);
      vec3 refl = shadeInterior(vWorld + n * 0.002, R) + specular(R);

      vec3 refr;
      vec3 T = refract(-V, n, 1.0 / 1.47);
      if (dot(T, T) < 1e-6) {
        refr = refl;                                  // total internal reflection
      } else {
        // distance the refracted ray travels through the ink before a wall
        vec3 ro = vWorld;
        vec3 t3;
        t3.x = abs(T.x) > 1e-5 ? ((T.x > 0.0 ? uSize.x * 0.5 : -uSize.x * 0.5) - ro.x) / T.x : 1e9;
        t3.y = abs(T.y) > 1e-5 ? ((T.y > 0.0 ? uTopY : uFloorY) - ro.y) / T.y : 1e9;
        t3.z = abs(T.z) > 1e-5 ? ((T.z > 0.0 ? 0.0 : -uSize.y) - ro.z) / T.z : 1e9;
        float t = max(min(t3.x, min(t3.y, t3.z)), 0.0);
        vec3 hit = ro + T * t;
        vec3 trans = exp(-uAbsorb * t);               // Beer–Lambert: opaque at depth
        refr = wallBase(hit) * 0.5 * trans + uInk * (1.0 - exp(-3.5 * t));
      }

      vec3 col = mix(refr, refl, F);
      // meniscus shadow ring where the liquid meets the glass
      col *= 1.0 - 0.38 * (1.0 - smoothstep(0.0, 0.016, max(vEdge, 0.0)));
      gl_FragColor = vec4(col, 1.0);
      ${"#include <tonemapping_fragment>"}
      ${"#include <colorspace_fragment>"}
    }
  `,
});
const surfMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 144, 144), surfMat);
surfMesh.frustumCulled = false;
scene.add(surfMesh);

// --- liquid skirts: opaque dark curtains from the surface rim down to the
// --- floor along each wall, so the volume reads as solid ink from any angle
// --- (including the cross-section pressed against the front glass).
function makeSkirt(axis, fixed) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...sharedUniforms,
      uAxis:  { value: axis },
      uFixed: { value: fixed },
    },
    side: THREE.DoubleSide,
    vertexShader: /* glsl */`
      ${COMMON_GLSL}
      uniform float uAxis;
      uniform float uFixed;
      varying vec3 vWorld;
      varying float vYSurf;
      void main() {
        vec2 xz = (uAxis < 0.5)
          ? vec2((uv.x - 0.5) * uSize.x, uFixed)
          : vec2(uFixed, -uv.x * uSize.y);
        float ys = surfaceY(xz);
        float y = mix(uFloorY + 0.002, ys, uv.y);
        vWorld = vec3(xz.x, y, xz.y);
        vYSurf = ys;
        gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      ${COMMON_GLSL}
      varying vec3 vWorld;
      varying float vYSurf;
      void main() {
        float depth = max(vYSurf - vWorld.y, 0.0);
        vec3 col = vec3(0.003, 0.003, 0.004);
        col += vec3(0.034, 0.024, 0.028) * exp(-depth * 30.0); // thin glow at the rim
        col += uInk * exp(-depth * 9.0);
        gl_FragColor = vec4(col, 1.0);
        ${"#include <tonemapping_fragment>"}
        ${"#include <colorspace_fragment>"}
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 160, 1), mat);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return mesh;
}
const INSET = 0.004;
const skirts = [makeSkirt(0, 0), makeSkirt(0, 0), makeSkirt(1, 0), makeSkirt(1, 0)];
function layoutSkirts() {
  skirts[0].material.uniforms.uFixed.value = -INSET;                // front glass
  skirts[1].material.uniforms.uFixed.value = -BOX.D + INSET;        // back wall
  skirts[2].material.uniforms.uFixed.value = -BOX.W / 2 + INSET;    // left
  skirts[3].material.uniforms.uFixed.value = BOX.W / 2 - INSET;     // right
}
layoutSkirts();

// ---------------------------------------------------------------------------
// Sensors — DeviceOrientation drives the eye (off-axis window), DeviceMotion's
// accelerationIncludingGravity drives the liquid (effective gravity = gravity
// minus device acceleration, so shaking sloshes it for free).
// ---------------------------------------------------------------------------
const sensor = {
  quat: new THREE.Quaternion(),
  quatZero: null,
  hasOrient: false,
  accRaw: new THREE.Vector3(0, -9.81, 0),
  hasAcc: false,
  signAccum: 0,        // auto-calibrates the iOS/Android accelerometer sign flip
  lastAt: -1e9,
  orientCount: 0,
  motionCount: 0,
  // "level" reference: rotates the resting grip's gravity to straight-down so
  // the liquid sits at the bottom of the SCREEN however the phone is held
  gRef: new THREE.Quaternion(),
  gRefSet: false,
  activeAt: 0,
};

const _euler = new THREE.Euler();
const _qScreen = new THREE.Quaternion();
const _qNeg90X = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);
const _zee = new THREE.Vector3(0, 0, 1);

function onOrientation(e) {
  if (e.alpha == null && e.beta == null && e.gamma == null) return;
  const alpha = THREE.MathUtils.degToRad(e.alpha || 0);
  const beta = THREE.MathUtils.degToRad(e.beta || 0);
  const gamma = THREE.MathUtils.degToRad(e.gamma || 0);
  const orient = THREE.MathUtils.degToRad(screen.orientation?.angle ?? window.orientation ?? 0);
  _euler.set(beta, alpha, -gamma, "YXZ");
  sensor.quat.setFromEuler(_euler);
  sensor.quat.multiply(_qNeg90X);
  sensor.quat.multiply(_qScreen.setFromAxisAngle(_zee, -orient));
  if (!sensor.quatZero) sensor.quatZero = sensor.quat.clone();
  sensor.hasOrient = true;
  sensor.lastAt = performance.now();
  sensor.orientCount++;
}

function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || (a.x == null && a.y == null && a.z == null)) return;
  sensor.accRaw.set(a.x || 0, a.y || 0, a.z || 0);
  if (sensor.accRaw.lengthSq() > 1) {
    sensor.hasAcc = true;
    sensor.lastAt = performance.now();
    sensor.motionCount++;
  }
}

function startSensors() {
  window.addEventListener("deviceorientation", onOrientation, true);
  window.addEventListener("devicemotion", onMotion, true);
}

// ---------------------------------------------------------------------------
// Drag fallback (desktop / motion denied): dragging tilts the box — the eye
// orbits to look deeper in, and gravity tilts in box space so the ink flows.
// Double-click / double-tap pokes the surface (and re-zeros gyro if active).
// ---------------------------------------------------------------------------
const drag = { pitch: 0, yaw: 0, roll: 0, active: false, lastX: 0, lastY: 0 };
let pendingImpulse = null;
const canvas = renderer.domElement;

canvas.addEventListener("pointerdown", (e) => {
  drag.active = true;
  drag.lastX = e.clientX;
  drag.lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
  hideHintSoon();
});
canvas.addEventListener("pointermove", (e) => {
  if (!drag.active) return;
  const k = 0.005;
  drag.yaw = THREE.MathUtils.clamp(drag.yaw - (e.clientX - drag.lastX) * k, -0.65, 0.65);
  drag.roll = THREE.MathUtils.clamp(drag.roll - (e.clientX - drag.lastX) * k * 0.7, -0.5, 0.5);
  drag.pitch = THREE.MathUtils.clamp(drag.pitch - (e.clientY - drag.lastY) * k, -0.55, 0.55);
  drag.lastX = e.clientX;
  drag.lastY = e.clientY;
});
const endDrag = () => (drag.active = false);
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

function splashAt(clientX, clientY, strength = -2.6) {
  // screen → front-pane point (they coincide under the off-axis projection),
  // then cast from the eye through it onto the liquid plane
  const px = (clientX / window.innerWidth - 0.5) * BOX.W;
  const py = (0.5 - clientY / window.innerHeight) * BOX.H;
  const E = eyeSmooth;
  const dir = new THREE.Vector3(px - E.x, py - E.y, 0 - E.z);
  let u = 0.5, v = 0.85;
  if (dir.y < -1e-4) {
    const t = (BOX.level - E.y) / dir.y;
    if (t > 0) {
      const hx = E.x + dir.x * t, hz = E.z + dir.z * t;
      u = THREE.MathUtils.clamp(hx / BOX.W + 0.5, 0.04, 0.96);
      v = THREE.MathUtils.clamp(hz / BOX.D + 1.0, 0.04, 0.96);
    }
  }
  pendingImpulse = { u, v, r: Math.max(0.05, BOX.W * 0.09), s: strength };
}

let lastTap = 0;
canvas.addEventListener("pointerdown", (e) => {
  const now = performance.now();
  if (now - lastTap < 300) {
    splashAt(e.clientX, e.clientY);
    if (gyroActive() || motionActive()) {
      captureLevel();
      toast("Re-leveled");
    }
  }
  lastTap = now;
});

function gyroActive() {
  return sensor.hasOrient && performance.now() - sensor.lastAt < 1500;
}
function motionActive() {
  return sensor.hasAcc && performance.now() - sensor.lastAt < 1500;
}

// ---------------------------------------------------------------------------
// Motion permission flow — iOS 13+ requires DeviceMotionEvent.requestPermission
// (motion, not just orientation) inside a user tap on HTTPS.
// ---------------------------------------------------------------------------
const motionBtn = document.getElementById("motionBtn");
const hint = document.getElementById("hint");
const toastEl = document.getElementById("toast");

let hintTimer;
function hideHintSoon(ms = 4000) {
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => hint.classList.add("hidden"), ms);
}
let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2500);
}

const needsPermission =
  typeof DeviceMotionEvent !== "undefined" &&
  typeof DeviceMotionEvent.requestPermission === "function";

if (needsPermission) {
  motionBtn.style.display = "block";
  hint.textContent = "Tap Enable Motion, then tilt & shake the box";
  motionBtn.addEventListener("click", async () => {
    try {
      const motionState = await DeviceMotionEvent.requestPermission();
      if (typeof DeviceOrientationEvent !== "undefined" &&
          typeof DeviceOrientationEvent.requestPermission === "function") {
        try { await DeviceOrientationEvent.requestPermission(); } catch { /* same prompt on iOS */ }
      }
      motionBtn.style.display = "none";
      if (motionState === "granted") {
        startSensors();
        hint.textContent = "Tilt & shake — double-tap to poke the ink";
        hideHintSoon();
      } else {
        toast("Motion denied — drag to tilt, double-tap to splash");
      }
    } catch {
      motionBtn.style.display = "none";
      toast("Motion unavailable — drag to tilt, double-tap to splash");
    }
  });
} else if (typeof DeviceMotionEvent !== "undefined" || typeof DeviceOrientationEvent !== "undefined") {
  startSensors(); // Android / desktop: no gate; synthetic or real events just work
  hint.textContent = "Tilt & shake — or drag to tilt, double-click to splash";
  hideHintSoon(5000);
} else {
  hint.textContent = "Drag to tilt the box — double-click to splash";
  hideHintSoon(5000);
}

// ---------------------------------------------------------------------------
// Main loop: gravity → equilibrium plane, fixed-timestep sim, off-axis eye.
// ---------------------------------------------------------------------------
const gravity = new THREE.Vector3(0, -9.81, 0);   // re-leveled gravity used by the sim
const gDev = new THREE.Vector3(0, -9.81, 0);      // smoothed gravity, raw device frame
const gTarget = new THREE.Vector3(0, -9.81, 0);
const accLP = new THREE.Vector3(0, 9.81, 0);      // low-passed raw accelerometer
const DOWN = new THREE.Vector3(0, -1, 0);
const slope = new THREE.Vector2(0, 0);            // smoothed plane gradient
const slopePrev = new THREE.Vector2(0, 0);
const eyeSmooth = new THREE.Vector3(0, 0, EYE_DIST);
const eyeTarget = new THREE.Vector3(0, 0, EYE_DIST);
const _qTmp = new THREE.Quaternion();
const _vTmp = new THREE.Vector3();

let simAccum = 0;
let frameMs = 16.7;
let frameCount = 0;
let slowFrames = 0;
const clock = new THREE.Clock();

// Anchor "level" to the current grip: from now on this pose means the liquid
// rests flat at the bottom of the screen. Also re-anchors the eye.
function captureLevel() {
  _vTmp.copy(gDev).normalize();
  sensor.gRef.setFromUnitVectors(_vTmp, DOWN);
  sensor.gRefSet = true;
  if (sensor.hasOrient) sensor.quatZero = sensor.quat.clone();
}

function updateGravity(dt) {
  const useAcc = motionActive();
  const useOri = !useAcc && gyroActive();
  if (useAcc) {
    // auto-calibrate the accelerometer sign against orientation-derived
    // gravity (iOS historically reports the negated convention)
    accLP.lerp(sensor.accRaw, 1 - Math.exp(-dt / 0.4));
    if (sensor.hasOrient) {
      _vTmp.set(0, -1, 0).applyQuaternion(_qTmp.copy(sensor.quat).invert());
      sensor.signAccum = THREE.MathUtils.clamp(
        sensor.signAccum + Math.sign(_vTmp.dot(accLP) * -1) * dt, -3, 3);
    }
    const sign = sensor.signAccum >= 0 ? 1 : -1;
    gTarget.copy(sensor.accRaw).multiplyScalar(-sign);
  } else if (useOri) {
    gTarget.set(0, -9.81, 0).applyQuaternion(_qTmp.copy(sensor.quat).invert());
  } else {
    _euler.set(drag.pitch, 0, drag.roll, "XYZ");
    _qTmp.setFromEuler(_euler).invert();
    gTarget.set(0, -9.81, 0).applyQuaternion(_qTmp);
  }
  gDev.lerp(gTarget, 1 - Math.exp(-dt / ACC_TAU));

  if (useAcc || useOri) {
    if (!sensor.gRefSet) {
      if (!sensor.activeAt) sensor.activeAt = performance.now();
      if (performance.now() - sensor.activeAt > 600) captureLevel();
      gravity.set(0, -gDev.length(), 0);   // hold level until the grip is anchored
    } else {
      gravity.copy(gDev).applyQuaternion(sensor.gRef);
    }
  } else {
    sensor.activeAt = 0;
    gravity.copy(gDev);
  }
}

function updateSlope(dt) {
  const gy = Math.min(gravity.y, -2.5);
  let sx = -gravity.x / gy;
  let sz = -gravity.z / gy;
  // keep the tilted plane inside the sealed box
  const maxRise = (BOX.topY - BOX.level) * 0.85;
  const rise = Math.abs(sx) * BOX.W / 2 + Math.abs(sz) * BOX.D / 2;
  if (rise > maxRise) { const f = maxRise / rise; sx *= f; sz *= f; }
  const k = 1 - Math.exp(-dt / SLOPE_TAU);
  slope.x += (sx - slope.x) * k;
  slope.y += (sz - slope.y) * k;
}

function updateEye(dt) {
  // "Magic window" steering (matches the splat viewer's mental model): rotate
  // the phone toward what you want to see — pan left reveals the left wall,
  // recline the top away to peer down at the liquid surface.
  if (gyroActive() && sensor.quatZero) {
    _qTmp.copy(sensor.quatZero).invert().multiply(sensor.quat);
    eyeTarget.set(0, 0, EYE_DIST).applyQuaternion(_qTmp);
  } else {
    _euler.set(drag.pitch, drag.yaw, 0, "YXZ");
    _qTmp.setFromEuler(_euler);
    eyeTarget.set(0, 0, EYE_DIST).applyQuaternion(_qTmp);
  }
  eyeTarget.x = THREE.MathUtils.clamp(eyeTarget.x, -EYE_DIST, EYE_DIST);
  eyeTarget.y = THREE.MathUtils.clamp(eyeTarget.y, -EYE_DIST, EYE_DIST);
  eyeTarget.z = THREE.MathUtils.clamp(eyeTarget.z, 0.30, 2.4);
  eyeSmooth.lerp(eyeTarget, 1 - Math.exp(-dt / EYE_TAU));
}

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  const t0 = performance.now();

  updateGravity(dt);
  updateSlope(dt);
  updateEye(dt);

  // fixed-timestep sim; spread this frame's plane change across the substeps
  simAccum = Math.min(simAccum + dt, MAX_STEPS * SIM_DT);
  const steps = Math.floor(simAccum / SIM_DT);
  if (steps > 0) {
    simAccum -= steps * SIM_DT;
    const dsx = (slope.x - slopePrev.x) / steps;
    const dsz = (slope.y - slopePrev.y) / steps;
    for (let i = 0; i < steps; i++) {
      sim.step(dsx, dsz, i === 0 ? pendingImpulse : null);
    }
    pendingImpulse = null;
    slopePrev.copy(slope);
  }

  sharedUniforms.uHeight.value = sim.texture;
  sharedUniforms.uTexel.value.set(1 / sim.n, 1 / sim.n);
  sharedUniforms.uSlope.value.copy(slope);
  sharedUniforms.uTime.value += dt;
  sharedUniforms.uEye.value.copy(eyeSmooth);

  applyOffAxis(eyeSmooth);
  renderer.render(scene, camera);

  // auto-degrade: sustained slow frames → drop the sim grid to 128²
  frameMs = frameMs * 0.94 + (performance.now() - t0) * 0.06;
  frameCount++;
  if (frameCount > 90 && sim.n > GRID_LO) {
    slowFrames = frameMs > DEGRADE_MS ? slowFrames + 1 : 0;
    if (slowFrames > 90) {
      sim.resize(GRID_LO);
      slowFrames = 0;
      if (DEBUG) toast("Sim degraded to 128×128");
    }
  }
  if (frameCount === 3) window.__boxReady = true;
});

// ---------------------------------------------------------------------------
// Resize / orientation change — geometry is uniform-driven, so this is cheap.
// ---------------------------------------------------------------------------
window.addEventListener("resize", () => {
  BOX = computeBox();
  renderer.setSize(window.innerWidth, window.innerHeight);
  sharedUniforms.uSize.value.set(BOX.W, BOX.D);
  sharedUniforms.uFloorY.value = BOX.floorY;
  sharedUniforms.uTopY.value = BOX.topY;
  sharedUniforms.uLevel.value = BOX.level;
  layoutBoxMeshes();
  layoutSkirts();
});

// ---------------------------------------------------------------------------
// Debug hooks for the Playwright verification harness (?debug=1)
// ---------------------------------------------------------------------------
if (DEBUG) {
  window.__boxDebug = {
    probe: () => ({
      maxAbsH: sim.probeMaxH(),
      slope: [slope.x, slope.y],
      eye: eyeSmooth.toArray(),
      gravity: gravity.toArray(),
      grid: sim.n,
      frameMs,
      frameCount,
      gyroActive: gyroActive(),
      motionActive: motionActive(),
      orientCount: sensor.orientCount,
      motionCount: sensor.motionCount,
    }),
    splash: (u = 0.5, v = 0.5, s = -3) => { pendingImpulse = { u, v, r: BOX.W * 0.09, s }; },
  };
}
