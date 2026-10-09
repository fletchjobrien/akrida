# Akrida

A story game in a pixel-art desert. The world is 3D, but the game renders it at
low resolution so that it looks like hand-made 2D pixel art.

## Controls

| Input | Action |
| --- | --- |
| W A S D (or arrow keys) | Walk |
| Shift (hold) | Sprint |
| Ctrl or C (tap) | Crouch on or off. Sprinting also stands the creature up. |
| Mouse | Look. When the creature stands still, it looks at the cursor. When it runs, it tilts its head toward the cursor. |
| Mouse wheel | Zoom in (wheel up) or out (wheel down). The game remembers your zoom. |
| Double-click | Fullscreen |

The game shows no UI. A small pixel cursor shows when you move the mouse and
hides when the mouse stops. Sound starts at your first key press or click,
because browsers block audio until the page gets a user gesture.

**Ctrl and Chrome:** Crouch is a tap, so you do not hold Ctrl while you walk.
If you press Ctrl+W by accident, Chrome closes the tab, because a web page
cannot cancel that shortcut. While Ctrl is down, the game asks the browser to
confirm before the tab closes. In fullscreen (double-click), the game uses the
Keyboard Lock API, which lets the page receive Ctrl+W.

## Run locally

```sh
npm install
npm run dev        # development server with hot reload
npm run build      # type-check and build into dist/
npm run preview    # serve the built game
```

Add `?debug` to the URL to get `window.__akrida` (pause, step, teleport).

## Deploy to Cloudflare

The game is static files. `wrangler.jsonc` deploys `dist/` as a Worker with
static assets and no Worker script.

```sh
npx wrangler login
npm run deploy     # builds, then runs `wrangler deploy`
```

To add server logic later (saves, story state), add a `main` script to
`wrangler.jsonc`.

## How the rendering works

- **Low resolution, orthographic camera.** The scene renders into a small
  target (about 300 rows at the default zoom), then a nearest-neighbour upscale
  draws it to the screen. The camera angle is fixed.
- **Zoom.** Up to the default zoom, zooming changes the size of the pixels.
  The two furthest levels keep the pixel size and fit 1.25 and 1.5 times more
  of the world into the image, so the pixels stay chunky.
- **Texel-snapped camera.** The camera moves in whole low-res pixels, so static
  objects never shimmer. The fractional part of the camera position shifts the
  upscaled image instead, so scrolling stays smooth.
- **Texel-snapped character.** The creature's body snaps to the same pixel
  grid, so its silhouette changes only when it animates. Its hooves stay
  planted in world space.
- **Toon lighting with a fixed palette.** Every material picks from 3 to 5
  colours sampled from the reference art. Shadows come from a shadow map.
  Ordered dithering blends bands. The dither pattern is anchored to the world,
  so it does not crawl when the camera moves.
- **Edge pass.** A post pass reads depth and normals. It darkens the outer
  edges of rocks and adds light highlights on their creases.
- **Procedural desert.** Dunes with gentle windward slopes and steep slip
  faces, wind ripples, pebbles, sun glints, drifting cloud shadows and veils
  of blowing sand. The CPU and GPU use the same integer hash, so the ground
  that the creature walks on is the ground that you see.

## How the animation works

- **Gait.** A phase clock drives the steps. Each hoof stays planted until its
  swing starts, then moves in an arc to a landing point predicted from the
  body velocity. Walking has double support, and running has a flight phase.
- **Leg IK.** Each leg is digitigrade (hip, knee, hock, hoof). A two-bone IK
  solve places the knee, and the cannon bone tilts through the swing.
- **Body.** Spring systems drive the pelvis bob, sway, twist, lean, banking in
  turns, arm swing and head look. The springs use the second-order dynamics
  from t3ssel8r's video (see sources).
- **Idle.** The creature breathes (faster after sprints), blinks, shifts its
  weight, turns in place with small steps, and looks around when the mouse
  stays still.

## How the sound works

There are no audio files. The Web Audio API makes all sound at start-up:

- **Wind:** layers of pink, brown and white noise through moving filters, with
  faint whistles and a high sand hiss. The same wind model drives the gusts on
  screen.
- **Hooves in sand:** granular bursts of filtered noise with a low thud. Each
  step uses a random variant, pitch and filter.
- **Sand spray and skids** when running or stopping hard, and **breathing**
  after a sprint.

## Project layout

```
src/
  main.ts                 game loop
  core/                   maths helpers, input
  render/                 pixel renderer, palette, shared lighting
  world/                  terrain, noise, rocks, wind, particles, footprints
  character/              creature rig and procedural animation
  audio/                  synthesised sound
```

## Sources

- Cloudflare: [Workers static assets](https://developers.cloudflare.com/workers/static-assets/)
  and [single-page application routing](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)
- Chrome: [Autoplay policy](https://developer.chrome.com/blog/autoplay) (Web Audio needs a user gesture)
- Chrome: [Keyboard Lock API](https://developer.chrome.com/docs/capabilities/web-apis/keyboard-lock)
  (works only in fullscreen that a script starts)
- Ctrl+W cannot be cancelled in Chrome:
  [Babylon.js forum](https://forum.babylonjs.com/t/how-prevent-default-of-c-w-t-n/44117),
  [HTML5 Game Devs forum](https://html5gamedevs.com/topic/24499-overwrite-button-combinations-like-ctrls)
- t3ssel8r: [Giving Personality to Procedural Animations using Math](https://www.youtube.com/watch?v=KPoeNZZ6H4s)
- Paul Kellet's pink noise filter: [firstpr.com.au/dsp/pink-noise](https://www.firstpr.com.au/dsp/pink-noise/)
