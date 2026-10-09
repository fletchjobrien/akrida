/**
 * A full-body pose for scripted moments (cutscenes). Body space: x is the
 * creature's left, y is up from the ground under it, z is forward.
 */
export interface HandPose {
  x: number;
  y: number;
  z: number;
  /** 0 = arm hangs by the FK angles below, 1 = hand reaches the target. */
  ik: number;
}

export interface FootPose {
  x: number;
  z: number;
  lift: number;
  /** Cannon tilt back from vertical; negative lays it forward along the ground. */
  tilt: number;
  pitch: number;
  /** 0 = knee forward (standing), 1 = knee down (kneeling, lying). */
  poleDown: number;
}

export interface ScriptPose {
  pelvisX: number;
  pelvisY: number;
  pelvisZ: number;
  pelvisPitch: number;
  pelvisYaw: number;
  pelvisRoll: number;
  spinePitch: number;
  chestPitch: number;
  chestRoll: number;
  neckPitch: number;
  headPitch: number;
  headYaw: number;
  headRoll: number;
  handL: HandPose;
  handR: HandPose;
  /** FK arm angles when not reaching: shoulder pitch (+ back), elbow (- bent), out. */
  armPitch: number;
  elbow: number;
  armOut: number;
  footL: FootPose;
  footR: FootPose;
  /** 0 closed .. 1 open. */
  eyeOpen: number;
  /** Shaking of exhausted muscles, 0..1. */
  tremble: number;
  /** How hard it is breathing, 0..1. */
  exertion: number;
}

type Numeric = { [k: string]: number | Numeric };

function blendInto(out: Numeric, a: Numeric, b: Numeric, t: number) {
  for (const k of Object.keys(a)) {
    const av = a[k];
    const bv = b[k];
    if (typeof av === 'number') out[k] = av + ((bv as number) - av) * t;
    else {
      if (typeof out[k] !== 'object') out[k] = {};
      blendInto(out[k] as Numeric, av, bv as Numeric, t);
    }
  }
}

/** out = a + (b - a) * t, for every number in the pose. */
export function blendPose(out: ScriptPose, a: ScriptPose, b: ScriptPose, t: number): ScriptPose {
  blendInto(out as unknown as Numeric, a as unknown as Numeric, b as unknown as Numeric, t);
  return out;
}

export function clonePose(p: ScriptPose): ScriptPose {
  return JSON.parse(JSON.stringify(p)) as ScriptPose;
}
