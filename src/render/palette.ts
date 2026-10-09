import { Vector3 } from 'three';

/** Hex sRGB colour to a raw vec3. Shaders write these values unchanged. */
export const rgb = (hex: number) =>
  new Vector3(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);

export const glslRgb = (hex: number) => {
  const v = rgb(hex);
  return `vec3(${v.x.toFixed(5)}, ${v.y.toFixed(5)}, ${v.z.toFixed(5)})`;
};

/** Colours sampled from the reference art, with a few in-between tones. */
export const PALETTE = {
  sandHi: 0xfff0be,
  sandLit: 0xf7de97,
  sandMid: 0xe4c987,
  sandShade: 0xbca872,
  sandDeep: 0xa6915f,
  sandSpeck: 0xbca872,

  furDark: 0x452a2e,
  furMid: 0x6e4e52,
  furLight: 0x7f5d61,
  bellyDark: 0x8c636a,
  bellyMid: 0xb58a90,
  bellyLight: 0xc49ca1,
  hoofDark: 0x2e1a1f,
  hoofMid: 0x452a2e,
  eye: 0xffffff,

  rockDark: 0x5f5552,
  rockMid: 0x7e726c,
  rockLight: 0xb6a99e,
} as const;
