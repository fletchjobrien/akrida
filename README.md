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
hides when the mouse stops. Over something you can use, the cursor turns light
blue.

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
| The station high in the highlands (far up the screen) | about 210 (and 104 up) |

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
3. **Hot or cold.** The device leads to the research station high in
   the highlands, 130 units north-east of the ship (up and to the right on
   screen; see below):
   - **Wrong way:** the light, its halo and its glow on the ground throb red,
     very slowly (one throb in about 2.3 to 3.4 seconds, a little quicker the
     nearer you point). Each throb comes with a deep, soft pulse of sound and
     faint radio static.
   - **Right way** (within about 26 degrees of it, until you turn 34 degrees
     off): the light and the antenna burn a solid green. Two soft bell notes
     chime, and a quiet chord hums under everything.
   - In the hand, it uses the way the arm points it (toward the cursor). Held
     out in both hands, it uses the way your creature faces. On the ground, it
     uses the way its antenna points. At the station (within 12 units of its
     middle), it stays solid.
   - Sounds are louder while you hold it out. On the ground, they come from
     where it lies.
4. Click it in your creature's hand to drop it. It falls with your motion,
   knocks on the sand with a clatter and a puff of sand, hops, and settles on
   its back. It glances off the hull and the rocks. Its light keeps going, and
   it casts a faint pool of its colour on the ground. Click it again to walk over and
   pick it up.

At the station it burns solid green.

**Code:**
- The ship, its effects, the keypad and the door are in `src/world/ship.ts`.
- The tracker (model, light, hot or cold, falling, sound levels) is in
  `src/world/tracker.ts`. Its target is the centre of the highlands (`HIGH`).
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

## The highlands

Far to the north-east of the ship, 130 units on (about a minute's walk), a
mountain of rock rises out of the desert. The research station sits high on
it, in a saddle of its ridge. It is the place the tracker leads to.

- **Rock:** the mountain is made of the desert's own boulders, made the same
  way and lit the same way, but huge and piled up. Their creases catch the
  light more softly than on the small rocks.
  - Spires of stacked boulders run along a ridge behind the station. Each
    spire is a great boulder sunk in the ground, with smaller, taller ones
    stacked on it and others leaning against its foot.
  - The spires are highest on either side of the station and lower just
    behind it, so the station sits in a notch of the ridge. A second, broken
    line of spires stands further back.
  - Outcrops cover the flanks: bigger and closer together high up and
    behind, smaller and further apart toward the foot.
  - Scree lies round the foot of every rock and of the mountain.
- **Ground:** under the rock is a long rise of the desert's sand, gentle
  toward the ship and steeper behind. The dunes die away on it. The ridge
  stands to the north and east of the station, so the camera (which looks
  north) always sees the station and the path.
- **The path:** a footpath, worn by feet and not built. It winds up from the
  desert and swings round the outcrops. Its width changes as it goes. It is
  only a scuffed, gritty line in the sand, thinning out at its edges, with
  loose stones on either side. The rocks next to it are kept low, so they
  never hide the creature.
- **The station's saddle:** gently level ground with a wandering edge. Rock
  wraps round the station: a low wall behind it that rises into the spires,
  tall crags to the north-west, and lower ones to the south-east.
- **Walking:** the rocks stop the creature, as in the desert. It cannot climb
  anything steeper than about 49 degrees. It walks up the path or picks its
  way between the outcrops.
- **Life and effects:**
  - Three carrion birds circle slowly over the station. They glide on stiff,
    slightly raised wings, bank into the turn, and now and then beat their
    wings a few times. Their shadows sweep over the ground. Now and then one
    cries: a thin, rough call that falls away and echoes.
  - Sand streams off the tops of the spires in the wind, thickest in the
    gusts.
  - Now and then pebbles skitter down a rock near you, in a thin veil of
    dust.
- **Sound:** all of it echoes off the rock.
  - Wind moans through the rock: three narrow resonances that drift and gust,
    louder in strong wind, with a thin whistle off a sharp edge.
  - Rarely, far off, a slab lets go with a long low rumble and a clatter.
  - Near the station, a low hum rises: two low notes slowly beating, with a
    faint high glint over them.
- **First sight:** when the mountain comes into view, a wide, open chord swells
  slowly, and your creature turns to look up at the tallest spire.

### The research station

It was built by the same hands as the ship and its pods: off-white plated
modules banded in orange, dark metal and glass.

- A long habitat on a low frame of struts, with a row of windows, roof vents
  and conduits, and an airlock reached by two steps.
- A domed lab at its end, joined by a tube, its glass dome on a frame of ribs.
- A lattice comms mast with a dish and a red light that blinks slowly at the
  top, two fuel tanks on cradles, a row of solar panels on posts, cargo
  crates, and lamp posts.
- **It was raided:** the airlock door is forced half open, two windows are
  smashed (torn wiring sparks in one), a wedge of the dome is smashed through
  and its glass lies on the ground, a solar panel lies flat, crates are knocked
  over and spilled. One lamp flickers. A
  broken alarm chirps now and then, a loose panel creaks in the wind, and the
  station hums.
- **The three:** against the wall left of the airlock lie three of the
  creature's own kind, shot by a firing squad: one husky green, one husky blue,
  and one the husky rust of the creature itself, but redder.
  - Their hands are tied behind them with cord, and two are blindfolded.
  - One was thrown back onto the ground; one slid down the wall and sits
    slumped against it; one pitched forward onto its face.
  - Each has charred laser wounds through the fur, with a dull ember at the
    heart of each. Faint smoke still rises from them when you are near.
  - Their grey-blue blood has dried in pools under them, with drips leading
    off. Sand has drifted against them on the windward side.
  - The wall behind them is pocked with laser burns (charred, sooty, holed)
    and spattered with blood, with drips running down it and a smear where
    the middle one slid down.
  - The first time you come near, a low, sad chord swells and your creature
    turns to look at them.
- The tracker burns solid green once you are at the station.

### Inside the station

Click the airlock's doorway to go in. Your creature walks to the steps, the
view dims for a moment, and it steps through. Then the roof, the front wall,
the near end, the tube and the lab's dome come away, so you look down into
the rooms with the mountain still all round them. Walk back out through the
doorway (or click it) to leave.

- **Light:** the roof still casts its shadow, so the rooms are in shade. Lamps
  light them in pools, and the lamp over the work bay stutters. The screens,
  the rack's lights and the specimen tank glow. A red emergency strip pulses
  along the foot of the back wall. Sunlight falls through the broken dome
  into the lab, with dust drifting in it.
- **The quarters**, at the far end: a bunk bed with its blanket dragged half
  onto the deck, lockers (one hanging open, a jacket inside), a fold-down
  table with cups still on it, a stool knocked flat, a rug, and a picture of
  somewhere green.
- **By the airlock:** a rack with one pressure suit left on it and one hook
  empty, a bench with a helmet on it, laser burns on the wall, and grey-blue
  smears on the deck where the three were dragged out.
- **The work bay:** a desk under three screens (the middle one cracked and
  flickering), a wall display showing a scan of one of the creature's own
  kind, a chair spun away from the desk, papers across the deck, a rack of
  blinking lights in the corner, and a torn cable that sparks.
- **The lab**, through the short tube: a specimen tank glowing in the middle
  with one of the creature's kind curled up in it and bubbles rising past it;
  a second tank smashed open, its fluid spilled across the deck among the
  glass; a bench with a microscope and racks of vials; a cold cabinet; a
  console; and cables over the floor.
- **Walking:** the walls and the furniture stop the creature. The deck takes
  no footprints and throws up no sand. The tracker cannot be dropped inside.
- **Sound:**
  - The wind and the mountain's sounds fall to a dull murmur through the
    walls.
  - The room's own sound comes up: the lamps' buzz, an air handler's fan with
    a slow beat in it, a low drone in the vents, and the rack's faint whine.
  - The station's power hum, its broken alarm and its creaks are all round
    you.
  - Hooves knock on the metal deck, with a hollow ring under them and a short
    slap off the walls.
  - Bubbles blip in the tank, the torn cable snaps and fizzes, and the
    cracked screen crackles when it stutters.
  - The airlock door grinds on its broken track and clanks as you pass.

**Code:**
- The ground and the path are in `src/world/highlands.ts`. The ground's
  height is worked out once, on the CPU, at every point of a triangular
  lattice 1.3 units apart. The ground the creature walks on and the mesh that
  draws it both read that one table, so they always agree. The mesh also
  carries smooth normals and how worn the path is at each point. Only the
  highland mask is on the GPU (uniforms `uHigh` and `uHighOn`).
- The rock (instanced meshes of the desert's rock shapes, with a collider
  for each big one), the sand streamers, the falling pebbles, the sound
  levels and the first sight are in `src/world/highlandLife.ts`. The rock is
  raised a few milliseconds at a time once the creature is on its way, so
  nothing stalls. The birds are in `src/world/birds.ts`.
- The station's interior (rooms, lamps, walls to bump into, and what goes on
  inside) is in `src/world/stationInterior.ts`. The parts that come away for
  the cutaway are in the station's `shell` group: they are hidden from the
  camera but still cast their shadow. The lamps are a term in the shared toon
  lighting (`roomLight` in `src/render/shared.ts`) that lights only what is
  inside the station's walls.
- The station is in `src/world/station.ts`; the three dead in
  `src/story/Fallen.ts` (scripted poses on the creature's own rig).

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
- **Two ground meshes.** The desert is a grid that follows the camera; the
  GPU adds the dunes to it. The highlands have their own mesh, cut along the
  faces of the rock, so every edge of the rock is a true, sharp edge. Both
  use the same shader program; the grid discards its pixels where the
  highland mesh lies.
- **Procedural desert.** Dunes with gentle windward slopes and steep slip
  faces, wind ripples, pebbles, sun glints, drifting cloud shadows and veils
  of blowing sand. The CPU and GPU use the same integer hash, so the ground
  that the creature walks on is the ground that you see.

## Start-up and performance

The browser must compile every shader before it can draw with it, and this is
the biggest cost at start-up. These steps keep the game smooth:

- **Compile before the first frame, in the background.** All the shaders
  that the first view needs are compiled with three.js `compileAsync` before
  the first frame. Where the browser supports the `KHR_parallel_shader_compile`
  extension, this does not block the page.
- **Build the world in pieces, over many frames.** Only the first crash site
  is built at start-up. The second pod, the ship, and the research station
  (with the three dead) are each built when the creature comes within reach
  of them. A job queue (`src/core/builder.ts`) builds them a few milliseconds
  per frame, and compiles their new shaders in the background.
- **Fewer draw calls.** When a model is complete, its static parts are merged
  into one mesh per material (`src/render/bake.ts`). The ship, for example,
  went from hundreds of meshes to a few dozen. Parts that move or that you
  can click stay separate. The boulders and pebbles are instanced meshes.
- **Low render resolution.** The scene renders at about 300 rows (see
  "How the rendering works"), at a pixel ratio of 1.
- **Less work per vertex.** The ground's shader works out only the desert's
  base height. The highland height is in the mesh, not in the shader.

In a headless test with a software renderer, these changes cut the time to
the first frame from 3.5 s to 1.8 s, and the frame time by about half. A
real GPU is much faster than that renderer, but the proportions are similar.

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
                          the tracker, the highlands and their station
  character/              creature rig and procedural animation
  audio/                  synthesised sound, the stranger's voice
  story/                  the opening, the stranger, the tune,
                          pulling the ship's door open, picking up the tracker,
                          looking into the pods, the three dead
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
