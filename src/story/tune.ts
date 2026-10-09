/**
 * The tones the blue creatures sing. The dying stranger rasps out three of
 * them; the puzzle that follows asks for the same three, in order.
 *
 * Five tones of a minor pentatonic scale on A (A3 C4 D4 E4 G4), so any order of
 * them sounds like a phrase and no two are close enough to confuse.
 */
export const TONES = [220.0, 261.63, 293.66, 329.63, 392.0] as const;

/** The stranger's tune, as indices into TONES: D, G, C. */
export const TUNE = [2, 4, 1] as const;
