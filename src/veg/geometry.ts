/**
 * Procedural plant geometry — one small mesh per (plant, visual) pair.
 *
 * Built from a handful of primitives (leaf, blade, stem ribbon, flower head)
 * whose proportions come from the plant's database row: growth form, height,
 * flower shape and colours. Each mesh is drawn thousands of times through
 * thin instances, so every one is kept to a strict triangle budget
 * (see TRI_BUDGET and tests/geometry.test.ts).
 *
 * Babylon-free: returns plain arrays so it can be tested in Node.
 */
import type { Plant } from "../data/plants";
import type { Visual } from "../sim/phenology";
import { rng, hashString } from "../sim/random";

export type RGB = [number, number, number];

export interface Geometry {
  positions: number[];
  normals: number[];
  colors: number[];
  indices: number[];
}

/** Hard ceiling per prototype; the renderer draws thousands of these. */
export const TRI_BUDGET = 90;
/** The sward tuft is drawn ~10,000 times; keep it tiny. */
export const TUFT_TRIS = 6;

export const hexToRgb = (hex: string): RGB => {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
};
export const mixRgb = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const shade = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];

class Mesher {
  g: Geometry = { positions: [], normals: [], colors: [], indices: [] };
  /** Adds a vertex; normals lean upward so foliage lights softly from any side. */
  v(x: number, y: number, z: number, c: RGB, nx = 0, ny = 1, nz = 0): number {
    const len = Math.hypot(nx, ny, nz) || 1;
    this.g.positions.push(x, y, z);
    this.g.normals.push(nx / len, ny / len, nz / len);
    this.g.colors.push(c[0], c[1], c[2], 1);
    return this.g.positions.length / 3 - 1;
  }
  tri(a: number, b: number, c: number) {
    this.g.indices.push(a, b, c);
  }
  get tris() {
    return this.g.indices.length / 3;
  }

  /** Diamond leaf from a base point, pointing along yaw, lifted by pitch (radians above horizontal). */
  leaf(bx: number, by: number, bz: number, yaw: number, pitch: number, len: number, wid: number, base: RGB, tip: RGB) {
    const dx = Math.cos(yaw) * Math.cos(pitch), dy = Math.sin(pitch), dz = Math.sin(yaw) * Math.cos(pitch);
    const sx = -Math.sin(yaw), sz = Math.cos(yaw);
    const mx = bx + dx * len * 0.45, my = by + dy * len * 0.45, mz = bz + dz * len * 0.45;
    const nx = dx * 0.4, nz = dz * 0.4;
    const a = this.v(bx, by, bz, base, nx, 1, nz);
    const l = this.v(mx + sx * wid / 2, my, mz + sz * wid / 2, mixRgb(base, tip, 0.5), nx, 1, nz);
    const r = this.v(mx - sx * wid / 2, my, mz - sz * wid / 2, mixRgb(base, tip, 0.5), nx, 1, nz);
    // Leaf tips droop a little below the straight line.
    const t = this.v(bx + dx * len, by + dy * len - len * 0.12, bz + dz * len, tip, nx, 1, nz);
    this.tri(a, l, t);
    this.tri(a, t, r);
  }

  /** Grass blade: a bent two-segment triangle strip. */
  blade(bx: number, bz: number, yaw: number, lean: number, h: number, w: number, base: RGB, tip: RGB, y0 = 0) {
    const dx = Math.cos(yaw), dz = Math.sin(yaw);
    const sx = -dz * w / 2, sz = dx * w / 2;
    const midOut = lean * 0.35 * h, topOut = lean * h;
    const a = this.v(bx + sx, y0, bz + sz, base, dx, 1, dz);
    const b = this.v(bx - sx, y0, bz - sz, base, dx, 1, dz);
    const m1 = this.v(bx + dx * midOut + sx * 0.6, y0 + h * 0.55, bz + dz * midOut + sz * 0.6, mixRgb(base, tip, 0.5), dx, 1, dz);
    const m2 = this.v(bx + dx * midOut - sx * 0.6, y0 + h * 0.55, bz + dz * midOut - sz * 0.6, mixRgb(base, tip, 0.5), dx, 1, dz);
    const t = this.v(bx + dx * topOut, y0 + h * (1 - lean * 0.35), bz + dz * topOut, tip, dx, 1, dz);
    this.tri(a, b, m1);
    this.tri(b, m2, m1);
    this.tri(m1, m2, t);
  }

  /** Thin stem: two crossed ribbons from (x0,y0,z0) to (x1,y1,z1). */
  stem(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, w: number, c0: RGB, c1: RGB) {
    for (const [ox, oz] of [[w / 2, 0], [0, w / 2]]) {
      const a = this.v(x0 - ox, y0, z0 - oz, c0, oz, 0.3, ox);
      const b = this.v(x0 + ox, y0, z0 + oz, c0, oz, 0.3, ox);
      const c = this.v(x1 + ox * 0.6, y1, z1 + oz * 0.6, c1, oz, 0.3, ox);
      const d = this.v(x1 - ox * 0.6, y1, z1 - oz * 0.6, c1, oz, 0.3, ox);
      this.tri(a, b, c);
      this.tri(a, c, d);
    }
  }

  /** Flat disk facing up (umbel, daisy head, cap). */
  disk(cx: number, cy: number, cz: number, r: number, rim: RGB, centre: RGB, sides = 6, tilt = 0) {
    const c = this.v(cx, cy + r * 0.15, cz, centre);
    const ring: number[] = [];
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      ring.push(this.v(cx + Math.cos(a) * r, cy - Math.sin(a) * tilt * r, cz + Math.sin(a) * r, rim));
    }
    for (let k = 0; k < sides; k++) this.tri(c, ring[(k + 1) % sides], ring[k]);
  }

  /** Small upright double-pyramid: globe heads, berries, buds. Tiny ones skip the underside. */
  globe(cx: number, cy: number, cz: number, r: number, c: RGB, tall = 1) {
    const top = this.v(cx, cy + r * tall, cz, c);
    const underside = r > 0.035;
    const bot = underside ? this.v(cx, cy - r * tall, cz, shade(c, 0.75), 0, -1, 0) : -1;
    const ring: number[] = [];
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + 0.4;
      ring.push(this.v(cx + Math.cos(a) * r, cy, cz + Math.sin(a) * r, c, Math.cos(a), 0.3, Math.sin(a)));
    }
    for (let k = 0; k < 4; k++) {
      this.tri(top, ring[(k + 1) % 4], ring[k]);
      if (underside) this.tri(bot, ring[k], ring[(k + 1) % 4]);
    }
  }

  /** A single blossom or berry seen from above: one small quad (2 triangles). */
  blossom(cx: number, cy: number, cz: number, r: number, c: RGB, rot: number) {
    const ca = Math.cos(rot) * r, sa = Math.sin(rot) * r;
    const a = this.v(cx + ca, cy, cz + sa, c);
    const b = this.v(cx - sa, cy + r * 0.3, cz + ca, c);
    const d = this.v(cx - ca, cy, cz - sa, c);
    const e = this.v(cx + sa, cy + r * 0.3, cz - ca, c);
    this.tri(a, b, d);
    this.tri(a, d, e);
  }
}

// --------------------------------------------------------------- heads

/** Draws a flower or seed head of the plant's shape at a stem tip. */
function head(m: Mesher, p: Plant, x: number, y: number, z: number, size: number, c: RGB, r: () => number, dead = false) {
  if (dead && p.flowerShape !== "plume") {
    // Winter seed heads: small and hard — cones, pods, curled "bird's nests".
    m.globe(x, y, z, size * 0.4, c, 1.3);
    return;
  }
  switch (p.flowerShape) {
    case "umbel":
      // Slightly domed, like a real umbel, not a plate.
      m.disk(x, y, z, size * 0.75, c, shade(c, 0.9), 6, -0.35);
      break;
    case "daisy": {
      const centre: RGB = p.latin === "Rudbeckia hirta" || p.latin === "Echinacea purpurea" ? [0.25, 0.17, 0.1] : shade(c, 0.85);
      m.disk(x, y, z, size * 0.8, c, centre, 6, 0.15);
      break;
    }
    case "globe":
      m.globe(x, y, z, size * 0.55, c, 1.2);
      break;
    case "spike":
      m.globe(x, y + size, z, size * 0.32, c, 3.2);
      break;
    case "plume": {
      // Branching panicle: a few short sprays off the stem tip.
      for (let k = 0; k < 4; k++) {
        const a = r() * Math.PI * 2;
        m.leaf(x, y - size * 0.6 + k * size * 0.25, z, a, 0.9 + r() * 0.4, size * 1.3, size * 0.3, c, shade(c, 1.12));
      }
      break;
    }
    case "bell":
      m.globe(x, y, z, size * 0.45, c, 1.6);
      break;
    default:
      m.globe(x, y, z, size * 0.5, c, 1);
  }
}

// --------------------------------------------------------------- colours

interface Palette { leaf: RGB; leafTip: RGB; flower: RGB; dormant: RGB; stem: RGB }

function palette(p: Plant, visual: Visual): Palette {
  const leaf = hexToRgb(p.colors.leaf);
  const flower = hexToRgb(p.colors.flower);
  const dormant = hexToRgb(p.colors.dormant);
  switch (visual) {
    case "senescent":
      return { leaf: mixRgb(leaf, dormant, 0.6), leafTip: mixRgb(leaf, dormant, 0.85), flower: dormant, dormant, stem: dormant };
    case "standing": {
      // Weathered stalks are paler than their summer stems; seed heads are either
      // fluffy and gray (goldenrod, asters) or dark and hard (coneflower, bergamot).
      const head = p.flowerShape === "plume" || p.flowerShape === "umbel" ? mixRgb(dormant, [0.82, 0.8, 0.75], 0.35) : shade(dormant, 0.55);
      return { leaf: dormant, leafTip: shade(dormant, 1.15), flower: head, dormant, stem: shade(dormant, 1.05) };
    }
    case "dormantClump":
    case "bare":
      return { leaf: shade(dormant, 0.9), leafTip: shade(dormant, 1.15), flower: shade(dormant, 0.75), dormant, stem: dormant };
    case "basal":
      // Overwintering rosettes are dull and a little purple-bronzed.
      return { leaf: shade(leaf, 0.82), leafTip: mixRgb(leaf, dormant, 0.3), flower, dormant, stem: leaf };
    default:
      return { leaf: shade(leaf, 0.85), leafTip: mixRgb(leaf, [0.85, 0.9, 0.6], 0.15), flower, dormant, stem: shade(leaf, 0.8) };
  }
}

// --------------------------------------------------------------- forms

function rosette(m: Mesher, pal: Palette, r: () => number, radius: number, count: number) {
  for (let k = 0; k < count; k++) {
    const yaw = (k / count) * Math.PI * 2 + r() * 0.4;
    m.leaf(0, 0.01, 0, yaw, 0.12 + r() * 0.25, radius * (0.75 + r() * 0.35), radius * 0.38, pal.leaf, pal.leafTip);
  }
}

function scapes(m: Mesher, p: Plant, pal: Palette, r: () => number, n: number, h: number, headSize: number, headColor: RGB) {
  for (let k = 0; k < n; k++) {
    const a = r() * Math.PI * 2, out = h * 0.15 * r();
    const x = Math.cos(a) * out, z = Math.sin(a) * out;
    m.stem(0, 0, 0, x, h * (0.75 + r() * 0.25), z, 0.012, pal.stem, pal.stem);
    head(m, p, x, h * (0.75 + r() * 0.25), z, headSize, headColor, r);
  }
}

/** Leafy upright stem(s) with paired leaves and an optional head on each. */
function leafyStems(m: Mesher, p: Plant, pal: Palette, r: () => number, stems: number, h: number, leafLevels: number, headColor: RGB | null, leaves = true) {
  for (let s = 0; s < stems; s++) {
    const a = r() * Math.PI * 2, spread = stems > 1 ? h * 0.12 : 0;
    const bx = Math.cos(a) * spread * r(), bz = Math.sin(a) * spread * r();
    const lean = (leaves ? 0.06 : 0.12 + r() * 0.16) * h; // winter stalks lean and sag
    const tx = bx + Math.cos(a) * lean, tz = bz + Math.sin(a) * lean;
    const top = h * (0.85 + r() * 0.15);
    m.stem(bx, 0, bz, tx, top, tz, Math.max(0.012, h * 0.012), pal.stem, pal.stem);
    if (leaves) {
      let yaw = r() * Math.PI;
      for (let l = 0; l < leafLevels; l++) {
        const t = (l + 0.6) / (leafLevels + 0.6);
        const y = top * t * 0.85;
        const x = bx + (tx - bx) * t, z = bz + (tz - bz) * t;
        const len = h * 0.2 * (1.15 - t * 0.6);
        m.leaf(x, y, z, yaw, -0.05 + r() * 0.3, len, len * 0.35, pal.leaf, pal.leafTip);
        m.leaf(x, y, z, yaw + Math.PI, -0.05 + r() * 0.3, len, len * 0.35, pal.leaf, pal.leafTip);
        yaw += Math.PI / 2;
      }
    }
    if (headColor) head(m, p, tx, top, tz, Math.max(0.03, h * 0.06), headColor, r, !leaves);
  }
}

function grassClump(m: Mesher, p: Plant, pal: Palette, r: () => number, blades: number, h: number, w: number, lean: number, seedHeads: RGB | null) {
  for (let k = 0; k < blades; k++) {
    const yaw = r() * Math.PI * 2, rad = r() * h * 0.06;
    m.blade(Math.cos(yaw) * rad, Math.sin(yaw) * rad, yaw, lean * (0.5 + r()), h * (0.6 + r() * 0.4), w, pal.leaf, pal.leafTip);
  }
  if (seedHeads) {
    for (let k = 0; k < 3; k++) {
      const yaw = r() * Math.PI * 2, out = h * 0.1;
      const x = Math.cos(yaw) * out, z = Math.sin(yaw) * out, top = h * (1.05 + r() * 0.25);
      m.stem(0, 0, 0, x, top, z, 0.008, pal.stem, pal.stem);
      head(m, p, x, top, z, h * 0.07, seedHeads, r);
    }
  }
}

function canes(m: Mesher, p: Plant, pal: Palette, r: () => number, visual: Visual, h: number) {
  const n = 5;
  const caneColor = visual === "standing" || visual === "bare" ? pal.dormant : mixRgb(pal.leaf, pal.dormant, 0.4);
  for (let k = 0; k < n; k++) {
    const yaw = (k / n) * Math.PI * 2 + r();
    const reach = h * (0.7 + r() * 0.5);
    // Arch: up to full height, then out and down.
    const pts: [number, number, number][] = [[0, 0, 0], [Math.cos(yaw) * reach * 0.3, h, Math.sin(yaw) * reach * 0.3], [Math.cos(yaw) * reach, h * 0.45, Math.sin(yaw) * reach]];
    m.stem(...pts[0], ...pts[1], 0.022, caneColor, caneColor);
    m.stem(...pts[1], ...pts[2], 0.018, caneColor, caneColor);
    if (visual !== "standing" && visual !== "bare") {
      const [x, y, z] = pts[1];
      m.leaf(x, y * 0.9, z, yaw + 1.2, 0.1, h * 0.22, h * 0.12, pal.leaf, pal.leafTip);
      m.leaf(x, y * 0.9, z, yaw - 1.2, 0.1, h * 0.22, h * 0.12, pal.leaf, pal.leafTip);
    }
    if (visual === "flowering") m.blossom(pts[2][0], pts[2][1] + 0.03, pts[2][2], 0.035, pal.flower, yaw);
    if (visual === "fruiting" || (visual === "standing" && p.latin === "Rosa carolina")) {
      m.blossom(pts[2][0], pts[2][1], pts[2][2], 0.03, p.latin === "Rosa carolina" ? [0.65, 0.12, 0.1] : [0.12, 0.06, 0.12], yaw);
    }
  }
}

function vineTangle(m: Mesher, pal: Palette, r: () => number, visual: Visual, h: number) {
  const dead = visual === "standing" || visual === "bare";
  const runners = 5;
  const reach = Math.max(0.5, h * 0.7);
  for (let k = 0; k < runners; k++) {
    const yaw = r() * Math.PI * 2, lift = r() * h * 0.6;
    const x = Math.cos(yaw) * reach, z = Math.sin(yaw) * reach;
    m.stem(0, 0.02, 0, x, 0.05 + lift, z, 0.014, pal.dormant, pal.dormant);
    if (!dead) {
      const t = 0.6;
      m.leaf(x * t, 0.05 + lift * t, z * t, yaw + 1.3, 0.35, reach * 0.35, reach * 0.25, pal.leaf, pal.leafTip);
      m.leaf(x * t, 0.05 + lift * t, z * t, yaw - 1.3, 0.35, reach * 0.35, reach * 0.25, pal.leaf, pal.leafTip);
    }
    if (visual === "fruiting") m.blossom(x, 0.08 + lift, z, 0.03, pal.dormant, yaw);
  }
}

function horsetail(m: Mesher, pal: Palette, r: () => number, visual: Visual, h: number) {
  const fertile = visual === "flowering";
  const n = fertile ? 5 : 7;
  for (let k = 0; k < n; k++) {
    const a = r() * Math.PI * 2, out = r() * 0.12;
    const x = Math.cos(a) * out, z = Math.sin(a) * out, top = h * (fertile ? 0.6 : 0.7 + r() * 0.3);
    const c = fertile ? pal.flower : pal.leaf;
    m.stem(x, 0, z, x * 1.3, top, z * 1.3, 0.012, c, c);
    if (!fertile) {
      // Whorl of needle branches halfway up.
      for (let w = 0; w < 2; w++) m.leaf(x * 1.15, top * 0.5, z * 1.15, a + w * 3.1, 0.5, h * 0.25, 0.01, pal.leaf, pal.leafTip);
    } else {
      m.globe(x * 1.3, top + 0.02, z * 1.3, 0.012, [0.55, 0.47, 0.3], 2.2);
    }
  }
}

function bracket(m: Mesher, pal: Palette, r: () => number, h: number, flush: boolean) {
  // Shelves stacked up a log face, opening outward along +X (instance rotation aims them).
  const shelves = 3;
  const c = flush ? pal.flower : pal.leaf;
  for (let s = 0; s < shelves; s++) {
    const y = s * h * 0.5, rad = h * (1 - s * 0.2) * (0.8 + r() * 0.3);
    const centre = m.v(0, y, 0, shade(c, 0.85));
    const ring: number[] = [];
    for (let k = 0; k <= 5; k++) {
      const a = -Math.PI / 2 + (k / 5) * Math.PI;
      ring.push(m.v(Math.cos(a) * rad, y - 0.01, Math.sin(a) * rad, mixRgb(c, [0.95, 0.9, 0.75], 0.25)));
    }
    for (let k = 0; k < 5; k++) m.tri(centre, ring[k + 1], ring[k]);
  }
}

// --------------------------------------------------------------- entry

/**
 * Geometry for a herbaceous plant (anything that isn't a tree or shrub) in a
 * given visual state, at full size (growth = 1). Sizes are metres.
 */
export function herbGeometry(p: Plant, visual: Visual): Geometry {
  const m = new Mesher();
  const r = rng(hashString(p.latin + visual));
  const pal = palette(p, visual);
  const h = p.height;
  const showFlowers = visual === "flowering";
  const headColor: RGB | null = showFlowers ? pal.flower : visual === "fruiting" || visual === "standing" ? shade(pal.dormant, 0.7) : null;

  // Every form's winter-rosette / first-year look.
  if (visual === "basal" && p.form !== "grass" && p.form !== "sedge") {
    const radius = p.form === "tallForb" ? Math.min(0.42, 0.18 + h * 0.12) : Math.max(0.08, Math.min(0.3, h * 0.6));
    rosette(m, pal, r, radius, p.form === "tallForb" ? 11 : 9);
    return m.g;
  }

  switch (p.form) {
    case "rosette": {
      rosette(m, pal, r, Math.max(0.1, Math.min(0.32, h * 0.7)), 10);
      if (headColor) scapes(m, p, pal, r, p.latin === "Alliaria petiolata" ? 2 : 4, h, Math.max(0.025, h * 0.12), headColor);
      break;
    }
    case "mat": {
      const n = 12, spread = Math.max(0.3, h * 2.6);
      for (let k = 0; k < n; k++) {
        const a = r() * Math.PI * 2, d = Math.sqrt(r()) * spread;
        m.leaf(Math.cos(a) * d * 0.5, r() * h * 0.6, Math.sin(a) * d * 0.5, a, 0.15 + r() * 0.5, spread * 0.32, spread * 0.2, pal.leaf, pal.leafTip);
      }
      if (headColor) {
        // Winter annuals bloom in carpets; give them a lot of colour.
        const flowers = p.cycle === "winterAnnual" ? 12 : 7;
        for (let k = 0; k < flowers; k++) {
          const a = r() * Math.PI * 2, d = Math.sqrt(r()) * spread * 0.55;
          m.blossom(Math.cos(a) * d, h * (0.85 + r() * 0.4), Math.sin(a) * d, Math.max(0.02, h * 0.16), headColor, r() * 3);
        }
      }
      break;
    }
    case "forb":
    case "tallForb": {
      const stems = p.form === "tallForb" ? 3 : 2;
      const dead = visual === "standing";
      leafyStems(m, p, pal, r, stems, h, dead ? 0 : 3, headColor, !dead);
      if (!dead && visual !== "senescent") rosette(m, pal, r, Math.min(0.2, h * 0.18), 4); // basal leaves
      break;
    }
    case "grass":
    case "sedge": {
      const sedge = p.form === "sedge";
      const dormant = visual === "dormantClump" || visual === "standing";
      const blades = sedge ? 12 : dormant ? 20 : 16;
      const w = sedge ? 0.012 : Math.max(0.012, h * (dormant ? 0.026 : 0.018));
      grassClump(m, p, pal, r, blades, h, w, dormant ? 0.45 : sedge ? 0.55 : 0.28, showFlowers || visual === "fruiting" ? headColor : null);
      break;
    }
    case "bulb": {
      for (let k = 0; k < 5; k++) m.blade(0, 0, r() * Math.PI * 2, 0.08, h * (0.6 + r() * 0.4), 0.008, pal.leaf, pal.leafTip);
      if (headColor) scapes(m, p, pal, r, 1, h * 1.1, 0.03, headColor);
      break;
    }
    case "vine":
      vineTangle(m, pal, r, visual, h);
      break;
    case "cane":
      canes(m, p, pal, r, visual, h);
      break;
    case "horsetail":
      horsetail(m, pal, r, visual, h);
      break;
    case "fungus":
      m.globe(0, h * 0.45, 0, h * 0.55, pal.leaf, 0.85);
      break;
    case "fungusBracket":
      bracket(m, pal, r, Math.max(0.06, h), visual === "flowering");
      break;
    default:
      rosette(m, pal, r, 0.15, 8);
  }
  return m.g;
}

/**
 * One far-field tuft: a few crossed blades in white, tinted per instance with
 * the colour of whatever dominates that spot. Height 1 m (scaled per instance).
 */
export function tuftGeometry(): Geometry {
  const m = new Mesher();
  const r = rng(7);
  for (let k = 0; k < 2; k++) {
    const yaw = (k / 2) * Math.PI + 0.4 + r() * 0.3;
    m.blade(0, 0, yaw, 0.25, 1, 0.7, [0.8, 0.8, 0.8], [1, 1, 1]);
  }
  return m.g;
}
