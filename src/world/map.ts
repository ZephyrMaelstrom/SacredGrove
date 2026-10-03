/**
 * Map 1 — Cedar Branch Road homestead.
 *
 * Pure data + math, no Babylon imports, so the same functions run in the
 * habitat-simulation Web Worker (src/sim) and in the renderer.
 *
 * Coordinates: metres. +X = east, +Z = north, +Y = up.
 * The gravel road runs east–west along the south edge (z ≈ 0–8);
 * the tree line closes the north edge (z ≈ 370–400).
 */

export const MAP = {
  minX: -80,
  maxX: 80,
  minZ: 0,
  maxZ: 400,
  /** Rendered terrain reaches past the property so the horizon is never bare. */
  renderMinX: -150,
  renderMaxX: 150,
  renderMinZ: -40,
  renderMaxZ: 460,
  /** Size of one habitat cell in the design doc (used from M2 on). */
  cell: 2,
} as const;

/** Where the player may stand. The tree line and fencerow wire are walls. */
export const WALKABLE = {
  minX: -71,
  maxX: 71,
  minZ: 1.5,
  maxZ: 368,
} as const;

export type ZoneId =
  | "road"
  | "ditch"
  | "yard"
  | "barnyard"
  | "garden"
  | "prairie"
  | "remnant"
  | "fencerow"
  | "edge"
  | "treeline"
  | "neighborWest"
  | "neighborEast"
  | "neighborSouth";

export interface ZoneInfo {
  id: ZoneId;
  name: string;
  /** Flat colour for the debug overlay (r, g, b in 0–1). */
  debug: [number, number, number];
}

export const ZONES: Record<ZoneId, ZoneInfo> = {
  road: { id: "road", name: "Gravel road", debug: [0.55, 0.55, 0.55] },
  ditch: { id: "ditch", name: "Roadside ditch", debug: [0.3, 0.55, 0.85] },
  yard: { id: "yard", name: "Yard & drive", debug: [0.55, 0.85, 0.45] },
  barnyard: { id: "barnyard", name: "Barnyard", debug: [0.6, 0.42, 0.25] },
  garden: { id: "garden", name: "Old kitchen garden", debug: [0.85, 0.55, 0.75] },
  prairie: { id: "prairie", name: "Light prairie", debug: [0.92, 0.82, 0.4] },
  remnant: { id: "remnant", name: "Remnant prairie corner", debug: [0.95, 0.55, 0.2] },
  fencerow: { id: "fencerow", name: "Fencerow", debug: [0.25, 0.6, 0.3] },
  edge: { id: "edge", name: "Forest edge", debug: [0.15, 0.45, 0.25] },
  treeline: { id: "treeline", name: "Tree line (no entry)", debug: [0.05, 0.25, 0.1] },
  neighborWest: { id: "neighborWest", name: "Neighbor's winter wheat", debug: [0.4, 0.4, 0.45] },
  neighborEast: { id: "neighborEast", name: "Neighbor's corn stubble", debug: [0.45, 0.4, 0.4] },
  neighborSouth: { id: "neighborSouth", name: "Pasture across the road", debug: [0.42, 0.42, 0.42] },
};

/** Key site features, shared by the terrain shaper and the building placer. */
export const SITE = {
  road: { z0: 0, z1: 8 },
  ditch: { z0: 8, z1: 14 },
  yard: { z0: 14, z1: 110 },
  prairie: { z0: 110, z1: 360 },
  edge: { z0: 360, z1: 372 },
  treeline: { z0: 372, z1: 400 },
  fencerowInner: 72, // |x| beyond this is fencerow
  remnant: { x0: 22, x1: 72, z0: 290, z1: 360 },
  farmhouse: { x: -42, z: 68, w: 10, d: 9, rotY: 0 },
  barn: { x: 8, z: 62, w: 14, d: 22, rotY: 0 },
  barnyard: { x0: 24, x1: 56, z0: 46, z1: 82 },
  garden: { x0: -52, x1: -30, z0: 82, z1: 100 },
  farmStand: { x: -12, z: 18.5 },
  /** Drive runs north from the road, then bends east to the barn's south apron. */
  drive: [
    [-20, 4],
    [-20, 34],
    [-13, 43],
    [7, 46],
  ] as [number, number][],
  /** A mowed footpath from the yard up through the old pasture to the woods. */
  mowPath: [
    [-12, 104],
    [-8, 180],
    [2, 260],
    [-2, 358],
  ] as [number, number][],
  mowPathWidth: 2.6,
  /** Raised beds east of the house (bottom-left corners are not used; centres). */
  raisedBeds: [
    [-30, 74],
    [-27.6, 74],
    [-25.2, 74],
    [-22.8, 74],
  ] as [number, number][],
  manurePile: { x: 50, z: 76, r: 2 },
  /** Open-grown yard trees: position and summer crown radius (m). */
  yardTrees: [
    { x: -54, z: 52, crown: 9, species: "whiteOak" },
    { x: -27, z: 27, crown: 6, species: "sugarMaple" },
  ],
  /** Red cedar windbreak behind (north of) the barn. */
  windbreak: { x0: -4, x1: 18.5, z: 84, crown: 2.2 },
  /** Fallen logs along the forest edge: host wood for fungi. */
  logs: [
    { x: -48, z: 366, len: 7, rotY: 0.3, dia: 0.5 },
    { x: -9, z: 368, len: 5, rotY: -0.6, dia: 0.4 },
    { x: 31, z: 364, len: 8, rotY: 1.2, dia: 0.6 },
    { x: 58, z: 367, len: 6, rotY: 0.1, dia: 0.45 },
  ],
} as const;

/** Distance from (x, z) to a polyline. */
export function distToPolyline(x: number, z: number, pts: readonly (readonly [number, number])[]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
    const dx = bx - ax, dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
    best = Math.min(best, Math.hypot(ax + t * dx - x, az + t * dz - z));
  }
  return best;
}

/** Which zone a ground point belongs to. */
export function zoneAt(x: number, z: number): ZoneId {
  if (z < SITE.road.z0) return "neighborSouth";
  if (z < SITE.road.z1) return "road";
  if (z >= SITE.treeline.z0) return "treeline";
  if (x < MAP.minX) return "neighborWest";
  if (x > MAP.maxX) return "neighborEast";
  if (z < SITE.ditch.z1) return "ditch";
  if (z >= SITE.treeline.z0) return "treeline";
  if (Math.abs(x) >= SITE.fencerowInner) return "fencerow";
  if (z >= SITE.edge.z0) return "edge";
  const r = SITE.remnant;
  if (x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1) return "remnant";
  if (z >= SITE.prairie.z0) return "prairie";
  const b = SITE.barnyard;
  if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) return "barnyard";
  const g = SITE.garden;
  if (x >= g.x0 && x <= g.x1 && z >= g.z0 && z <= g.z1) return "garden";
  return "yard";
}

// ---------------------------------------------------------------- terrain

export const smooth = (e0: number, e1: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Cheap deterministic value noise (no external deps, same in worker + main). */
function hash(ix: number, iz: number): number {
  let h = ix * 374761393 + iz * 668265263;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
export function noise2(x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz), b = hash(ix + 1, iz), c = hash(ix, iz + 1), d = hash(ix + 1, iz + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm(x: number, z: number): number {
  return 0.5 * noise2(x, z) + 0.25 * noise2(x * 2.03, z * 2.03) + 0.125 * noise2(x * 4.1, z * 4.1);
}

/**
 * Woody cover along a fencerow, 0 (open gap) to 1 (closed canopy). Shared by
 * the woody-plant placer (where the shrubs and small trees stand) and the
 * habitat light layer (how much shade they cast), so the two always agree.
 */
export function fencerowCanopy(side: -1 | 1, z: number): number {
  const n = fbm(side * 3.7 + 20, z * 0.045);
  return smooth(0.36, 0.56, n);
}

/** Distance from (x, z) to the drive centreline. */
export function distToDrive(x: number, z: number): number {
  return distToPolyline(x, z, SITE.drive);
}

/**
 * Ground height in metres. Southern Illinois till plain: a gentle rise of
 * ~2.5 m from road to woods, soft swells in the old pasture, a V-ditch along
 * the road, a flattened homestead pad, and a low knoll on the never-plowed
 * remnant corner.
 */
export function heightAt(x: number, z: number): number {
  let y = 0.0065 * z;

  // Rolling swells, faded out over the homestead so buildings sit level.
  const swell =
    0.9 * (fbm(x * 0.018 + 3.1, z * 0.018 + 7.7) - 0.45) +
    0.35 * Math.sin(x * 0.035 + 1.3) * Math.sin(z * 0.021);
  const pad = smooth(96, 125, z); // 0 on the homestead pad, 1 in the prairie
  y += swell * (0.25 + 0.75 * pad);

  // Remnant knoll.
  y += 0.9 * Math.exp(-((x - 46) ** 2 + (z - 330) ** 2) / 500);

  // Road: crowned gravel, slightly raised.
  if (z >= SITE.road.z0 && z < SITE.road.z1) {
    y = 0.05 + 0.06 * Math.cos(((z - 4) / 4) * (Math.PI / 2));
  }
  // V-ditch between road and yard.
  if (z >= SITE.ditch.z0 && z < SITE.ditch.z1) {
    const t = (z - SITE.ditch.z0) / (SITE.ditch.z1 - SITE.ditch.z0);
    y = y * smooth(0, 1, t) - 0.75 * Math.sin(Math.PI * t);
    // Culvert under the drive: ditch floor fills in where the drive crosses.
    const nearDrive = Math.abs(x - SITE.drive[0][0]);
    if (nearDrive < 4) y = Math.max(y, 0.08 - (nearDrive / 4) * 0.4);
  }

  // Drive: graded slightly above the yard.
  const dd = distToDrive(x, z);
  if (z >= SITE.ditch.z0 && dd < 3) y += 0.06 * (1 - dd / 3);

  // Tree line sits on a slight rise.
  y += 0.8 * smooth(355, 400, z);
  return y;
}
