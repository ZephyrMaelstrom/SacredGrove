/**
 * M3 — Where every plant on Map 1 grows.
 *
 * For each 2 m habitat node:
 *   1. Every plant gets an abundance score:
 *        suitability (habitat fit, see suitability.ts)
 *      × abundance   (how common the plant is where it fits)
 *      × patchiness  (the plant's own clumping pattern: clonal colonies form
 *                     big patches, wind-sown annuals scatter)
 *   2. The node's ground cover sets how many individuals it holds
 *      (gravel and bare mud hold fewer).
 *   3. Individuals are drawn from the scores, so dominant plants dominate
 *      but the community stays mixed — like a real quadrat.
 *
 * Trees and shrubs are a second, sparser pass with minimum spacing.
 * Wood-rotting fungi grow only on the fallen logs.
 *
 * Fully deterministic from the seed: the same world every load, so a saved
 * game can refer to an individual plant by its index.
 */
import { PLANTS, isWoody, onMap, type Plant } from "../data/plants";
import { GRID, NODE_COUNT, nodeX, nodeZ } from "./grid";
import { SUBSTRATE, ZONE_ORDER, type HabitatLayers } from "./habitat";
import { suitability } from "./suitability";
import { rng, hashString, mixSeed } from "./random";
import { SITE, fbm, fencerowCanopy, heightAt, smooth } from "../world/map";

export interface InstanceSet {
  count: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  scale: Float32Array;
  rotY: Float32Array;
  /** Index into PLANTS. */
  plant: Uint16Array;
  /** Biennial cohort (0 first-year rosette, 1 bolting); 1 for everything else. */
  cohort: Uint8Array;
  /** Habitat node the individual grows in (for harvest pressure later). */
  node: Uint32Array;
}

export interface Population {
  herbs: InstanceSet;
  woody: InstanceSet;
  /** Most abundant herb at each node (PLANTS index), or NONE. Drives far-field colour. */
  dominant: Uint16Array;
}

export const NONE = 0xffff;
export const WORLD_SEED = 20261003;

/** Individuals per node at full cover (one node = 4 m²). */
const SLOTS_PER_NODE = 5;
/** Herbs are simulated a short way under the tree line, where you can see them from the edge. */
const HERB_MAX_Z = 384;

class Builder {
  private cap: number;
  set: InstanceSet;
  constructor(cap: number) {
    this.cap = cap;
    this.set = Builder.alloc(cap);
  }
  static alloc(n: number): InstanceSet {
    return {
      count: 0,
      x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n),
      scale: new Float32Array(n), rotY: new Float32Array(n),
      plant: new Uint16Array(n), cohort: new Uint8Array(n), node: new Uint32Array(n),
    };
  }
  push(x: number, z: number, scale: number, rotY: number, plant: number, cohort: number, node: number, y = heightAt(x, z)) {
    if (this.set.count === this.cap) this.grow();
    const s = this.set, k = s.count++;
    s.x[k] = x; s.y[k] = y; s.z[k] = z; s.scale[k] = scale; s.rotY[k] = rotY;
    s.plant[k] = plant; s.cohort[k] = cohort; s.node[k] = node;
  }
  private grow() {
    const old = this.set;
    this.cap *= 2;
    const s = Builder.alloc(this.cap);
    s.count = old.count;
    for (const key of ["x", "y", "z", "scale", "rotY", "plant", "cohort", "node"] as const) {
      (s[key] as Float32Array).set(old[key] as Float32Array);
    }
    this.set = s;
  }
  trimmed(): InstanceSet {
    const s = this.set, n = s.count;
    return {
      count: n,
      x: s.x.slice(0, n), y: s.y.slice(0, n), z: s.z.slice(0, n),
      scale: s.scale.slice(0, n), rotY: s.rotY.slice(0, n),
      plant: s.plant.slice(0, n), cohort: s.cohort.slice(0, n), node: s.node.slice(0, n),
    };
  }
}

/**
 * A plant's own clumping pattern (0–1) at a point. Each plant gets a private
 * noise field at its patch scale; how sharply it's cut depends on how it spreads.
 */
export function patchiness(p: Plant, x: number, z: number): number {
  const h = hashString(p.latin);
  const ox = (h & 0xffff) / 97, oz = (h >>> 16) / 97;
  const f = fbm(x / p.patchScale + ox, z / p.patchScale + oz);
  switch (p.dispersal) {
    case "rhizome":
    case "spores":
      return 0.03 + 0.97 * smooth(0.4, 0.56, f); // clones: solid patches, gaps between
    case "escape":
      return 0.2 + 0.8 * smooth(0.35, 0.6, f);
    case "wind":
      return 0.35 + 0.65 * smooth(0.3, 0.65, f); // scattered everywhere it fits
    default:
      return 0.25 + 0.75 * smooth(0.35, 0.62, f);
  }
}

export function plantsForMap(map: number) {
  const herbs: number[] = [], woody: number[] = [], logFungi: number[] = [];
  PLANTS.forEach((p, i) => {
    if (!onMap(p, map)) return;
    if (p.host === "wood") logFungi.push(i);
    else if (isWoody(p)) woody.push(i);
    else herbs.push(i);
  });
  return { herbs, woody, logFungi };
}

export function populate(L: HabitatLayers, map = 1, seed = WORLD_SEED): Population {
  const { herbs, woody, logFungi } = plantsForMap(map);
  const herbOut = new Builder(90_000);
  const woodyOut = new Builder(1_000);
  const dominant = new Uint16Array(NODE_COUNT).fill(NONE);
  const scores = new Float32Array(herbs.length);
  const ZONE = (name: string) => ZONE_ORDER.indexOf(name as never);
  const zFencerow = ZONE("fencerow"), zEdge = ZONE("edge"), zPrairie = ZONE("prairie"),
    zRemnant = ZONE("remnant"), zTreeline = ZONE("treeline"), zBarnyard = ZONE("barnyard");

  // ------------------------------------------------------------ herb layer
  for (let j = 0; j < GRID.nz; j++) {
    const z = nodeZ(j);
    if (z > HERB_MAX_Z) break;
    for (let i = 0; i < GRID.nx; i++) {
      const n = j * GRID.nx + i;
      const sub = L.substrate[n];
      if (sub === SUBSTRATE.built) continue;
      const x = nodeX(i);

      let sum = 0, best = 0, bestK = -1;
      for (let k = 0; k < herbs.length; k++) {
        const p = PLANTS[herbs[k]];
        const s = suitability(p, L, n);
        const a = s > 0.002 ? Math.pow(s * p.abundance * patchiness(p, x, z), 1.3) : 0;
        scores[k] = a;
        sum += a;
        if (a > best) { best = a; bestK = k; }
      }
      if (bestK < 0 || sum < 1e-4) continue;
      dominant[n] = herbs[bestK];

      let cover = sub === SUBSTRATE.gravel ? 0.35 : sub === SUBSTRATE.litter ? 0.75 : 1;
      if (L.zone[n] === zTreeline) cover = 0.5;
      if (L.zone[n] === zBarnyard && L.disturbance[n] > 0.85) cover = 0.55; // bare mud
      cover *= 0.35 + 0.65 * Math.min(1, sum * 3);

      const r = rng(mixSeed(seed, n));
      const slots = Math.floor(cover * SLOTS_PER_NODE + r());
      for (let s = 0; s < slots; s++) {
        let pick = r() * sum, k = 0;
        while (k < herbs.length - 1 && (pick -= scores[k]) > 0) k++;
        if (scores[k] === 0) continue;
        const pi = herbs[k], p = PLANTS[pi];
        const px = x + (r() - 0.5) * GRID.cell;
        const pz = z + (r() - 0.5) * GRID.cell;
        const cohort = p.cycle === "biennial" ? (r() < 0.55 ? 0 : 1) : 1;
        herbOut.push(px, pz, 0.75 + r() * 0.5, r() * Math.PI * 2, pi, cohort, n);
      }
    }
  }

  // ----------------------------------------------------------- woody layer
  const spacing = new Map<number, { x: number; z: number; r: number }[]>();
  const bucket = (x: number, z: number) => (Math.floor(x / 6) + 100) * 1000 + Math.floor(z / 6);
  const tooClose = (x: number, z: number, r: number) => {
    const bx = Math.floor(x / 6), bz = Math.floor(z / 6);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const o of spacing.get((bx + dx + 100) * 1000 + bz + dz) ?? []) {
        if (Math.hypot(o.x - x, o.z - z) < Math.max(r, o.r)) return true;
      }
    }
    return false;
  };
  const wScores = new Float32Array(woody.length);
  for (let j = 0; j < GRID.nz; j++) {
    const z = nodeZ(j);
    if (z >= SITE.treeline.z0) break; // the tree line itself is the structural forest
    for (let i = 0; i < GRID.nx; i++) {
      const n = j * GRID.nx + i;
      const zone = L.zone[n];
      const x = nodeX(i);
      let p = 0;
      if (zone === zFencerow) p = 0.03 + 0.22 * fencerowCanopy(x < 0 ? -1 : 1, z);
      else if (zone === zEdge) p = 0.3; // the shrub wall of a woods edge
      else if (zone === zPrairie) p = 0.0015 + 0.02 * L.perch[n]; // old-field invaders
      else if (zone === zRemnant) p = 0.001;
      if (!p) continue;
      const r = rng(mixSeed(seed ^ 0x5eed, n));
      if (r() > p) continue;

      let sum = 0;
      for (let k = 0; k < woody.length; k++) {
        const pl = PLANTS[woody[k]];
        let a = suitability(pl, L, n) * pl.abundance * patchiness(pl, x, z);
        if (zone === zEdge && pl.form === "tree") a *= 0.35; // the edge is a shrub wall; saplings are scattered
        wScores[k] = a;
        sum += a;
      }
      if (sum < 1e-4) continue;
      let pick = r() * sum, k = 0;
      while (k < woody.length - 1 && (pick -= wScores[k]) > 0) k++;
      const pi = woody[k], pl = PLANTS[pi];
      const px = x + (r() - 0.5) * GRID.cell, pz = z + (r() - 0.5) * GRID.cell;
      const minGap = pl.form === "tree" ? 4.5 : 2.5;
      if (tooClose(px, pz, minGap)) continue;
      const young = zone === zPrairie || zone === zRemnant;
      const scale = young ? 0.15 + r() * 0.25 : zone === zEdge ? 0.7 + r() * 0.3 : 0.5 + r() * 0.45;
      woodyOut.push(px, pz, scale, r() * Math.PI * 2, pi, 1, n);
      const key = bucket(px, pz);
      const list = spacing.get(key) ?? [];
      list.push({ x: px, z: pz, r: minGap });
      spacing.set(key, list);
    }
  }

  // --------------------------------------------------- fungi on fallen logs
  const rl = rng(seed ^ 0x106);
  for (const log of SITE.logs) {
    for (const pi of logFungi) {
      const p = PLANTS[pi];
      if (p.latin === "Laetiporus sulphureus" && log.dia < 0.5) continue; // big oak logs only
      const clusters = Math.max(1, Math.round(p.abundance * 8 * (log.len / 6)));
      for (let c = 0; c < clusters; c++) {
        const t = (rl() - 0.5) * 0.85 * log.len;
        const side = rl() < 0.5 ? -1 : 1;
        const ax = Math.sin(log.rotY), az = Math.cos(log.rotY);
        const px = log.x + ax * t + az * side * log.dia * 0.45;
        const pz = log.z + az * t - ax * side * log.dia * 0.45;
        const py = heightAt(log.x, log.z) + log.dia * (0.35 + rl() * 0.4);
        const n = Math.round((pz - GRID.minZ) / GRID.cell) * GRID.nx + Math.round((px - GRID.minX) / GRID.cell);
        // Brackets face outward, away from the log's axis.
        herbOut.push(px, pz, 0.8 + rl() * 0.5, log.rotY + (side > 0 ? Math.PI / 2 : -Math.PI / 2), pi, 1, n, py);
      }
    }
  }

  return { herbs: herbOut.trimmed(), woody: woodyOut.trimmed(), dominant };
}
