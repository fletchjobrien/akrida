# Akrida

A story game in a pixel-art desert. The world is 3D, but the game renders it at
low resolution so that it looks like hand-made 2D pixel art.

## Controls

| Input | Action |
| --- | --- |
| W A S D (or arrow keys) | Walk |
| Shift (hold) | Sprint (uses stamina, see below) |
| Ctrl or C (tap) | Crouch on or off. Sprinting also stands the creature up. |
| Mouse | Look. When the creature stands still, it looks at the cursor. When it runs, it tilts its head toward the cursor. |
| Mouse wheel | Zoom in (wheel up) or out (wheel down). The game remembers your zoom. |
| Double-click | Fullscreen |

The game shows no UI. A small pixel cursor shows when you move the mouse and
hides when the mouse stops. Sound starts with the click that wakes the
creature (see below), because browsers block audio until the page gets a user
gesture.

**Ctrl and Chrome:** Crouch is a tap, so you do not hold Ctrl while you walk.
If you press Ctrl+W by accident, Chrome closes the tab, because a web page
cannot cancel that shortcut. While Ctrl is down, the game asks the browser to
confirm before the tab closes. In fullscreen (double-click), the game uses the
Keyboard Lock API, which lets the page receive Ctrl+W.

## The opening

The game starts with the creature lying limp, half buried in the sand. The
screen is dark, blurred and drained of colour, and there is no sound. Click to
wake it:

- The darkness lifts in dithered steps and the view comes into focus. The
  camera starts close and draws back to your zoom.
- The sound fades in, muffled at first, with a slow heartbeat, then clears.
- The creature's eye flutters open. It lifts its head and drops it again,
  drags its hands in, and pushes up on shaking arms. The arms give way once,
  then it gets onto hands and knees, onto one knee, and up onto its hooves.
- Sand slides off it as it rises, and a hollow stays in the sand where it lay.
- The cursor fades in, and you get control. For a few seconds it is still
  groggy.

Add `?skipintro` to the URL to start standing.

## The crash site

Everything lies in a fixed place, in a line to the right of where the creature
wakes. Walk right:

| Place | Units right of the start |
| --- | --- |
| The first pod's skid trench begins | about 18 |
| Its crater | 38 |
| The second pod | 64 |
| The dying stranger | 86 |
| The ship (centre, a little up the screen) | 106 |

The first pod lies nose-down in its crater. Its skid trench runs off to the
left, back toward the start, with wreckage along it and past the rim, so you
meet the trench first and follow it to the pod. The first time the creature
comes near, a low sound swells and it turns its head to look.

- **Animated:** the emergency beacon blinks (sometimes twice, sometimes not at
  all). The hatch door swings in the gusts and knocks against the hull. Sparks
  spit from a torn panel, smoke drifts off with the wind, and sand slips down
  the crater walls.
- **Sound:** a thin broken beep, an electrical hum, hot metal ticking as it
  cools, spark crackles, hinge creaks and metal clanks. All of it gets louder
  and clearer as you walk closer, and pans with the pod's position.
- **Code:** the trench and crater are part of the terrain height (CPU and GPU,
  `src/world/crater.ts`, set through shader uniforms). The layout of all the
  places is `layoutWorld()` in `src/main.ts`; the pod, wreckage,
  animation and sound are in `src/world/crashSite.ts`. The pod blocks the
  creature; flat scraps do not.

## The second pod and the stranger

A second escape pod came down with the first. It lies 26 units further right
than the crater. It is the same model as the first, but it came
down differently:

- **Impact:** it came in at a low angle and skidded. Two skip marks show where
  it first touched the sand. A long, shallow trench (22 units) deepens toward
  the pod and is singed more and more toward its end. The trench ends in a
  charred, glass-flecked bowl. Low-angle impacts make this shape: the bowl is
  stretched along the path, and the ejecta is thrown out to the sides in two
  wings, with little thrown up- or downrange (Gault and Wedekind 1978). The pod
  lies almost flat in the bowl, its nose rammed into sand it ploughed up. Thin
  smoke and the odd ember still rise off the black sand. The first pod went in
  steeply and lies nose-down in a round crater.
- **Damage:** the nose is crumpled and caved in on one side. The hatch door is
  blown off. A gash is ripped along its flank, a third of the heat shield is
  gone, and one thruster bell is torn away. It lost the other fin, the window
  is cracked, and the antenna is snapped off at the root.
- **Debris:** two sprays of small bits at the skip marks, then heat-shield
  shards and window glass along the trench, with heavier wreckage near the
  end. Further out lie the hatch door, the torn-off fin, a coolant canister
  that rolled away, and the antenna mast.
- **Effects and sound:** the first pod smokes, sparks, beeps red and swings
  its door. The second pod has its own set:
  - a split coolant line vents in hissing bursts of white vapour that sinks
    and rolls out over the sand;
  - a severed cable sways in the wind and arcs blue-white to the hull with a
    crack and a buzz;
  - a cabin light stutters in the hatchway with the buzz of a failing ballast,
    and gutters with every arc;
  - the snapped-off beacon lies in the sand, pulsing a slow, faltering amber
    with a sagging warble.
- **The trail.** The stranger got 22 units from its pod, and the sand shows
  how:
  - it fell out of the hatch, then tried to walk: good-hoof prints with the
    broken leg dragging beside them;
  - it went down, then crawled the rest of the way, leaving a body trough
    (deep where it sagged), the broken leg's thin furrow, claw marks with sand
    heaped behind them, and gouges where its good hoof shoved;
  - its pulls get shorter and its rests more frequent toward the end.

  The blood is sparse: single drips with small spatter, a few smudges where
  its belly pressed, and ragged blotches darker at the rim where it lay. The
  oldest marks, near the pod, are softer and half dusted over with sand.
- **The stranger.** At the end lies a creature of your own kind, with husky
  blue skin. It lies on its back:
  - it has a dark wound in its belly, with a faint glow deep inside, and holds
    one hand pressed to the wound;
  - one leg is broken below the knee, and the shin juts out sideways;
  - the sand around it is churned and gouged where it struggled;
  - its chest heaves in ragged gasps with a wet rattle, and its eye glow
    flickers dimly and sometimes goes out.
- **First sight.** When you come near, it turns its head toward you and weakly
  reaches out a trembling arm, then lets it fall. A low, sad chord swells, and
  your creature turns to look at it. Its head follows you after that.
- **Click it.** Walk up close: the centre of the cursor glows faint blue over
  it. Click, and these things happen:
  1. Your creature kneels beside it, and the camera closes in a little between
     the two of them. The wind and the wreck get about 5 dB quieter.
  2. It lifts its head and makes a gargled, static-laced cry of pain.
  3. It draws a rattling breath and rasps out a three-note tune. Its eye flares
     on each note.
  4. Then everything eases back and you have control again. Click again to hear
     the tune again.
- **The tune** opens the ship's door (see below). `src/story/tune.ts` has the
  nine tones (an A minor pentatonic over two octaves: A3 C4 D4 E4 G4 A4 C5 D5
  E5) and the stranger's three (D4, G4, C4). Under the rasp there is a thin
  pure tone, so you can tell each pitch apart.
- **Code:**
  - The skid and skip marks are part of the terrain height, on the CPU and the
    GPU (`src/world/crater.ts`, uniforms `uSite2`, `uSite2Trail`, `uSite2On`).
  - The blood, troughs and churned sand are a small texture that the sand
    shader reads (`src/world/stains.ts`). It changes the colour and the shading
    normal, not the geometry.
  - Both pods are in `src/world/crashSite.ts` (`variant` `'first'` or
    `'second'`); each has its own positional sound bus. The stranger, its
    animation, the encounter and the painting of the trail are in
    `src/story/Stranger.ts`.

## The ship

The ship you escaped from lies about 20 units further right than the stranger and
a little up the screen. Like the pods, it points nose-right. From where the
stranger lies, only the ship's tail shows, in the top-right corner of the
screen, with its trench and wreckage running back past the stranger. As you
come closer, a low swell plays and the
creature turns to look.

- **The crash:** it came in long and low. It ploughed a 28-unit trench, banked
  and flat-floored, scorched black toward the wreck. It shoved up a great bank
  of sand in front of its bow, and its back broke on landing.
- **The ship:** about 20 units long, eight times a pod's length. It has the
  same off-white faceted hull, orange bands and charred heat shielding, so it
  reads as the pods' mothership. On its flank is a row of four pod bays: two
  are sealed, two stand empty (your pod and the stranger's).
- **Damage:**
  - its back is broken: the bow half is bent down and aside, with frame rings,
    hanging cables and fire in the gap;
  - three hull breaches have plating peeled outward and soot blown over the
    hull;
  - more blast scars mark the hull;
  - one of the three engine bells is torn off and lies in the trench;
  - the near wing is sheared off (it lies in the trench too), and the dorsal
    fin is bent over;
  - the sensor mast is snapped;
  - debris lies along the whole trench, with small fires still burning in it.
- **Effects:**
  - thick smoke columns rise from the breaches and lean away on the wind;
  - flames flicker in the breaches, with embers rising and molten drips
    falling;
  - sparks shower from the break, and the jammed door's frame shorts out in
    blue arcs;
  - nav lights blink;
  - every 14 to 34 seconds, something inside explodes: a flash, a fireball,
    sparks, a gust of smoke, and a boom that shakes the camera when you are
    close.
- **Sound:** a low roar of fire over a failing drone, deep groans of stressed
  hull, cooling ticks, sparks, the booms, and a muffled, failing alarm somewhere
  inside. It is audible from where the stranger lies, so it pulls you on.

### The door and the keypad

On the flank facing you there is an airlock. Its door is buckled and jammed,
an amber light blinks over it, and beside it is a 3x3 keypad of glowing
glyphs.

1. Walk up and click the keypad. The camera closes in, so the glyphs are easy
   to read.
2. Click buttons. Each one plays a clean tone, one of the nine. The order of
   tones on the pad is shuffled (`PAD_TONES` in `src/story/tune.ts`).
3. Play the stranger's three tones in order. A wrong sequence buzzes and the
   pad flashes red. The right one turns the glyphs blue and the light green.
   The lock's servo strains, bolts clunk back, and the seal breaks with a puff
   of stale air. The door jerks open a hand's width.
4. To leave the keypad, move or click away from it.
5. Click the cracked door. Your creature steps up and gets its hands into the
   gap. It braces and hauls while the door grinds and judders along its track.
   It rests, then pulls again with everything it has. The door gives all at
   once with a clang. The creature is thrown off balance, stumbles away,
   catches itself doubled over, and straightens beside the open doorway. A red
   emergency light flickers inside.

**Code:**
- The ship, its effects, the keypad and the door are in `src/world/ship.ts`.
- The trench and bank are part of the terrain height, on the CPU and the GPU
  (`src/world/crater.ts`, uniforms `uSite3` and `uSite3On`).
- The pull is a scripted pose sequence, in `src/story/DoorScene.ts`.
- Each glyph is a 7x7 pixel pattern drawn by a small shader on its button.
- With `?debug`, `__akrida.ship.press(i)` presses button `i`.

## Stamina

There is no stamina bar. You hear and see it instead:

- A full stamina gives 9 seconds of sprinting. When you are not sprinting,
  it refills (from empty in 13 seconds).
- 2 seconds before it runs out, you hear a faint wheeze, and the run gets
  ragged: the head lolls, the arms stop pumping and flail. A second wheeze
  comes just before the end.
- When it runs out, the creature gasps and cannot sprint until stamina is
  full again (13 seconds). It trudges with its head down and arms limp. When it
  stands still, it bends over with its hands near its knees and pants. It
  sometimes takes a deep breath, and it straightens up as it recovers.

## Run locally

```sh
npm install
npm run dev        # development server with hot reload
npm run build      # type-check and build into dist/
npm run preview    # serve the built game
```

Add `?debug` to the URL to get `window.__akrida` (pause, step, teleport), and
`?skipintro` to skip the opening.

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
- **Stamina.** Two blend values, `strain` (the last 2 seconds of a sprint) and
  `tired` (the recovery), change the lean, head, arms, step height, sway and
  breathing. They do not swap in separate animations.

## How the sound works

There are no audio files. The Web Audio API makes all sound at start-up:

- **Wind:** layers of pink, brown and white noise through moving filters, with
  faint whistles and a high sand hiss. The same wind model drives the gusts on
  screen.
- **Hooves in sand:** granular bursts of filtered noise with a low thud. Each
  step uses a random variant, pitch and filter.
- **Sand spray and skids** when running or stopping hard, and **breathing**
  after a sprint.
- **Wheezes and gasps** when stamina runs low or out: breath noise through a
  formant that opens up, with a thin whistling resonance. While tired, the
  panting has a faint wheeze on each inhale.

- **The stranger's voice** is made sample by sample (`src/audio/voice.ts`).
  A glottal pulse (Rosenberg's shape) with jitter, shimmer and period
  doubling goes through a cascade of formant resonators (Klatt's design).
  Bubbling fluid chops the sound and moves the lowest formant, and bursts of
  sample-and-hold crushing add static. A pitch check measures the five tones
  within 1.5 Hz of their targets.

## Project layout

```
src/
  main.ts                 game loop
  core/                   maths helpers, input
  render/                 pixel renderer, palette, shared lighting
  world/                  terrain, noise, rocks, wind, particles, footprints,
                          crater, pods and ship, stain map (blood, drag marks)
  character/              creature rig and procedural animation
  audio/                  synthesised sound, the stranger's voice
  story/                  the opening, the stranger, the tune,
                          pulling the ship's door open
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
- D. E. Gault and J. A. Wedekind (1978), "Experimental studies of oblique impact",
  Proc. Lunar Planet. Sci. Conf. 9th, 3843–3875, as summarised in
  [Bottke et al. 2000, "Elliptical craters"](https://www.boulder.swri.edu/~bottke/Reprints/Bottke-etal_2000_Icarus_Elliptical_Craters.pdf)
  and [arXiv:2404.16677](https://arxiv.org/abs/2404.16677) (the shape of the second pod's crater)
- Paul Kellet's pink noise filter: [firstpr.com.au/dsp/pink-noise](https://www.firstpr.com.au/dsp/pink-noise/)
- D. H. Klatt (1980), "Software for a cascade/parallel formant synthesizer",
  JASA 67(3), 971–995: [doi:10.1121/1.383940](https://doi.org/10.1121/1.383940),
  [PDF](https://www.fon.hum.uva.nl/david/ba_shs/2009/klatt-1980.pdf) (the resonator used for the formants)
- A. E. Rosenberg (1971), "Effect of glottal pulse shape on the quality of natural vowels",
  JASA 49, 583–590: [Praat manual reference](https://www.fon.hum.uva.nl/praat/manual/Rosenberg__1971_.html) (the glottal pulse)
