/**
 * M2 — Habitat layers for Map 1.
 *
 * Every 2 m node on the property gets the physical conditions a plant would
 * actually experience there. Plants in M3 read these layers to decide where
 * they can live; nothing herbaceous is placed by hand.
 *
 * All continuous layers are 0–1. "Light" and "moisture" describe the GROWING
 * SEASON (summer canopy in leaf), not the bare-tree March the player first sees.
 *
 * Pure TypeScript (no Babylon): runs in the sim Web Worker and in tests.
 */
import { GRID, NODE_COUNT, nodeIndex, nodeX, nodeZ } from "./grid";
import {
  SITE,
  type ZoneId,
  distToPolyline,
  fencerowCanopy,
  heightAt,
  smooth,
  noise2,
  zoneAt,
} from "../world/map";

export const SUBSTRATE = { soil: 0, gravel: 1, built: 2, litter: 3 } as const;
export const MOW = { never: 0, yearly: 1, periodic: 2, weekly: 3 } as const;
export const MOW_NAMES = ["never mowed", "mowed yearly", "mowed periodically", "mowed weekly"];
export const SUBSTRATE_NAMES = ["soil", "gravel", "built", "leaf litter"];

/** Stable zone numbering for the Uint8 zone layer. Append only. */
export const ZONE_ORDER: ZoneId[] = [
  "road", "ditch", "yard", "barnyard", "garden", "prairie", "remnant",
  "fencerow", "edge", "treeline", "neighborWest", "neighborEast", "neighborSouth",
];
const ZONE_INDEX = new Map(ZONE_ORDER.map((z, i) => [z, i]));

export interface HabitatLayers {
  /** Ground height at each node (m). */
  height: Float32Array;
  /** Growing-season light reaching the ground: 1 open sun, 0 deep shade. */
  light: Float32Array;
  /** Soil moisture: 0 droughty, 1 saturated. */
  moisture: Float32Array;
  /** Soil disturbance and trampling: 0 untouched, 1 constantly churned. */
  disturbance: Float32Array;
  /** Nutrient level (mostly nitrogen): 0 lean, 1 manure-rich. */
  fertility: Float32Array;
  /** Closeness to the old garden and house: where escaped herbs can reach (0–1). */
  homestead: Float32Array;
  /** Closeness to bird perches (fences, wires, trees): where bird-sown seed lands (0–1). */
  perch: Float32Array;
  /** Raw topographic wetness index, normalised 0–1 (before ditch/shade adjustments). */
  wetness: Float32Array;
  mow: Uint8Array;
  /** Years since the last burn (255 = never). */
  fireAge: Uint8Array;
  /** 1 = plowed or graded at some point in the farm's history; 0 = never broken. */
  plowed: Uint8Array;
  substrate: Uint8Array;
  zone: Uint8Array;
}

export const LAYER_KEYS = ["light", "moisture", "disturbance", "fertility", "homestead", "perch", "wetness"] as const;
export type ContinuousLayer = (typeof LAYER_KEYS)[number];

// --------------------------------------------------------------- footprints

interface Rect { x0: number; x1: number; z0: number; z1: number; height: number; name: string }

/** Axis-aligned footprints of everything built (all Map 1 buildings face south). */
export function builtFootprints(): Rect[] {
  const fh = SITE.farmhouse, bn = SITE.barn, fs = SITE.farmStand;
  const rects: Rect[] = [
    { name: "farmhouse", x0: fh.x - fh.w / 2, x1: fh.x + fh.w / 2, z0: fh.z - fh.d / 2 - 2.6, z1: fh.z + fh.d / 2, height: 9 },
    { name: "rootcellar", x0: fh.x + fh.w / 2, x1: fh.x + fh.w / 2 + 3, z0: fh.z - 6, z1: fh.z, height: 0.8 },
    { name: "barn", x0: bn.x - bn.w / 2, x1: bn.x + bn.w / 2, z0: bn.z - bn.d / 2, z1: bn.z + bn.d / 2, height: 10.5 },
    { name: "tackroom", x0: bn.x - bn.w / 2 - 4, x1: bn.x - bn.w / 2, z0: bn.z - 8, z1: bn.z, height: 3.5 },
    { name: "farmstand", x0: fs.x - 1.7, x1: fs.x + 1.7, z0: fs.z - 0.7, z1: fs.z + 0.7, height: 2.3 },
  ];
  for (const [bx, bz] of SITE.raisedBeds) {
    rects.push({ name: "raisedbed", x0: bx - 0.6, x1: bx + 0.6, z0: bz - 2, z1: bz + 2, height: 0.35 });
  }
  return rects;
}

function distToRect(x: number, z: number, r: { x0: number; x1: number; z0: number; z1: number }) {
  const dx = Math.max(r.x0 - x, 0, x - r.x1);
  const dz = Math.max(r.z0 - z, 0, z - r.z1);
  return Math.hypot(dx, dz);
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---------------------------------------------------------------- hydrology

/**
 * Topographic wetness index from real flow routing:
 *  1. Priority-flood fill removes pits so water always has a way out.
 *  2. Multiple-flow-direction routing (Freeman) spreads each node's water to
 *     every lower neighbour, weighted by slope^1.1.
 *  3. TWI = ln(a / tanβ): lots of upslope area on a flat spot = wet.
 */
export function wetnessIndex(height: Float32Array): Float32Array {
  const { nx, nz, cell } = GRID;
  const filled = Float32Array.from(height);

  // Priority-flood (Barnes et al. 2014) with a tiny gradient on flats.
  const done = new Uint8Array(NODE_COUNT);
  const heap: number[] = []; // binary min-heap of node indices by filled height
  const push = (n: number) => {
    heap.push(n);
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (filled[heap[p]] <= filled[heap[k]]) break;
      [heap[p], heap[k]] = [heap[k], heap[p]];
      k = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1, r = l + 1;
        let m = k;
        if (l < heap.length && filled[heap[l]] < filled[heap[m]]) m = l;
        if (r < heap.length && filled[heap[r]] < filled[heap[m]]) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k], heap[m]];
        k = m;
      }
    }
    return top;
  };
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    if (i === 0 || j === 0 || i === nx - 1 || j === nz - 1) {
      const n = nodeIndex(i, j);
      done[n] = 1;
      push(n);
    }
  }
  const EPS = 1e-4;
  while (heap.length) {
    const n = pop();
    const i = n % nx, j = (n / nx) | 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const a = i + di, b = j + dj;
      if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
      const m = nodeIndex(a, b);
      if (done[m]) continue;
      done[m] = 1;
      if (filled[m] <= filled[n]) filled[m] = filled[n] + EPS;
      push(m);
    }
  }

  // Flow accumulation, highest first.
  const order = Array.from({ length: NODE_COUNT }, (_, k) => k).sort((a, b) => filled[b] - filled[a]);
  const acc = new Float32Array(NODE_COUNT).fill(1); // each node contributes its own cell
  const w = new Float32Array(8);
  for (const n of order) {
    const i = n % nx, j = (n / nx) | 0;
    let sum = 0, k = 0;
    const targets: number[] = [];
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const a = i + di, b = j + dj;
      if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
      const m = nodeIndex(a, b);
      const drop = filled[n] - filled[m];
      if (drop <= 0) continue;
      const slope = drop / (cell * (di && dj ? Math.SQRT2 : 1));
      w[k] = Math.pow(slope, 1.1);
      sum += w[k];
      targets.push(m);
      k++;
    }
    for (let t = 0; t < targets.length; t++) acc[targets[t]] += (acc[n] * w[t]) / sum;
  }

  // Local slope from the unfilled surface (central differences).
  const twi = new Float32Array(NODE_COUNT);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const n = nodeIndex(i, j);
    const hx = (height[nodeIndex(Math.min(nx - 1, i + 1), j)] - height[nodeIndex(Math.max(0, i - 1), j)]) / (2 * cell);
    const hz = (height[nodeIndex(i, Math.min(nz - 1, j + 1))] - height[nodeIndex(i, Math.max(0, j - 1))]) / (2 * cell);
    const tanB = Math.max(Math.hypot(hx, hz), 0.002);
    const a = (acc[n] * cell * cell) / cell; // specific catchment area (m²/m)
    twi[n] = Math.log(a / tanB);
  }

  // Normalise between the 5th and 98th percentiles.
  const sorted = Float32Array.from(twi).sort();
  const lo = sorted[Math.floor(NODE_COUNT * 0.05)], hi = sorted[Math.floor(NODE_COUNT * 0.98)];
  for (let n = 0; n < NODE_COUNT; n++) twi[n] = clamp01((twi[n] - lo) / (hi - lo));
  return twi;
}

// ---------------------------------------------------------------- layers

const ZONE_FERTILITY: Partial<Record<ZoneId, number>> = {
  road: 0.15, ditch: 0.55, yard: 0.55, barnyard: 0.8, garden: 0.72, prairie: 0.36,
  remnant: 0.26, fencerow: 0.52, edge: 0.6, treeline: 0.62,
};
const ZONE_DISTURBANCE: Partial<Record<ZoneId, number>> = {
  road: 1.0, ditch: 0.4, yard: 0.32, barnyard: 0.82, garden: 0.45, prairie: 0.08,
  remnant: 0.03, fencerow: 0.12, edge: 0.1, treeline: 0.05,
};
const ZONE_PLOWED: Partial<Record<ZoneId, number>> = {
  road: 1, ditch: 1, yard: 1, barnyard: 1, garden: 1, prairie: 1,
  remnant: 0, fencerow: 0, edge: 0, treeline: 0,
};

/** The burn history of the remnant corner: last burned two seasons ago. */
export const REMNANT_FIRE_AGE = 2;

export function computeHabitat(): HabitatLayers {
  const L: HabitatLayers = {
    height: new Float32Array(NODE_COUNT),
    light: new Float32Array(NODE_COUNT),
    moisture: new Float32Array(NODE_COUNT),
    disturbance: new Float32Array(NODE_COUNT),
    fertility: new Float32Array(NODE_COUNT),
    homestead: new Float32Array(NODE_COUNT),
    perch: new Float32Array(NODE_COUNT),
    wetness: new Float32Array(NODE_COUNT),
    mow: new Uint8Array(NODE_COUNT),
    fireAge: new Uint8Array(NODE_COUNT),
    plowed: new Uint8Array(NODE_COUNT),
    substrate: new Uint8Array(NODE_COUNT),
    zone: new Uint8Array(NODE_COUNT),
  };

  for (let j = 0; j < GRID.nz; j++) for (let i = 0; i < GRID.nx; i++) {
    L.height[nodeIndex(i, j)] = heightAt(nodeX(i), nodeZ(j));
  }
  L.wetness = wetnessIndex(L.height);

  const built = builtFootprints();
  const garden = SITE.garden;
  const fh = SITE.farmhouse;
  const house = { x0: fh.x - fh.w / 2, x1: fh.x + fh.w / 2, z0: fh.z - fh.d / 2, z1: fh.z + fh.d / 2 };
  const by = SITE.barnyard;
  const fenceRects = [
    { x0: by.x0, x1: by.x1, z0: by.z0, z1: by.z1 },
    { x0: garden.x0, x1: garden.x1, z0: garden.z0, z1: garden.z1 },
  ];
  const wb = SITE.windbreak;
  const mp = SITE.manurePile;

  for (let j = 0; j < GRID.nz; j++) for (let i = 0; i < GRID.nx; i++) {
    const n = nodeIndex(i, j);
    const x = nodeX(i), z = nodeZ(j);
    const zone = zoneAt(x, z);
    L.zone[n] = ZONE_INDEX.get(zone)!;
    const jitter = noise2(x * 0.31 + 17, z * 0.31 - 9) - 0.5; // ±0.5 fine-scale variation

    // ---------------- substrate
    let substrate: number = SUBSTRATE.soil;
    const onDrive = z > 8 && distToPolyline(x, z, SITE.drive) < 1.9;
    if (zone === "road" || onDrive) substrate = SUBSTRATE.gravel;
    if (zone === "treeline" || zone === "edge") substrate = SUBSTRATE.litter;
    let insideBuilt: Rect | null = null;
    for (const r of built) if (x >= r.x0 - 0.3 && x <= r.x1 + 0.3 && z >= r.z0 - 0.3 && z <= r.z1 + 0.3) insideBuilt = r;
    const bn = SITE.barn;
    const onApron = Math.abs(x - bn.x) <= 4 && z >= bn.z - bn.d / 2 - 5 && z <= bn.z - bn.d / 2;
    if (onApron) substrate = SUBSTRATE.gravel;
    if (insideBuilt) substrate = SUBSTRATE.built;
    L.substrate[n] = substrate;

    // ---------------- light (growing season)
    let light = 1;
    // Tree-line crowns overhang the last ~10 m of the field (summer canopy).
    if (zone === "treeline") light *= 0.12 + 0.18 * Math.exp(-(z - SITE.treeline.z0) / 3);
    else light *= 1 - 0.72 * smooth(SITE.edge.z0 - 4, SITE.treeline.z0, z);

    const ax = Math.abs(x);
    const side: -1 | 1 = x < 0 ? -1 : 1;
    const canopy = fencerowCanopy(side, z);
    if (z > SITE.ditch.z1 && z < SITE.treeline.z0) {
      if (ax >= SITE.fencerowInner) light *= 1 - 0.78 * canopy;
      else light *= 1 - 0.32 * canopy * Math.exp(-(SITE.fencerowInner - ax) / 3.5);
    }

    for (const r of built) {
      if (r.height < 1) continue;
      // Shade falls to the north of each building (sun in the southern sky).
      const reach = r.height * 0.9;
      if (x >= r.x0 - 1 && x <= r.x1 + 1 && z > r.z1 && z <= r.z1 + reach) {
        light *= 0.42 + 0.58 * ((z - r.z1) / reach);
      } else if (z >= r.z0 && z <= r.z1 && (Math.abs(x - r.x0) < 3 || Math.abs(x - r.x1) < 3)) {
        light *= 0.85; // morning / evening shade beside the walls
      }
    }
    for (const t of SITE.yardTrees) {
      // Crown shade, nudged north of the trunk by the southern sun.
      const d = Math.hypot(x - t.x, z - (t.z + t.crown * 0.25));
      if (d < t.crown) light *= 0.3 + 0.25 * (d / t.crown);
      else if (d < t.crown * 1.5) light *= 0.55 + 0.45 * ((d - t.crown) / (t.crown * 0.5));
    }
    if (x >= wb.x0 - wb.crown && x <= wb.x1 + wb.crown) {
      const dz = z - wb.z;
      if (Math.abs(dz) < wb.crown) light *= 0.28;
      else if (dz > 0 && dz < 6) light *= 0.45 + 0.55 * (dz / 6);
    }
    if (insideBuilt) light = 0;
    L.light[n] = clamp01(light);

    // ---------------- moisture
    let m = 0.16 + 0.62 * L.wetness[n];
    if (zone === "ditch") {
      const t = (z - SITE.ditch.z0) / (SITE.ditch.z1 - SITE.ditch.z0);
      m += 0.32 * Math.sin(Math.PI * t);
      m += 0.22 * Math.exp(-((x - SITE.drive[0][0]) ** 2) / 40); // wet culvert end
    }
    m += 0.12 * (1 - L.light[n]); // shade holds moisture
    if (zone === "treeline" || zone === "edge") m += 0.1; // humus, toe of the slope
    if (zone === "garden") m += 0.15; // decades of mulch and watering
    for (const r of built) {
      if (r.height < 2) continue;
      const d = distToRect(x, z, r);
      if (d > 0 && d < 1.5) m += 0.12; // roof drip and downspouts
    }
    if (substrate === SUBSTRATE.gravel) m -= 0.22;
    L.moisture[n] = clamp01(m + jitter * 0.06);

    // ---------------- disturbance
    let dist = ZONE_DISTURBANCE[zone] ?? 0.1;
    if (onDrive || onApron) dist = 0.95;
    const mowPathD = distToPolyline(x, z, SITE.mowPath);
    const onPath = mowPathD < SITE.mowPathWidth / 2 && z > SITE.yard.z1 - 8;
    if (onPath) dist = Math.max(dist, 0.28);
    let nearestBuilt = Infinity;
    for (const r of built) if (r.height >= 2) nearestBuilt = Math.min(nearestBuilt, distToRect(x, z, r));
    if (nearestBuilt < 2.5) dist = Math.max(dist, 0.55); // trampled foundation strip
    const dMp = Math.hypot(x - mp.x, z - mp.z);
    if (zone === "barnyard") {
      const toFence = Math.min(x - by.x0, by.x1 - x, z - by.z0, by.z1 - z);
      if (toFence < 2.5) dist = 0.48; // under the fence: trampled less, never grazed short
      if (dMp > mp.r + 2 && dMp < mp.r + 8) dist = Math.min(dist, 0.5); // rank ring around the heap
    }
    if (dMp < mp.r + 2) dist = Math.max(dist, 0.9);
    const gateD = Math.hypot(x - by.x0, z - (by.z0 + by.z1) / 2);
    if (gateD < 4) dist = Math.max(dist, 0.9); // barnyard gate mud
    if (insideBuilt) dist = 1;
    L.disturbance[n] = clamp01(dist + jitter * 0.08);

    // ---------------- fertility
    let fert = ZONE_FERTILITY[zone] ?? 0.45;
    if (zone === "prairie" || zone === "remnant") fert += 0.28 * (L.wetness[n] - 0.4); // swales richer, ridges poorer
    fert += 0.45 * Math.exp(-dMp / 9); // manure plume
    if (distToRect(x, z, house) < 4) fert = Math.max(fert, 0.62); // ash, scraps, old dooryard
    for (const t of SITE.yardTrees) if (Math.hypot(x - t.x, z - t.z) < t.crown) fert += 0.05;
    if (onPath) fert += 0.03;
    L.fertility[n] = clamp01(fert + jitter * 0.1);

    // ---------------- homestead source (escaped garden herbs)
    const dGarden = distToRect(x, z, garden);
    const dHouse = distToRect(x, z, house);
    L.homestead[n] = Math.max(Math.exp(-dGarden / 14), 0.8 * Math.exp(-dHouse / 10));

    // ---------------- perch (bird-sown seed rain)
    let perchD = Infinity;
    if (z > SITE.ditch.z1 && z < SITE.treeline.z0) perchD = Math.abs(ax - 72.5);
    perchD = Math.min(perchD, Math.abs(z - 10.5)); // utility wire along the road
    for (const r of fenceRects) {
      const inX = x >= r.x0 && x <= r.x1, inZ = z >= r.z0 && z <= r.z1;
      const dEdge = inX && inZ
        ? Math.min(x - r.x0, r.x1 - x, z - r.z0, r.z1 - z)
        : distToRect(x, z, r);
      perchD = Math.min(perchD, dEdge);
    }
    for (const t of SITE.yardTrees) perchD = Math.min(perchD, Math.max(0, Math.hypot(x - t.x, z - t.z) - t.crown));
    perchD = Math.min(perchD, Math.max(0, SITE.treeline.z0 - z));
    L.perch[n] = Math.exp(-perchD / 3);

    // ---------------- management + history
    let mow: number = MOW.never;
    if (zone === "yard" && !onDrive && !insideBuilt) mow = MOW.weekly;
    if (zone === "ditch") mow = MOW.periodic;
    if (onPath) mow = MOW.periodic;
    L.mow[n] = mow;
    L.plowed[n] = ZONE_PLOWED[zone] ?? 1;
    L.fireAge[n] = zone === "remnant" ? REMNANT_FIRE_AGE : 255;
  }
  return L;
}

/** Everything a HUD or test wants to know about one node. */
export function describeNode(L: HabitatLayers, n: number) {
  return {
    zone: ZONE_ORDER[L.zone[n]],
    light: L.light[n],
    moisture: L.moisture[n],
    disturbance: L.disturbance[n],
    fertility: L.fertility[n],
    homestead: L.homestead[n],
    perch: L.perch[n],
    mow: MOW_NAMES[L.mow[n]],
    plowed: L.plowed[n] === 1,
    fireAge: L.fireAge[n],
    substrate: SUBSTRATE_NAMES[L.substrate[n]],
  };
}
