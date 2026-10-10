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
| Left click (hold), with the tracker in hand | Hold the tracker out in both hands and look at it. Your creature turns on the spot to face the cursor, so you can sweep it round. You can also walk slowly. |
| Left click on the tracker | In hand: drop it. On the ground: walk to it and pick it up. |
| Mouse wheel | Zoom in (wheel up) or out (wheel down). The game remembers your zoom. |
| Double-click | Fullscreen |

The game shows no UI. A small pixel cursor shows when you move the mouse and
hides when the mouse stops. Over something you can use, the cursor turns pale
blue, and four corner brackets close round it and slowly breathe in and out.

**Click to use.** Click anything you can use, from up to 30 units away. Your
creature walks over to it and starts: the escape pods, the stranger, the
ship's keypad or door, and the tracker. If something blocks the way, it
starts once it is close enough, or gives up. Move with the keys, or click
the open sand, to call it off. Sound starts with the click that wakes the
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
| A stray scrap of the pod, half buried | 6.5 |
| The first pod's skid trench begins | about 18 |
| Its crater | 38 |
| The second pod | 64 |
| The dying stranger | 86 |
| The ship (centre, a little up the screen) | 118 |

A few steps from where the creature wakes lies the first hint: a small curved
scrap of the pod's white shell with a strip of its orange band, tipped up and
half buried in the sand, with a bolt and a splinter of glass beside it.

The first pod lies nose-down in its crater. Its skid trench runs off to the
left, back toward the start, with wreckage along it and past the rim, so you
meet the trench first and follow it to the pod. The first time the creature
comes near, a low sound swells and it turns its head to look.

**Look inside a pod.** Click either escape pod. Your creature steps up beside
the open hatchway, braces both hands on its rim and leans right in. It looks
round inside, one way and then the other, then down into it. It pulls back
out, and slowly tilts its head.

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
- **Click it** (from up to 30 units away: your creature walks over). These
  things happen:
  1. Your creature kneels beside it, and the camera closes in a little between
     the two of them. The wind and the wreck get about 5 dB quieter.
  2. It lifts its head and makes a gargled, static-laced cry of pain.
  3. It draws a rattling breath and rasps out a three-note tune. Each note
     catches in the middle, so it comes out as two, with a short silence
     between. Its eye flares on each note and dips at the catch.
  4. Then everything eases back and you have control again. Click again to hear
     the tune again.
- **Its death.** The tune was the last thing it had. When the keypad accepts
  the tune, the stranger dies, out of sight behind you. It takes one last
  breath in and a long one out, its eye catches twice and goes out, its lid
  half closes, the glow in its wound dies, its head rolls aside, and the hand
  on its wound slides off onto the sand. A few seconds after the door cracks,
  a faint, muffled echo of its last note carries over the dunes. After that
  it lies still and cannot be clicked. When you come back to it, a low, sad
  swell plays and your creature turns to look at it.
- **The tune** opens the ship's door (see below). `src/story/tune.ts` has the
  nine tones and the stranger's three. The nine are a stack of thirds over more
  than two octaves (G3 B3 D4 F4 A4 C5 E5 G5 B5), at least three semitones
  apart, so no two are easy to confuse. The stranger's tune leaps low, high,
  then middle (B3, E5, F4). Under the rasp there is a pure tone, so you can
  tell each pitch apart.
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

The ship you escaped from lies about 32 units further right than the stranger
and a little up the screen. Like the pods, it points nose-right. From where the
stranger lies you cannot see the ship, only wreckage at the tail of its trench
at the top of the screen, and its smoke and roar. As you come closer, a low
swell plays and the creature turns to look.

- **The crash:** it came in long and low. It ploughed a 28-unit trench, banked
  and flat-floored, scorched black toward the wreck. It shoved up a great bank
  of sand in front of its bow, and its back broke on landing.
- **The ship:** about 20 units long, eight times a pod's length. It has the
  pods' off-white plating, orange bands and charred heat shielding, so it reads
  as their mothership. It is not a tube:
  - the hull is lofted through an angular cross-section: a flat top, sloped
    upper flanks, a sharp chine where they meet the vertical lower flanks, and
    a chamfered keel;
  - the prow narrows and droops into a beak;
  - blade-like strakes run along both chines;
  - a dorsal spine with vents runs along the stern half, ending in a swept fin;
  - a wedge-fronted bridge tower with a dark canopy sits on the bow half;
  - radiator vanes stand over the stern, behind a squared-off drive block with
    hexagonal thrusters;
  - delta wings sweep back low on the flanks, and hatches, vents and conduits
    cover the top.

  On its upper flank is a row of four pod bays: two are sealed, two stand empty
  (your pod and the stranger's).
- **Damage:**
  - its back is broken: the bow half is bent down and aside, with frame rings,
    hanging cables and fire in the gap;
  - four laser hits run along the flank facing you, from one strafing pass
    before the crash. Each is a small black pit melted into the plating, with a
    lip of slag round it. Round that, the plating is burned black, then
    charred, then stained grey with smoke. Soot streaks splash out from each
    hit, and runs of molten metal have dripped down the flank. Two of the rims
    still glow a dull orange that brightens and fades;
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

On the flank facing you, under the chine, an airlock is cut into the hull
itself, with a dark recess behind the doorway. A metal trim, hazard chevrons
and an orange band run round it into the plating. Its door is buckled and
jammed, and an amber light set into the trim blinks over it. Beside it, a 3x3
keypad of alien glyphs is set flush into the hull plating. The keypad is broken
and keeps trying to boot: it scrambles through its buttons, the whole pad
flashes twice, it sometimes blacks out and comes back with a flash, two
buttons stutter, and it spits the odd spark. It calms down while you press it.

1. Click the keypad or the jammed door. Your creature walks over and steps aside toward the door so
   it does not block your view, and the camera closes in, so the glyphs are
   easy to read.
2. Click buttons. Each one hums its tone in the stranger's own voice, but
   clean and steady, so you can match it against what the stranger sang. The
   order of tones on the pad is shuffled (`PAD_TONES` in `src/story/tune.ts`).
   The three buttons with the stranger's tones hum twice, with the same catch
   in the middle as the stranger's notes. The other six hum once.
3. Play the stranger's three tones in order. (The answer, counting buttons
   from the top left: the middle-right button, then the top-left button,
   then the bottom-middle button.) A wrong sequence buzzes and the
   pad flashes red. The right one turns the glyphs blue and the light green.
   The lock's servo strains, bolts clunk back, and the seal breaks with a puff
   of stale air. The door jerks open a hand's width.
4. To leave the keypad, move or click away from it.
5. Click the cracked door. Your creature steps up and gets its hands into the
   gap. It braces and hauls while the door grinds and judders along its track.
   It rests, then pulls again with everything it has. The door gives all at
   once with a clang and slides back into the hull. The creature is thrown off balance, stumbles away,
   catches itself doubled over, and straightens beside the open doorway. A red
   emergency light flickers inside.

### The tracker

A small device lies on the airlock floor, just inside the door. It looks like a
walkie-talkie in the pods' colours: an off-white shell, an orange band, a dark
rubber grip, a ribbed grille, a dial, and an antenna with a glowing tip. A
small light sits in a dark window on its face. Before the door opens, nothing
shows. After the door opens, its red light throbs faintly in the dark
doorway, and it pulses softly.

1. Click it (the cursor glows over it). Your creature walks up beside the
   doorway, bends, and sinks onto one knee. Its hoof comes down over the
   device and touches it (it shifts a little with a soft tick), then closes on
   it. It lifts it slowly, straight up, and sand trickles off it. The device
   stays where the hoof took it and turns into the grip as it comes up. It
   does not jump into the hand.
   The first time, the creature rises and turns, and its free hand brushes
   the sand off the device's face in two strokes. Then it holds the device up
   in both hands. The device wakes with a sweep of sound out of static, and
   the creature looks at it.
2. It carries the device in its right hand, held out a little in front of it.
   The arm and the device point toward your cursor and follow it the same way
   the head does (further out to its right than across its body). The antenna
   points that way, and the face turns up so you can see the light. Hold the
   left button to hold it out
   in both hands and look down at it. The camera leans in, and the world goes a
   little quieter. While you hold it out, your creature turns on the spot to
   face the cursor, so you can sweep the device round to find the way.
3. **Hot or cold.** The device knows where something lies, 50 units north-east
   of the ship (up and to the right on screen):
   - **Wrong way:** the light, its halo and its glow on the ground throb red,
     very slowly (one throb in about 2.3 to 3.4 seconds, a little quicker the
     nearer you point). Each throb comes with a deep, soft pulse of sound and
     faint radio static.
   - **Right way** (within about 26 degrees of it, until you turn 34 degrees
     off): the light and the antenna burn a solid green. Two soft bell notes
     chime, and a quiet chord hums under everything.
   - In the hand, it uses the way the arm points it (toward the cursor). Held
     out in both hands, it uses the way your creature faces. On the ground, it
     uses the way its antenna points. Within 3 units of the place, it stays solid.
   - Sounds are louder while you hold it out. On the ground, they come from
     where it lies.
4. Click it in your creature's hand to drop it. It falls with your motion,
   knocks on the sand with a clatter and a puff of sand, hops, and settles on
   its back. It glances off the hull and the rocks. Its light keeps going, and
   it casts a faint pool of its colour on the ground. Click it again to walk over and
   pick it up.

Nothing lies at the place yet.

**Code:**
- The ship, its effects, the keypad and the door are in `src/world/ship.ts`.
- The tracker (model, light, hot or cold, falling, sound levels) is in
  `src/world/tracker.ts`. Its target is `TRACK_OFFSET` from the ship's centre.
- Picking it up is a scripted pose sequence in `src/story/PickupScene.ts`.
  Holding it out is a blend in the creature's normal update (`holdOut` in
  `src/character/Creature.ts`): both arms reach by IK to a point in front of
  the chest, and the head looks down.
- The glows are additive, camera-facing halos (and a flat pool on the ground),
  quantised to four dithered steps so they stay pixel art (`src/render/glow.ts`).
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

- **No stalls:** making all of this takes about a second of work. When the
  sound starts, only the heartbeat is made at once. The other sounds are built
  a few milliseconds at a time over the next frames, and the voices below are
  built in a Web Worker (`src/audio/voiceWorker.ts`), off the main thread.
- **The tracker** has its own sound bus. It plays a slow sine throb (about
  104 Hz with a triangle an octave up and a faint ring at 1568 Hz), a held open
  fifth on G (each note doubled a fraction of a hertz apart, so it shimmers)
  when it points true, band-passed static while it searches, and two bell
  notes (a sine plus a partial at 2.76 times the pitch) when it finds the way.
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
                          crater, pods and ship, stain map (blood, drag marks),
                          the tracker
  character/              creature rig and procedural animation
  audio/                  synthesised sound, the stranger's voice
  story/                  the opening, the stranger, the tune,
                          pulling the ship's door open, picking up the tracker,
                          looking into the pods
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
