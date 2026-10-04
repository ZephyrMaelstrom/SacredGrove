/**
 * VR comfort settings, kept per headset in browser storage (they're a
 * personal preference, not part of the save).
 */
export type TurnMode = "smooth" | "snap";
export type MoveDirection = "head" | "hand";

export interface ComfortSettings {
  turn: TurnMode;
  /** Smooth-turn speed, degrees per second. */
  turnSpeed: number;
  /** Snap-turn step, degrees. */
  snapAngle: number;
  /** Walking speed, m/s (click the left stick to hurry). */
  moveSpeed: number;
  /** Walk where you look, or where the left controller points. */
  direction: MoveDirection;
  /** Darken the edges of your view while moving or turning. */
  vignette: boolean;
}

export const DEFAULT_COMFORT: ComfortSettings = {
  turn: "smooth",
  turnSpeed: 100,
  snapAngle: 30,
  moveSpeed: 1.6,
  direction: "head",
  vignette: false,
};

const KEY = "rootwake.comfort.v1";

export function loadComfort(): ComfortSettings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_COMFORT, ...JSON.parse(raw) } : { ...DEFAULT_COMFORT };
  } catch {
    return { ...DEFAULT_COMFORT };
  }
}

export function saveComfort(c: ComfortSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* storage blocked: settings last for this visit */
  }
}

export const TURN_SPEEDS = [60, 100, 150];
export const MOVE_SPEEDS = [1.2, 1.6, 2.2];
export const SNAP_ANGLES = [20, 30, 45];

/** Next value in a list (wraps). */
export const cycle = <T,>(list: T[], v: T): T => list[(list.indexOf(v) + 1) % list.length] ?? list[0];

/** Thumbstick dead zone with a smooth ramp (no lurch at the edge of the dead zone). */
export function stick(v: number, dead = 0.15): number {
  const a = Math.abs(v);
  if (a < dead) return 0;
  const t = (a - dead) / (1 - dead);
  // A gentle curve: fine control near the centre, full speed at the rim.
  return Math.sign(v) * Math.pow(t, 1.5);
}

export interface StickInput {
  moveX: number;
  moveY: number;
  turnX: number;
  hurry: boolean;
}

export interface TurnState {
  /** Snap turn: waiting for the stick to return before the next snap. */
  armed: boolean;
}

/** Pure: how far to walk (world x/z) and turn (radians) this frame. */
export function locomote(input: StickInput, yaw: number, dt: number, c: ComfortSettings, turn: TurnState): { dx: number; dz: number; dYaw: number } {
  const mx = stick(input.moveX), my = stick(input.moveY);
  let dx = 0, dz = 0;
  if (mx || my) {
    const speed = c.moveSpeed * (input.hurry ? 1.7 : 1) * dt;
    // Stick up (negative y) walks forward along the facing direction.
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const len = Math.min(1, Math.hypot(mx, my));
    const n = Math.hypot(mx, my) || 1;
    dx = ((-my / n) * fx + (mx / n) * rx) * speed * len;
    dz = ((-my / n) * fz + (mx / n) * rz) * speed * len;
  }
  let dYaw = 0;
  if (c.turn === "smooth") {
    dYaw = stick(input.turnX, 0.2) * (c.turnSpeed * Math.PI / 180) * dt;
  } else {
    if (Math.abs(input.turnX) < 0.35) turn.armed = true;
    else if (turn.armed && Math.abs(input.turnX) > 0.7) {
      turn.armed = false;
      dYaw = Math.sign(input.turnX) * c.snapAngle * Math.PI / 180;
    }
  }
  return { dx, dz, dYaw };
}

