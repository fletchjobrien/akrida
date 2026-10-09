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
