/**
 * The tones the blue creatures sing. The dying stranger rasps out three of
 * them; the keypad on the ship's door has nine buttons, one per tone, and
 * opens when the stranger's three are played in order.
 *
 * Nine tones of a minor pentatonic scale on A over two octaves (A3 C4 D4 E4
 * G4 A4 C5 D5 E5), so any order of them sounds like a phrase.
 */
export const TONES = [220.0, 261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.26] as const;

/** The stranger's tune, as indices into TONES: D4, G4, C4. */
export const TUNE = [2, 4, 1] as const;

/**
 * Which tone each keypad button plays, by button (row by row, top left first).
 * Shuffled, so the tune is a search by ear, not a pattern on the pad.
 */
export const PAD_TONES = [5, 2, 7, 0, 4, 8, 1, 6, 3] as const;
