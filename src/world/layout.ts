/**
 * M6 — The homestead's buildings as data: every wall, floor, stair and
 * station, in world metres.
 *
 * One description feeds three consumers:
 *   - buildings.ts renders the boxes,
 *   - walk.ts walks on the floors and collides with the walls (desktop),
 *   - the VR teleport uses the same floors as landing surfaces and the walls
 *     as blockers.
 * So what you see is exactly what you can stand on and bump into.
 *
 * Pure TypeScript (no Babylon) so it is unit-tested.
 *
 *   Barn (x 1..15, z 51..73)       big south door; apothecary bench, stove and
 *                                  jar shelf along the west wall; stairs up the
 *                                  east wall to the hayloft (z 61..73) with its
 *                                  drying racks and north vent door
 *   Tack room (x −3..1, z 54..62)  lean-to on the barn's west side; door into
 *                                  the barn and one outside; seed catalog
 *   Farmhouse (x −47..−37,         ground floor kitchen, stairs along the west
 *              z 63.5..72.5)       wall, bedroom upstairs (bed, writing desk)
 *   Root cellar                    under the house, reached by the bulkhead
 *                                  stairwell on the east side (x −36..−34)
 */
import { SITE, heightAt } from "./map";

export type RoomId = "barn" | "loft" | "tack" | "house" | "upstairs" | "cellar";
export const ROOM_NAMES: Record<RoomId, string> = {
  barn: "Barn", loft: "Hayloft", tack: "Tack room", house: "Farmhouse", upstairs: "Bedroom", cellar: "Root cellar",
};

export type MatKey =
  | "houseWall" | "trim" | "roofShingle" | "window" | "barnWall" | "barnRoof" | "wood" | "darkWood" | "concrete"
  | "tin" | "soil" | "manure" | "sign" | "plank" | "plaster" | "stone" | "glass" | "paper" | "iron" | "quilt" | "gravel";

export interface Box {
  x0: number; x1: number; y0: number; y1: number; z0: number; z1: number;
  /** null = invisible (collision only). */
  mat: MatKey | null;
  /** Stops walking (desktop) and teleport rays (VR). */
  block: boolean;
  /** Casts shadows (outer shells do; small interior pieces don't need to). */
  cast?: boolean;
}

export interface Floor {
  x0: number; x1: number; z0: number; z1: number;
  /** Surface height (at the low end, for ramps). */
  y: number;
  /** Stairs: the surface rises linearly from `y` at a0 to `y1` at a1 along an axis. */
  ramp?: { axis: "x" | "z"; a0: number; a1: number; y1: number };
  room: RoomId | null;
}

export type StationId = "bed" | "desk" | "bench" | "shelf" | "loft" | "vent" | "tack" | "gloves" | "cellar" | "stand";

export interface Station {
  id: StationId;
  label: string;
  x: number;
  y: number;
  z: number;
  /** Reach (m) in the floor plane. */
  radius: number;
}

/** Ground cells (2 m terrain grid) cut out for the cellar under the house and its stairwell. */
export const TERRAIN_HOLES = [
  { x0: -48, x1: -36, z0: 62, z1: 74 },
  { x0: -36, x1: -34, z0: 62, z1: 68 },
] as const;

export const inTerrainHole = (x: number, z: number) =>
  TERRAIN_HOLES.some((h) => x > h.x0 && x < h.x1 && z > h.z0 && z < h.z1);

export interface Layout {
  boxes: Box[];
  floors: Floor[];
  stations: Station[];
  /** Points of interest the renderer needs (where dynamic props go). */
  anchors: {
    barnFloor: number; loftFloor: number; houseFloor: number; upstairsFloor: number; cellarFloor: number;
    mortar: { x: number; y: number; z: number };
    stove: { x: number; y: number; z: number };
    /** Drying-rack poles: z positions and height; x span. */
    racks: { z: number[]; y: number; x0: number; x1: number };
    /** Jar shelf boards: x, z span and board heights. */
    shelf: { x: number; z0: number; z1: number; ys: number[] };
    /** Seed-catalog drawers face. */
    catalog: { x0: number; x1: number; z: number; y0: number; y1: number };
    cellarShelf: { x: number; z0: number; z1: number; ys: number[] };
    standShelf: { x0: number; x1: number; z: number; y: number };
    vent: { x: number; z: number; y0: number; y1: number; width: number };
    bed: { x: number; y: number; z: number };
    porch: { x: number; y: number; z: number };
    /** Lamps: where interior lamplight comes from (per room). */
    lamps: { room: RoomId; x: number; y: number; z: number }[];
    /** Wall tops, for the roofs. */
    barnTop: number; houseTop: number; tackTop: number;
    gB: number; gH: number;
  };
}

// ---------------------------------------------------------------- helpers

/** A wall slab with rectangular openings cut through it. Openings are given along the wall's long axis (a) and height (y). */
function wall(
  out: Box[],
  axis: "x" | "z",
  a0: number, a1: number,
  t0: number, t1: number,
  y0: number, y1: number,
  mat: MatKey,
  openings: { a0: number; a1: number; y0: number; y1: number }[] = [],
  cast = true,
) {
  const cuts = [a0, a1, ...openings.flatMap((o) => [o.a0, o.a1])].filter((v) => v >= a0 && v <= a1);
  const xs = [...new Set(cuts)].sort((p, q) => p - q);
  const push = (s0: number, s1: number, b0: number, b1: number) => {
    if (s1 - s0 < 1e-3 || b1 - b0 < 1e-3) return;
    out.push(axis === "x"
      ? { x0: s0, x1: s1, z0: t0, z1: t1, y0: b0, y1: b1, mat, block: true, cast }
      : { x0: t0, x1: t1, z0: s0, z1: s1, y0: b0, y1: b1, mat, block: true, cast });
  };
  for (let i = 0; i < xs.length - 1; i++) {
    const s0 = xs[i], s1 = xs[i + 1], mid = (s0 + s1) / 2;
    const o = openings.find((op) => mid > op.a0 && mid < op.a1);
    if (!o) push(s0, s1, y0, y1);
    else {
      push(s0, s1, y0, o.y0);
      push(s0, s1, o.y1, y1);
    }
  }
}

/** Glass in each window opening (blocks walking too). */
function glass(out: Box[], axis: "x" | "z", t: number, o: { a0: number; a1: number; y0: number; y1: number }) {
  out.push(axis === "x"
    ? { x0: o.a0, x1: o.a1, z0: t - 0.02, z1: t + 0.02, y0: o.y0, y1: o.y1, mat: "glass", block: true }
    : { x0: t - 0.02, x1: t + 0.02, z0: o.a0, z1: o.a1, y0: o.y0, y1: o.y1, mat: "glass", block: true });
}

const slab = (x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, mat: MatKey, cast = false): Box =>
  ({ x0, x1, z0, z1, y0, y1, mat, block: false, cast });
const solid = (x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, mat: MatKey | null, cast = false): Box =>
  ({ x0, x1, z0, z1, y0, y1, mat, block: true, cast });

/** Solid stair steps (each a box down to the floor) plus the ramp you actually walk on. */
function stairs(
  boxes: Box[], floors: Floor[],
  x0: number, x1: number, z0: number, z1: number, yLow: number, yHigh: number, room: RoomId | null,
  /** Which end is low: "z0" means the stair climbs toward +z. */
  lowEnd: "z0" | "z1",
  mat: MatKey = "plank",
  base = yLow,
) {
  const rise = yHigh - yLow;
  const n = Math.max(2, Math.round(Math.abs(rise) / 0.19));
  const run = (z1 - z0) / n;
  for (let i = 0; i < n; i++) {
    const top = yLow + (rise * (i + 1)) / n;
    const za = lowEnd === "z0" ? z0 + i * run : z1 - (i + 1) * run;
    boxes.push({ x0, x1, z0: za, z1: za + run, y0: Math.min(base, yLow) - 0.05, y1: top, mat, block: true });
  }
  floors.push({
    x0, x1, z0, z1, y: yLow, room,
    ramp: lowEnd === "z0" ? { axis: "z", a0: z0, a1: z1, y1: yHigh } : { axis: "z", a0: z1, a1: z0, y1: yHigh },
  });
}

// ---------------------------------------------------------------- the build

export function buildLayout(): Layout {
  const boxes: Box[] = [];
  const floors: Floor[] = [];
  const stations: Station[] = [];

  // ============================================================ BARN
  const B = SITE.barn;
  const gB = heightAt(B.x, B.z);
  const bx0 = B.x - B.w / 2, bx1 = B.x + B.w / 2, bz0 = B.z - B.d / 2, bz1 = B.z + B.d / 2; // 1..15, 51..73
  const fB = gB + 0.4, barnTop = gB + 5.6, fL = fB + 3.0;
  const t = 0.2;
  boxes.push(slab(bx0 - 0.1, bx1 + 0.1, bz0 - 0.1, bz1 + 0.1, gB - 0.6, fB, "concrete", true));
  const barnDoor = { a0: B.x - 2.1, a1: B.x + 2.1, y0: fB, y1: fB + 3.6 };
  wall(boxes, "x", bx0, bx1, bz0, bz0 + t, fB, barnTop, "barnWall", [barnDoor]);
  const vent = { a0: B.x - 1, a1: B.x + 1, y0: fL + 0.45, y1: fL + 2.0 };
  wall(boxes, "x", bx0, bx1, bz1 - t, bz1, fB, barnTop, "barnWall", [vent]);
  const tackDoor = { a0: 55.4, a1: 56.4, y0: fB, y1: fB + 2.1 };
  wall(boxes, "z", bz0 + t, bz1 - t, bx0, bx0 + t, fB, barnTop, "barnWall", [tackDoor]);
  const eastWins = [{ a0: 56, a1: 57.2, y0: fB + 1.3, y1: fB + 2.3 }, { a0: 64.5, a1: 65.7, y0: fB + 1.3, y1: fB + 2.3 }];
  wall(boxes, "z", bz0 + t, bz1 - t, bx1 - t, bx1, fB, barnTop, "barnWall", eastWins);
  eastWins.forEach((o) => glass(boxes, "z", bx1 - t / 2, o));
  floors.push({ x0: bx0, x1: bx1, z0: bz0, z1: bz1, y: fB, room: "barn" });
  // Concrete apron at the big door (outside, a step down).
  boxes.push(slab(B.x - 4, B.x + 4, bz0 - 5, bz0, gB - 0.2, gB + 0.1, "concrete"));
  floors.push({ x0: B.x - 4, x1: B.x + 4, z0: bz0 - 5, z1: bz0, y: gB + 0.1, room: null });

  // Hayloft over the north half.
  const loftZ0 = 61;
  boxes.push(slab(bx0 + t, bx1 - t, loftZ0, bz1 - t, fL - 0.15, fL, "plank", true));
  floors.push({ x0: bx0 + t, x1: bx1 - t, z0: loftZ0, z1: bz1 - t, y: fL, room: "loft" });
  // Joists under it, for looks.
  for (let x = bx0 + 1.4; x < bx1 - 0.5; x += 1.6) boxes.push(slab(x - 0.06, x + 0.06, loftZ0, bz1 - t, fL - 0.35, fL - 0.15, "darkWood"));
  // Railing along the loft edge (invisible blocker + a visible rail and posts), open at the stairs.
  const stairX0 = 13.1, stairX1 = bx1 - t;
  boxes.push(solid(bx0 + t, stairX0, loftZ0 - 0.08, loftZ0, fL, fL + 1.0, null));
  boxes.push(slab(bx0 + t, stairX0, loftZ0 - 0.1, loftZ0, fL + 0.92, fL + 1.0, "wood"));
  for (let x = bx0 + t + 0.05; x <= stairX0; x += 1.5) boxes.push(slab(x, x + 0.08, loftZ0 - 0.1, loftZ0, fL, fL + 0.92, "wood"));
  // Stairs up the east wall: bottom at z 54, top at the loft edge.
  stairs(boxes, floors, stairX0, stairX1, 54, loftZ0, fB, fL, "barn", "z0");

  // Apothecary corner along the west wall (under the loft's south edge).
  const wx = bx0 + t;
  boxes.push(solid(wx, wx + 0.85, 58, 62, fB, fB + 0.9, "wood", true)); // workbench
  boxes.push(slab(wx, wx + 0.9, 57.95, 62.05, fB + 0.88, fB + 0.94, "plank")); // bench top
  const mortar = { x: wx + 0.45, y: fB + 0.94, z: 59.1 };
  boxes.push(solid(wx + 0.05, wx + 0.85, 63.4, 64.4, fB, fB + 0.75, "iron", true)); // wood stove
  boxes.push(slab(wx + 0.3, wx + 0.5, 63.8, 64.0, fB + 0.75, fL - 0.4, "iron")); // stove pipe
  const stove = { x: wx + 0.45, y: fB + 0.75, z: 63.9 };
  const shelfYs = [0.35, 0.8, 1.25, 1.7].map((h) => fB + h);
  boxes.push(solid(wx, wx + 0.42, 65.6, 70.2, fB, fB + 2.0, null));
  for (const y of shelfYs) boxes.push(slab(wx, wx + 0.42, 65.6, 70.2, y - 0.03, y, "plank"));
  for (const z of [65.6, 67.9, 70.15]) boxes.push(slab(wx, wx + 0.42, z - 0.05, z + 0.05, fB, fB + 2.0, "darkWood"));
  stations.push(
    { id: "bench", label: "Apothecary bench — grind, brew, taste", x: wx + 1.3, y: fB, z: 60, radius: 1.8 },
    { id: "shelf", label: "Jar shelf", x: wx + 1.1, y: fB, z: 67.9, radius: 1.6 },
  );

  // Hayloft: drying racks and the vent door.
  const rackZ = [63, 64.6, 66.2, 67.8, 69.4, 71];
  const rackY = fL + 1.95;
  for (const z of rackZ) {
    boxes.push(slab(2.2, 12.2, z - 0.03, z + 0.03, rackY - 0.03, rackY + 0.03, "darkWood"));
    for (const x of [2.2, 7.2, 12.2]) boxes.push(slab(x - 0.04, x + 0.04, z - 0.04, z + 0.04, fL, rackY, "darkWood"));
  }
  stations.push(
    { id: "loft", label: "Drying racks", x: B.x, y: fL, z: 66.5, radius: 4.5 },
    { id: "vent", label: "Vent door", x: B.x, y: fL, z: bz1 - 0.9, radius: 1.5 },
  );

  // ============================================================ TACK ROOM
  const tx0 = bx0 - 4, tx1 = bx0, tz0 = B.z - 8, tz1 = B.z; // −3..1, 54..62
  const tackTop = gB + 3.45;
  boxes.push(slab(tx0 - 0.1, tx1, tz0 - 0.1, tz1 + 0.1, gB - 0.6, fB, "concrete", true));
  const tackOut = { a0: tx0 + 1.55, a1: tx0 + 2.45, y0: fB, y1: fB + 2.1 };
  wall(boxes, "x", tx0, tx1, tz0, tz0 + t, fB, tackTop, "barnWall", [tackOut]);
  wall(boxes, "x", tx0, tx1, tz1 - t, tz1, fB, tackTop, "barnWall");
  const tackWin = { a0: 57, a1: 58.2, y0: fB + 1.2, y1: fB + 2.1 };
  wall(boxes, "z", tz0 + t, tz1 - t, tx0, tx0 + t, fB, tackTop, "barnWall", [tackWin]);
  glass(boxes, "z", tx0 + t / 2, tackWin);
  floors.push({ x0: tx0, x1: tx1, z0: tz0, z1: tz1, y: fB, room: "tack" });
  // Stoop outside the tack-room door.
  const gStoop = heightAt(tx0 + 2, tz0 - 0.5);
  boxes.push(slab(tx0 + 1.4, tx0 + 2.6, tz0 - 0.6, tz0, gStoop - 0.2, (gStoop + fB) / 2, "concrete"));
  floors.push({ x0: tx0 + 1.4, x1: tx0 + 2.6, z0: tz0 - 0.6, z1: tz0, y: (gStoop + fB) / 2, room: null });
  // Seed catalog: a wall of small drawers on the north wall.
  const catalog = { x0: tx0 + 0.4, x1: tx1 - 0.4, z: tz1 - t - 0.55, y0: fB + 0.1, y1: fB + 1.9 };
  boxes.push(solid(catalog.x0, catalog.x1, catalog.z, tz1 - t, fB, catalog.y1, "wood", true));
  boxes.push(solid(tx0 + t, tx0 + t + 0.5, 59, 61, fB, fB + 0.85, "plank")); // potting counter
  stations.push(
    { id: "tack", label: "Seed catalog", x: (tx0 + tx1) / 2, y: fB, z: tz1 - 1.6, radius: 1.8 },
    { id: "gloves", label: "Glove hook", x: tx0 + 0.8, y: fB, z: 55.6, radius: 1.1 },
  );

  // ============================================================ FARMHOUSE
  const H = SITE.farmhouse;
  const gH = heightAt(H.x, H.z);
  const hx0 = H.x - H.w / 2, hx1 = H.x + H.w / 2, hz0 = H.z - H.d / 2, hz1 = H.z + H.d / 2; // −47..−37, 63.5..72.5
  const fH = gH + 0.4, houseTop = gH + 6.2, fU = fH + 2.9;
  const cF = gH - 2.3, cB = cF - 0.15;
  const ft = 0.3; // foundation wall

  // Cellar floor, foundation walls (= cellar walls), ground-floor slab.
  boxes.push(slab(hx0, hx1, hz0, hz1, cB, cF, "stone"));
  const cellarDoor = { a0: 66.8, a1: 67.8, y0: cF, y1: cF + 2.1 };
  wall(boxes, "z", hz0, hz1, hx0, hx0 + ft, cB, fH - 0.15, "stone", [], false);
  wall(boxes, "z", hz0, hz1, hx1 - ft, hx1, cB, fH - 0.15, "stone", [cellarDoor], false);
  wall(boxes, "x", hx0 + ft, hx1 - ft, hz0, hz0 + ft, cB, fH - 0.15, "stone", [], false);
  wall(boxes, "x", hx0 + ft, hx1 - ft, hz1 - ft, hz1, cB, fH - 0.15, "stone", [], false);
  // Above ground the foundation shows as a concrete band.
  boxes.push(slab(hx0 - 0.15, hx1 + 0.15, hz0 - 0.15, hz0, gH - 0.3, fH, "concrete", true));
  boxes.push(slab(hx0 - 0.15, hx1 + 0.15, hz1, hz1 + 0.15, gH - 0.3, fH, "concrete", true));
  boxes.push(slab(hx0 - 0.15, hx0, hz0, hz1, gH - 0.3, fH, "concrete", true));
  boxes.push(slab(hx1, hx1 + 0.15, hz0, cellarDoor.a0 - 0.2, gH - 0.3, fH, "concrete", true));
  boxes.push(slab(hx1, hx1 + 0.15, cellarDoor.a1 + 0.2, hz1, gH - 0.3, fH, "concrete", true));
  boxes.push(slab(hx0, hx1, hz0, hz1, fH - 0.15, fH, "plank", true));
  floors.push({ x0: hx0 + ft, x1: hx1 - ft, z0: hz0 + ft, z1: hz1 - ft, y: cF, room: "cellar" });
  floors.push({ x0: hx0, x1: hx1, z0: hz0, z1: hz1, y: fH, room: "house" });

  // House walls with the front door and the windows (same places as the M1 gray-box).
  const win = (a: number, yb: number) => ({ a0: a - 0.5, a1: a + 0.5, y0: gH + yb, y1: gH + yb + 1.4 });
  const frontDoor = { a0: H.x - 0.5, a1: H.x + 0.5, y0: fH, y1: fH + 2.1 };
  const southWins = [win(H.x - 3, 1.4), win(H.x + 3, 1.4), win(H.x - 3, 4.2), win(H.x + 3, 4.2), win(H.x, 4.2)];
  const sideWins = [win(H.z - 2.2, 1.4), win(H.z + 2.2, 1.4), win(H.z - 2.2, 4.2), win(H.z + 2.2, 4.2)];
  wall(boxes, "x", hx0, hx1, hz0, hz0 + t, fH, houseTop, "houseWall", [frontDoor, ...southWins]);
  wall(boxes, "x", hx0, hx1, hz1 - t, hz1, fH, houseTop, "houseWall");
  wall(boxes, "z", hz0 + t, hz1 - t, hx0, hx0 + t, fH, houseTop, "houseWall", sideWins);
  wall(boxes, "z", hz0 + t, hz1 - t, hx1 - t, hx1, fH, houseTop, "houseWall", sideWins);
  southWins.forEach((o) => glass(boxes, "x", hz0 + t / 2, o));
  sideWins.forEach((o) => { glass(boxes, "z", hx0 + t / 2, o); glass(boxes, "z", hx1 - t / 2, o); });
  // Interior plaster skin on the inside of the upper storey reads as a room, not a barn.
  boxes.push(slab(hx0 + t, hx1 - t, hz0 + t, hz1 - t, houseTop - 0.2, houseTop, "plaster")); // ceiling

  // Stairs up the west wall; the upper floor has a hole over them.
  const sx0 = hx0 + t, sx1 = sx0 + 1.2, sz0 = 66, sz1 = hz1 - t;
  stairs(boxes, floors, sx0, sx1, sz0, sz1, fH, fU, "house", "z0");
  boxes.push(slab(sx1, hx1 - t, hz0 + t, hz1 - t, fU - 0.15, fU, "plank", true));
  boxes.push(slab(sx0, sx1, hz0 + t, sz0, fU - 0.15, fU, "plank", true));
  floors.push({ x0: sx1, x1: hx1 - t, z0: hz0 + t, z1: hz1 - t, y: fU, room: "upstairs" });
  floors.push({ x0: sx0, x1: sx1, z0: hz0 + t, z1: sz0, y: fU, room: "upstairs" });
  // Railing around the stair hole upstairs (open at the top step).
  boxes.push(solid(sx1, sx1 + 0.08, sz0, sz1 - 1.1, fU, fU + 0.95, "wood"));
  boxes.push(solid(sx0, sx1, sz0 - 0.08, sz0, fU, fU + 0.95, "wood"));

  // Porch and steps (in front, facing the road).
  boxes.push(slab(hx0, hx1, hz0 - 2.6, hz0, gH - 0.1, gH + 0.4, "wood", true));
  floors.push({ x0: hx0, x1: hx1, z0: hz0 - 2.6, z1: hz0, y: gH + 0.4, room: null });
  boxes.push(slab(H.x - 0.8, H.x + 0.8, hz0 - 3.2, hz0 - 2.6, gH - 0.1, gH + 0.18, "wood"));
  floors.push({ x0: H.x - 0.8, x1: H.x + 0.8, z0: hz0 - 3.2, z1: hz0 - 2.6, y: gH + 0.18, room: null });

  // Ground floor: kitchen table, counter, cookstove.
  boxes.push(solid(H.x, H.x + 1.8, 68, 69.4, fH, fH + 0.76, "wood", true));
  boxes.push(solid(hx1 - t - 0.6, hx1 - t, 66.4, 70.8, fH, fH + 0.9, "plank", true));
  boxes.push(solid(H.x + 1.6, H.x + 2.6, hz1 - t - 0.75, hz1 - t, fH, fH + 0.85, "iron", true));
  boxes.push(slab(H.x + 2.0, H.x + 2.2, hz1 - t - 0.45, hz1 - t - 0.25, fH + 0.85, fU - 0.15, "iron"));
  // Upstairs: bed, writing desk, a map on the wall.
  const bed = { x: hx1 - t - 1.2, y: fU, z: hz1 - t - 1.3 };
  boxes.push(solid(hx1 - t - 2.4, hx1 - t, hz1 - t - 2.1, hz1 - t, fU, fU + 0.45, "wood", true));
  boxes.push(slab(hx1 - t - 2.35, hx1 - t - 0.05, hz1 - t - 2.05, hz1 - t - 0.05, fU + 0.45, fU + 0.6, "quilt"));
  boxes.push(slab(hx1 - t - 2.4, hx1 - t, hz1 - t - 0.12, hz1 - t, fU, fU + 1.1, "darkWood")); // headboard
  boxes.push(solid(H.x + 1.4, H.x + 3.2, hz0 + t, hz0 + t + 0.6, fU, fU + 0.76, "wood", true)); // desk
  boxes.push(slab(H.x + 1.7, H.x + 2.2, hz0 + t + 0.15, hz0 + t + 0.45, fU + 0.76, fU + 0.79, "paper")); // journal
  boxes.push(slab(hx1 - t - 0.03, hx1 - t, 66.2, 67.8, fU + 1.1, fU + 2.0, "paper")); // map
  stations.push(
    { id: "bed", label: "Bed — sleep (saves)", x: bed.x - 0.6, y: fU, z: bed.z - 1.2, radius: 1.6 },
    { id: "desk", label: "Writing desk — journal & ledger", x: H.x + 2.3, y: fU, z: hz0 + t + 1.2, radius: 1.3 },
  );

  // Root cellar: shelves of crates along the west wall.
  const cellarShelfYs = [0.3, 0.9, 1.5].map((h) => cF + h);
  boxes.push(solid(hx0 + ft, hx0 + ft + 0.55, 64.6, 71.4, cF, cF + 1.9, null));
  for (const y of cellarShelfYs) boxes.push(slab(hx0 + ft, hx0 + ft + 0.55, 64.6, 71.4, y - 0.04, y, "plank"));
  for (const z of [64.6, 68, 71.4]) boxes.push(slab(hx0 + ft, hx0 + ft + 0.55, z - 0.05, z + 0.05, cF, cF + 1.9, "darkWood"));
  stations.push({ id: "cellar", label: "Root cellar shelves", x: hx0 + ft + 1.4, y: cF, z: 68, radius: 2.2 });

  // Bulkhead stairwell on the east side and the short passage into the cellar.
  const swX0 = -36, swX1 = -34, swZ0 = 62, swZ1 = 68;
  const yTop = heightAt(-35, swZ0 - 0.1);
  const curb = yTop + 0.3;
  // Gravel apron over the cut-out ground around the house.
  const ring = [];
  for (let x = -48; x <= -36; x += 1) ring.push(heightAt(x, 62), heightAt(x, 74));
  for (let z = 62; z <= 74; z += 1) ring.push(heightAt(-48, z), heightAt(-36, z));
  const aT = Math.max(...ring) + 0.03;
  const apron: [number, number, number, number][] = [
    [-48, -36, 62, hz0], [-48, -36, hz1, 74], [-48, hx0, hz0, hz1], [hx1, -36, hz0, hz1],
  ];
  for (const [x0, x1, z0, z1] of apron) {
    boxes.push(slab(x0, x1, z0, z1, aT - 0.2, aT, "gravel"));
    floors.push({ x0, x1, z0, z1, y: aT, room: null });
  }
  const sw = 0.2;
  const passage = { a0: cellarDoor.a0, a1: cellarDoor.a1, y0: cF, y1: cF + 2.1 };
  wall(boxes, "z", swZ0, swZ1, swX0, swX0 + sw, cF - 0.1, curb, "stone", [passage], false);
  wall(boxes, "z", swZ0, swZ1, swX1 - sw, swX1, cF - 0.1, curb, "stone", [], false);
  wall(boxes, "x", swX0, swX1, swZ1 - sw, swZ1, cF - 0.1, curb, "stone", [], false);
  stairs(boxes, floors, swX0 + sw, swX1 - sw, swZ0, 66.6, cF, yTop, null, "z1", "stone");
  floors.push({ x0: swX0 + sw, x1: swX1 - sw, z0: 66.6, z1: swZ1 - sw, y: cF, room: null });
  boxes.push(slab(swX0 + sw, swX1 - sw, 66.6, swZ1 - sw, cB, cF, "stone"));
  // Passage (x −37..−36, under the apron).
  floors.push({ x0: hx1 - ft, x1: swX0 + sw, z0: passage.a0, z1: passage.a1, y: cF, room: "cellar" });
  boxes.push(slab(hx1, swX0, passage.a0, passage.a1, cB, cF, "stone"));
  boxes.push(solid(hx1, swX0, passage.a0 - 0.2, passage.a0, cF - 0.1, aT - 0.2, "stone"));
  boxes.push(solid(hx1, swX0, passage.a1, passage.a1 + 0.2, cF - 0.1, aT - 0.2, "stone"));
  // Keep people from stepping off the curb into the stairwell except at its open (south) end.
  boxes.push(solid(swX0, swX0 + sw, swZ0, swZ1, curb, curb + 0.9, null));
  boxes.push(solid(swX1 - sw, swX1, swZ0, swZ1, curb, curb + 0.9, null));
  boxes.push(solid(swX0, swX1, swZ1 - sw, swZ1, curb, curb + 0.9, null));
  // Bulkhead doors, swung open to either side.
  boxes.push(slab(swX0 - 0.08, swX0 - 0.02, swZ0 + 0.4, swZ0 + 2.6, curb, curb + 1.0, "darkWood"));
  boxes.push(slab(swX1 + 0.02, swX1 + 0.08, swZ0 + 0.4, swZ0 + 2.6, curb, curb + 1.0, "darkWood"));

  // ============================================================ FARM STAND
  const S = SITE.farmStand;
  const gS = heightAt(S.x, S.z);
  boxes.push(solid(S.x - 1.6, S.x + 1.6, S.z - 0.6, S.z + 0.6, gS, gS + 0.95, null));
  stations.push({ id: "stand", label: "Roadside stand — stock, orders, cash box", x: S.x, y: gS, z: S.z - 1.4, radius: 2.2 });

  return {
    boxes, floors, stations,
    anchors: {
      barnFloor: fB, loftFloor: fL, houseFloor: fH, upstairsFloor: fU, cellarFloor: cF,
      mortar, stove,
      racks: { z: rackZ, y: rackY, x0: 2.2, x1: 12.2 },
      shelf: { x: wx + 0.21, z0: 65.6, z1: 70.2, ys: shelfYs },
      catalog,
      cellarShelf: { x: hx0 + ft + 0.27, z0: 64.6, z1: 71.4, ys: cellarShelfYs },
      standShelf: { x0: S.x - 1.4, x1: S.x + 1.4, z: S.z, y: gS + 0.95 },
      vent: { x: B.x, z: bz1, y0: vent.y0, y1: vent.y1, width: vent.a1 - vent.a0 },
      bed,
      porch: { x: H.x, y: gH + 0.4, z: hz0 - 1.4 },
      lamps: [
        { room: "barn", x: 4.5, y: fL - 0.6, z: 63 },
        { room: "loft", x: B.x, y: fL + 2.6, z: 67 },
        { room: "tack", x: -1, y: tackTop - 0.4, z: 58 },
        { room: "house", x: H.x, y: fU - 0.5, z: 68 },
        { room: "upstairs", x: H.x + 2, y: houseTop - 0.6, z: 68 },
        { room: "cellar", x: H.x, y: fH - 0.5, z: 68 },
      ],
      barnTop, houseTop, tackTop, gB, gH,
    },
  };
}

let cached: Layout | null = null;
/** The homestead layout (built once). */
export function layout(): Layout {
  return (cached ??= buildLayout());
}
