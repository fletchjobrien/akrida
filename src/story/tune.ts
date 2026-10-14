/**
 * The tones the blue creatures sing. The dying stranger rasps out three of
 * them; the keypad on the ship's door has nine buttons, one per tone, and
 * opens when the stranger's three are played in order.
 *
 * Nine tones over more than two octaves, at least three semitones apart (a
 * stack of thirds on G3: G3 B3 D4 F4 A4 C5 E5 G5 B5), so no two are easily
 * confused and every order of them still sounds like a phrase.
 */
export const TONES = [196.0, 246.94, 293.66, 349.23, 440.0, 523.25, 659.26, 783.99, 987.77] as const;

/** The stranger's tune, as indices into TONES: low, high, middle (B3, E5, F4). */
export const TUNE = [1, 6, 3] as const;

/**
 * Which tone each keypad button plays, by button (row by row, top left first).
 * Shuffled, so the tune is a search by ear, not a pattern on the pad.
 */
export const PAD_TONES = [6, 4, 8, 0, 5, 1, 2, 3, 7] as const;

/**
 * The songs the tracker picks up when it points true: sung by the same kind
 * of voice as the stranger's, but on tones of their own, a brighter scale (D
 * E F# A B D E, open and bright where the stranger's thirds are close and
 * dark). To the Akridians a tone is also a colour, low tones warm and high
 * tones cool, as light runs from red to violet; the tracker's light shows the
 * colour of each note as it is sung.
 */
export const SONG_TONES = [293.66, 329.63, 369.99, 440.0, 493.88, 587.33, 659.26] as const;
export const SONG_COLORS = [0xff5a42, 0xff9a36, 0xffd64a, 0x7aff86, 0x56e6ff, 0x6a86ff, 0xb478ff] as const;

/** A song: notes as [tone index, beats], -1 for a rest. One beat is BEAT seconds. */
export type Song = readonly (readonly [number, number])[];
export const BEAT = 0.42;

/** The station's song: rising, turning back, settling home; then a breath before it begins again. */
export const STATION_SONG: Song = [
  [3, 1],
  [2, 1],
  [4, 1],
  [3, 2],
  [5, 1],
  [4, 1],
  [3, 2.5],
  [2, 1],
  [1, 1],
  [0, 3],
  [-1, 3],
];

/** The song of the place in the east: higher, wider, a question that is not answered. */
export const EAST_SONG: Song = [
  [0, 1],
  [3, 1],
  [5, 2],
  [6, 1],
  [5, 1],
  [3, 1],
  [4, 2.5],
  [2, 1],
  [4, 1],
  [6, 3],
  [-1, 3],
];
