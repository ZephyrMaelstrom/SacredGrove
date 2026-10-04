/**
 * Walking (desktop): stand on the ground or on a floor, climb stairs, bump
 * into walls, fall down a stairwell if you insist.
 *
 * Surfaces are the terrain (except where it's cut out for the cellar) plus
 * the layout's floors and ramps. You stand on the highest surface you can
 * step up to (STEP); anything higher is a ceiling or an upper storey.
 * Walls block a body (a circle of RADIUS) between knee and head height, so
 * low curbs and stair treads underfoot don't stop you.
 *
 * Pure TypeScript, tested.
 */
import { heightAt, WALKABLE } from "./map";
import { inTerrainHole, layout, type Box, type Floor, type Layout, type RoomId } from "./layout";

export const STEP = 0.45;
export const RADIUS = 0.25;
const KNEE = 0.36;
const HEAD = 1.75;
const GRAVITY = 9.8;

export function floorHeight(f: Floor, x: number, z: number): number {
  if (!f.ramp) return f.y;
  const a = f.ramp.axis === "x" ? x : z;
  const u = Math.min(1, Math.max(0, (a - f.ramp.a0) / (f.ramp.a1 - f.ramp.a0)));
  return f.y + (f.ramp.y1 - f.y) * u;
}

const inside = (f: { x0: number; x1: number; z0: number; z1: number }, x: number, z: number) =>
  x >= f.x0 && x <= f.x1 && z >= f.z0 && z <= f.z1;

export interface Surface {
  y: number;
  room: RoomId | null;
}

/** The surface under (x, z) for someone whose feet are at `feetY`. */
export function surfaceAt(x: number, z: number, feetY: number, L: Layout = layout()): Surface | null {
  let best: Surface | null = null;
  let lowest: Surface | null = null;
  const consider = (y: number, room: RoomId | null) => {
    if (y <= feetY + STEP && (!best || y > best.y)) best = { y, room };
    if (!lowest || y < lowest.y) lowest = { y, room };
  };
  if (!inTerrainHole(x, z)) consider(heightAt(x, z), null);
  for (const f of L.floors) if (inside(f, x, z)) consider(floorHeight(f, x, z), f.room);
  return best ?? lowest;
}

/** Does a body standing at (x, z) with feet at feetY overlap a wall? */
export function blocked(x: number, z: number, feetY: number, L: Layout = layout()): Box | null {
  const lo = feetY + KNEE, hi = feetY + HEAD;
  for (const b of L.boxes) {
    if (!b.block || b.y1 <= lo || b.y0 >= hi) continue;
    const dx = Math.max(b.x0 - x, 0, x - b.x1);
    const dz = Math.max(b.z0 - z, 0, z - b.z1);
    if (dx * dx + dz * dz < RADIUS * RADIUS) return b;
  }
  return null;
}

export interface Walker {
  x: number;
  z: number;
  feet: number;
  vy: number;
  room: RoomId | null;
}

/**
 * Move a walker toward (tx, tz). Slides along walls (tries the full move,
 * then each axis alone), keeps to the walkable area, then settles onto the
 * floor: steps up small rises, follows ramps down, falls off big drops.
 */
export function step(w: Walker, tx: number, tz: number, dt: number, L: Layout = layout()): Walker {
  tx = Math.min(WALKABLE.maxX, Math.max(WALKABLE.minX, tx));
  tz = Math.min(WALKABLE.maxZ, Math.max(WALKABLE.minZ, tz));
  const ok = (x: number, z: number) => {
    const s = surfaceAt(x, z, w.feet, L);
    if (!s) return false;
    // Stepping up onto something too tall is a wall too.
    if (s.y > w.feet + STEP) return false;
    return !blocked(x, z, Math.max(w.feet, s.y), L);
  };
  let x = w.x, z = w.z;
  if (ok(tx, tz)) { x = tx; z = tz; }
  else if (ok(tx, w.z)) x = tx;
  else if (ok(w.x, tz)) z = tz;

  const s = surfaceAt(x, z, w.feet, L) ?? { y: w.feet, room: w.room };
  let feet = w.feet, vy = w.vy;
  if (s.y >= feet - 0.3) {
    feet = s.y; // step up, or walk down stairs
    vy = 0;
  } else {
    vy += GRAVITY * dt;
    feet = Math.max(s.y, feet - vy * dt);
    if (feet === s.y) vy = 0;
  }
  return { x, z, feet, vy, room: s.room };
}

/** Which room (if any) a point is in, for VR where the headset decides where you are. */
export function roomAt(x: number, z: number, feetY: number, L: Layout = layout()): RoomId | null {
  return surfaceAt(x, z, feetY + 0.3, L)?.room ?? null;
}
