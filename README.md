# Splat Window — gyroscope Gaussian splat viewer

A recreation of [@XRarchitect's demo](https://x.com/XRarchitect/status/2076932513822617966)
("magic window" into a photoreal Gaussian-splat world) using only free, open tech.
Point your iPhone at the screen, tap **Enable Motion**, and physically move the phone
around — the view rotates through the splat scene like a window into another room.

## The original's tech stack (decoded from the tweet thread)

| Layer | Original tweet | This project |
|---|---|---|
| Splat rendering | [SparkJS](https://sparkjs.dev) (open source, by World Labs) with LoD | SparkJS 2.1.0 via CDN |
| Scene content | World Labs (Marble) generated `.spz` splat of his living room | Free SparkJS demo splats (`fireplace.spz` committed here) |
| Device tracking | [8th Wall](https://www.8thwall.com) WebAR image tracking (paid) | Browser-native `DeviceOrientationEvent` (gyroscope) — free |

## Try it

Open the GitHub Pages URL on your iPhone (Safari or Chrome):

**https://johnnyrodriguezxr.github.io/scroll-trigger-test/**

- Tap **Enable Motion** and allow the motion & orientation prompt (iOS 13+ requires this; it only works over HTTPS).
- Move/rotate your phone to look around the scene. **Double-tap** to re-center. **Drag** to re-aim without turning around.
- On desktop, just drag to look.

> If the page 404s, GitHub Pages may need one-time enablement: repo **Settings → Pages → Source: GitHub Actions**, then re-run the "Deploy to GitHub Pages" workflow.

## Scenes

The picker (top right) switches between free demo splats hosted by sparkjs.dev
(fireplace, valley, forge, cat, penguin, butterfly, robot head). The default
interior scene `splats/fireplace.spz` is committed to this repo.

**Bring your own splat** — any `.spz` / `.ply` / `.splat` / `.ksplat` URL (e.g. a scene you
generate with [World Labs Marble](https://marble.worldlabs.ai), like the tweet author did):

```
https://johnnyrodriguezxr.github.io/scroll-trigger-test/?splat=https://example.com/scene.spz
```

Other URL params: `?scene=valley` picks a built-in scene; `?lod=1` enables Spark's
level-of-detail mode (useful for very large splats).

## Run locally

```
python3 -m http.server 8000
# open http://localhost:8000
```

Note: the gyroscope needs a secure context — on a phone use the Pages URL (HTTPS);
`localhost` works for desktop drag-look testing.

## Files

- `index.html` — page shell, import map (three@0.180.0 + @sparkjsdev/spark@2.1.0), UI overlay
- `main.js` — Spark renderer + `SplatMesh` loading, gyroscope controls (the classic
  `DeviceOrientationControls` math with iOS permission flow, smoothing, yaw re-zeroing,
  and subtle parallax), drag fallback, scene picker
- `splats/fireplace.spz` — default scene (SparkJS demo asset, © its creators; served
  originally from sparkjs.dev)
- `.github/workflows/pages.yml` — GitHub Pages deploy

## Credits

- [SparkJS](https://github.com/sparkjsdev/spark) (MIT) by World Labs
- Demo splat scenes from [sparkjs.dev](https://sparkjs.dev/examples/)
- Original concept: [Ian Curtis / @XRarchitect](https://x.com/XRarchitect)

## Ink Box — companion page (`box.html`)

The phone screen becomes the front pane of a sealed glass box holding a dark,
viscous liquid (black ink / crude oil, ~40% full):

**https://johnnyrodriguezxr.github.io/scroll-trigger-test/box.html**

- **Off-axis "fish-tank window"**: the gyroscope quaternion moves a virtual eye
  around the front pane, re-projecting the interior so rotating the phone lets
  you look deeper into the box and see all five interior walls.
- **Real physics**: a GPU shallow-water heightfield sim (ping-pong FBOs,
  256×256, fixed timestep) driven by `DeviceMotion` — the effective gravity
  vector from `accelerationIncludingGravity` tilts the resting plane, and
  moving/shaking the phone injects momentum. Waves reflect off the walls,
  interfere, and settle with tunable viscosity.
- **Rendering**: Fresnel + analytic reflections of the box interior, sharp
  procedural specular, refraction with Beer–Lambert absorption (opaque at
  depth, faint blue-brown tint at grazing angles), meniscus, and caustic
  shimmer at the waterline.
- **iOS**: tap **Enable Motion** (`DeviceMotionEvent.requestPermission()` —
  motion permission, not just orientation). Your resting grip is auto-leveled
  (~0.6 s after sensors start), so the liquid sits at the bottom of the screen
  however you hold the phone; rotate the phone toward what you want to see.
  **Desktop**: drag tilts the box, double-click pokes the ink. Double-tap on
  mobile re-levels + re-centers.
- **Performance**: DPR capped at 2; the sim auto-degrades to 128×128 if frame
  time stays above ~20 ms.
