import * as THREE from "three";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";

// ---------------------------------------------------------------------------
// Scenes — free demo splats hosted by SparkJS (CORS: *). The default scene is
// committed to this repo so it works same-origin even if sparkjs.dev changes.
// Per-scene transforms: most gsplat files are Y-down, so rotationX defaults to
// PI to flip them upright. position nudges the camera-at-origin into the scene.
// ---------------------------------------------------------------------------
const SPARK_ASSETS = "https://sparkjs.dev/assets/splats/";
const SCENES = {
  fireplace: { label: "Fireplace (interior)", url: "./splats/fireplace.spz",        position: [1.5, -1, -5] },
  valley:    { label: "Valley (outdoor)",     url: SPARK_ASSETS + "valley.spz",     position: [0, 0, 0] },
  forge:     { label: "Forge",                url: SPARK_ASSETS + "forge.spz",      position: [0, 0.5, -3] },
  penguin:   { label: "Penguin",              url: SPARK_ASSETS + "penguin.spz",    position: [0, -1, -6] },
  butterfly: { label: "Butterfly",            url: SPARK_ASSETS + "butterfly.spz",  position: [0, 0, -4] },
  robothead: { label: "Robot head",           url: SPARK_ASSETS + "robot-head.spz", position: [0, 0.7, -8], rotationY: Math.PI },
};
const DEFAULT_SCENE = "fireplace";

const params = new URLSearchParams(location.search);
const customSplatURL = params.get("splat");
const sceneKey = SCENES[params.get("scene")] ? params.get("scene") : DEFAULT_SCENE;

// ---------------------------------------------------------------------------
// Renderer / scene setup (per Spark getting-started)
// ---------------------------------------------------------------------------
const app = document.getElementById("app");
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 1000);

const spark = new SparkRenderer({ renderer });
scene.add(spark);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// Splat loading with progress bar
// ---------------------------------------------------------------------------
const loader = document.getElementById("loader");
const loaderLabel = document.getElementById("loaderLabel");
const barFill = document.getElementById("barFill");
let currentMesh = null;

function loadScene(key) {
  const def = customSplatURL && key === "__custom__"
    ? { label: "Custom splat", url: customSplatURL }
    : SCENES[key];
  if (!def) return;

  if (currentMesh) {
    scene.remove(currentMesh);
    currentMesh.dispose?.();
    currentMesh = null;
  }

  loader.classList.remove("hidden");
  barFill.style.width = "0%";
  loaderLabel.textContent = `Loading ${def.label}…`;

  const mesh = new SplatMesh({
    url: def.url,
    lod: params.get("lod") === "1",
    onProgress: (e) => {
      if (e.lengthComputable && e.total > 0) {
        barFill.style.width = `${Math.min(100, (e.loaded / e.total) * 100)}%`;
      } else {
        // Unknown total: creep the bar so it still feels alive
        const w = parseFloat(barFill.style.width) || 0;
        barFill.style.width = `${w + (95 - w) * 0.1}%`;
      }
    },
    onLoad: () => {
      barFill.style.width = "100%";
      setTimeout(() => loader.classList.add("hidden"), 250);
    },
  });

  // Gsplat files are conventionally Y-down; flip upright unless overridden.
  // URL params can override placement (handy for custom ?splat= scenes):
  // ?px=0&py=1&pz=-4 (mesh position, meters) ?rx=180&ry=0 (rotation, degrees)
  const num = (name, fallback) => (params.get(name) != null && !isNaN(+params.get(name)) ? +params.get(name) : fallback);
  const [px, py, pz] = def.position ?? [0, 0, 0];
  mesh.rotation.x = THREE.MathUtils.degToRad(num("rx", THREE.MathUtils.radToDeg(def.rotationX ?? Math.PI)));
  mesh.rotation.y = THREE.MathUtils.degToRad(num("ry", THREE.MathUtils.radToDeg(def.rotationY ?? 0)));
  mesh.position.set(num("px", px), num("py", py), num("pz", pz));
  scene.add(mesh);
  currentMesh = mesh;
}

// Scene picker
const picker = document.getElementById("scenePicker");
for (const [key, def] of Object.entries(SCENES)) {
  const opt = document.createElement("option");
  opt.value = key;
  opt.textContent = def.label;
  picker.appendChild(opt);
}
if (customSplatURL) {
  const opt = document.createElement("option");
  opt.value = "__custom__";
  opt.textContent = "Custom (?splat=…)";
  picker.appendChild(opt);
  picker.value = "__custom__";
  loadScene("__custom__");
} else {
  picker.value = sceneKey;
  loadScene(sceneKey);
}
picker.addEventListener("change", () => loadScene(picker.value));

// ---------------------------------------------------------------------------
// GyroControls — DeviceOrientation → camera quaternion (the removed
// THREE.DeviceOrientationControls math), with smoothing, a yaw re-zero so the
// scene always starts in front of you, and a touch of positional parallax.
// ---------------------------------------------------------------------------
class GyroControls {
  constructor() {
    this.deviceQuat = new THREE.Quaternion();
    this.smoothQuat = new THREE.Quaternion();
    this.yawFix = new THREE.Quaternion();
    this.hasReading = false;
    this.zeroed = false;
    this.enabled = false;

    this._zee = new THREE.Vector3(0, 0, 1);
    this._euler = new THREE.Euler();
    this._q0 = new THREE.Quaternion();
    this._qScreen = new THREE.Quaternion();
    this._qNeg90X = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);
    this._dir = new THREE.Vector3();

    this._onOrientation = (e) => {
      if (e.alpha == null && e.beta == null && e.gamma == null) return;
      const alpha = THREE.MathUtils.degToRad(e.alpha || 0);
      const beta = THREE.MathUtils.degToRad(e.beta || 0);
      const gamma = THREE.MathUtils.degToRad(e.gamma || 0);
      const orient = THREE.MathUtils.degToRad(screen.orientation?.angle ?? window.orientation ?? 0);

      this._euler.set(beta, alpha, -gamma, "YXZ");
      this.deviceQuat.setFromEuler(this._euler);
      this.deviceQuat.multiply(this._qNeg90X); // camera looks out the back of the device
      this.deviceQuat.multiply(this._qScreen.copy(this._q0).setFromAxisAngle(this._zee, -orient));

      if (!this.zeroed) {
        this.rezero();
        this.smoothQuat.copy(this.yawFix).multiply(this.deviceQuat);
      }
      this.hasReading = true;
    };
  }

  // Rotate the world so "forward" is wherever the phone points right now.
  rezero() {
    this._dir.set(0, 0, -1).applyQuaternion(this.deviceQuat);
    const yaw = Math.atan2(-this._dir.x, -this._dir.z);
    this.yawFix.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.zeroed = true;
  }

  start() {
    window.addEventListener("deviceorientation", this._onOrientation, true);
    this.enabled = true;
  }

  update(target) {
    if (!this.hasReading) return false;
    target.copy(this.yawFix).multiply(this.deviceQuat);
    this.smoothQuat.slerp(target, 0.25); // jitter smoothing
    target.copy(this.smoothQuat);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Drag look controls — desktop fallback + manual yaw/pitch offset on top of
// gyro (drag to re-aim without turning your body).
// ---------------------------------------------------------------------------
const drag = { yaw: 0, pitch: 0, active: false, lastX: 0, lastY: 0 };
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
  const k = 0.0045;
  drag.yaw -= (e.clientX - drag.lastX) * k;
  if (!gyro.enabled) {
    drag.pitch -= (e.clientY - drag.lastY) * k;
    drag.pitch = THREE.MathUtils.clamp(drag.pitch, -Math.PI / 2 + 0.05, Math.PI / 2 - 0.05);
  }
  drag.lastX = e.clientX;
  drag.lastY = e.clientY;
});
const endDrag = () => (drag.active = false);
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

// Double-tap to re-center the view (gyro mode)
let lastTap = 0;
canvas.addEventListener("pointerdown", () => {
  const now = performance.now();
  if (now - lastTap < 300 && gyro.enabled) {
    gyro.rezero();
    drag.yaw = 0;
    toast("View re-centered");
  }
  lastTap = now;
});

// ---------------------------------------------------------------------------
// Motion permission flow (iOS 13+ requires a user-gesture request on HTTPS)
// ---------------------------------------------------------------------------
const gyro = new GyroControls();
const motionBtn = document.getElementById("motionBtn");
const hint = document.getElementById("hint");

let hintTimer;
function hideHintSoon(ms = 3500) {
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => hint.classList.add("hidden"), ms);
}

const toastEl = document.getElementById("toast");
let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2500);
}

const needsPermission =
  typeof DeviceOrientationEvent !== "undefined" &&
  typeof DeviceOrientationEvent.requestPermission === "function";
const maybeMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) || needsPermission;

if (needsPermission) {
  motionBtn.style.display = "block";
  hint.textContent = "Tap Enable Motion, then move your phone around";
  motionBtn.addEventListener("click", async () => {
    try {
      const state = await DeviceOrientationEvent.requestPermission();
      if (state === "granted") {
        gyro.start();
        motionBtn.style.display = "none";
        hint.textContent = "Move your phone around to look through the window";
        hideHintSoon();
      } else {
        motionBtn.style.display = "none";
        toast("Motion denied — drag to look around instead");
      }
    } catch {
      motionBtn.style.display = "none";
      toast("Motion unavailable — drag to look around instead");
    }
  });
} else if (maybeMobile && typeof DeviceOrientationEvent !== "undefined") {
  // Android / older iOS: no permission gate, just listen
  gyro.start();
  hideHintSoon(4000);
} else {
  hint.textContent = "Drag to look around";
  hideHintSoon(4000);
}

// ---------------------------------------------------------------------------
// Render loop: gyro (or drag) orientation + subtle positional parallax
// ---------------------------------------------------------------------------
if (params.get("debug") === "1") {
  window.__debug = { camera, scene, THREE, getMesh: () => currentMesh };
}

const PARALLAX = 0.22; // meters of fake head-motion
const gyroQuat = new THREE.Quaternion();
const dragQuat = new THREE.Quaternion();
const dragEuler = new THREE.Euler(0, 0, 0, "YXZ");
const lookDir = new THREE.Vector3();
const targetPos = new THREE.Vector3();

renderer.setAnimationLoop(() => {
  const hasGyro = gyro.enabled && gyro.update(gyroQuat);

  if (hasGyro) {
    dragEuler.set(0, drag.yaw, 0);
    dragQuat.setFromEuler(dragEuler);
    camera.quaternion.copy(dragQuat).multiply(gyroQuat);
  } else {
    dragEuler.set(drag.pitch, drag.yaw, 0);
    camera.quaternion.setFromEuler(dragEuler);
  }

  // Parallax: shift the camera opposite to where you look, like leaning
  lookDir.set(0, 0, -1).applyQuaternion(camera.quaternion);
  targetPos.set(lookDir.x * PARALLAX, lookDir.y * PARALLAX * 0.6, lookDir.z * PARALLAX * 0.15);
  camera.position.lerp(targetPos, 0.12);

  renderer.render(scene, camera);
});
