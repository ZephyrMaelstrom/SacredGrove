/**
 * Herbaceous vegetation renderer (M3).
 *
 *   Near field (0 – radius): every simulated plant, each (plant, visual)
 *     prototype drawn once with a thin-instance buffer. Buffers are refilled
 *     as the player walks (every few metres) from an 8 m bucket index, so only
 *     the few thousand plants around you are ever on the GPU. Plants shrink
 *     to nothing over the last 6 m so nothing pops.
 *
 *   Far field (radius – farRadius): one tuft per habitat node, tinted with the
 *     colour of whatever dominates that spot on today's date: rusty bluestem
 *     on the remnant, gray goldenrod stalks in the old field, a green lawn.
 *     A single draw call.
 *
 * Mowed ground: anything in a weekly-mowed node is cut to lawn height.
 */
import { Color3, Material, Mesh, Scene, StandardMaterial, VertexData, type Vector3 } from "@babylonjs/core";
import { PLANTS } from "../data/plants";
import { appearance, type Appearance, type Visual } from "../sim/phenology";
import { NEUTRAL_SEASON, type SeasonAdjust } from "../time/season";
import type { InstanceSet, Population } from "../sim/placement";
import { NONE } from "../sim/placement";
import { MOW, type HabitatLayers } from "../sim/habitat";
import { GRID, nodeX, nodeZ } from "../sim/grid";
import { heightAt, SITE } from "../world/map";
import { herbGeometry, hexToRgb, mixRgb, tuftGeometry, type Geometry, type RGB } from "./geometry";
import { WindPlugin } from "./wind";

const VISUALS: Visual[] = ["basal", "vegetative", "flowering", "fruiting", "senescent", "standing", "dormantClump", "bare"];
const VIS_INDEX = new Map(VISUALS.map((v, i) => [v, i]));
const BUCKET = 8;
const LAWN_HEIGHT = 0.09;
const FADE = 6;

export interface HerbQuality {
  radius: number;
  farRadius: number;
  rebuildDistance: number;
}
export const QUALITY: Record<string, HerbQuality> = {
  low: { radius: 26, farRadius: 90, rebuildDistance: 3 },
  medium: { radius: 30, farRadius: 120, rebuildDistance: 3 },
  high: { radius: 45, farRadius: 150, rebuildDistance: 4 },
};

interface Proto {
  mesh: Mesh;
  buffer: Float32Array;
  capacity: number;
  count: number;
}

function toMesh(scene: Scene, name: string, g: Geometry, mat: StandardMaterial): Mesh {
  const mesh = new Mesh(name, scene);
  const vd = new VertexData();
  vd.positions = g.positions;
  vd.normals = g.normals;
  vd.colors = g.colors;
  vd.indices = g.indices;
  vd.applyToMesh(mesh, false);
  mesh.material = mat;
  mesh.isPickable = false;
  mesh.alwaysSelectAsActiveMesh = true; // buffers only ever hold plants near the player
  mesh.doNotSyncBoundingInfo = true;
  return mesh;
}

/** The colour a plant gives a stretch of ground from a distance on a given day. */
export function fieldColor(p: (typeof PLANTS)[number], a: Appearance): RGB | null {
  if (!a.visual) return null;
  const leaf = hexToRgb(p.colors.leaf), flower = hexToRgb(p.colors.flower), dormant = hexToRgb(p.colors.dormant);
  switch (a.visual) {
    case "flowering": return mixRgb(leaf, flower, p.form === "mat" ? 0.55 : 0.3);
    case "fruiting": return mixRgb(leaf, dormant, 0.35);
    case "senescent": return mixRgb(leaf, dormant, 0.7);
    case "standing":
    case "dormantClump":
    case "bare": return dormant;
    case "basal": return mixRgb(leaf, dormant, 0.3);
    default: return leaf;
  }
}

export class HerbRenderer {
  private herbs: InstanceSet;
  private buckets = new Map<number, number[]>();
  /** Height multiplier per instance (lawn mowing). */
  private cut: Float32Array;
  private look: Appearance[][] = []; // [plant][cohort]
  private protos = new Map<number, Proto>();
  private material: StandardMaterial;
  private tuft: Mesh;
  private tuftMatrices: Float32Array;
  private tuftColors: Float32Array;
  private tuftColorByPlant: (RGB | null)[] = [];
  private tuftHeightByPlant: number[] = [];
  private dominant: Uint16Array;
  private lastCentre: { x: number; z: number } | null = null;
  private lastFarCentre: { x: number; z: number } | null = null;
  private doy = -1;
  visibleCount = 0;

  constructor(
    private scene: Scene,
    population: Population,
    private habitat: HabitatLayers,
    private quality: HerbQuality = QUALITY.medium,
  ) {
    this.herbs = population.herbs;
    this.dominant = population.dominant;

    const h = this.herbs;
    this.cut = new Float32Array(h.count);
    for (let k = 0; k < h.count; k++) {
      const key = this.bucketKey(Math.floor(h.x[k] / BUCKET), Math.floor(h.z[k] / BUCKET));
      let list = this.buckets.get(key);
      if (!list) this.buckets.set(key, (list = []));
      list.push(k);
      const p = PLANTS[h.plant[k]];
      this.cut[k] = habitat.mow[h.node[k]] === MOW.weekly ? Math.min(1, LAWN_HEIGHT / p.height) : 1;
    }

    this.material = new StandardMaterial("herbMat", scene);
    this.material.diffuseColor = Color3.White();
    this.material.specularColor = Color3.Black();
    // Both faces drawn, but no normal flipping: plant normals are authored to
    // lean upward, so leaves light softly from either side.
    this.material.backFaceCulling = false;
    new WindPlugin(this.material);

    // Far field: one tuft per node, tinted per instance.
    const tuftMat = new StandardMaterial("tuftMat", scene);
    tuftMat.diffuseColor = Color3.White();
    tuftMat.specularColor = Color3.Black();
    tuftMat.backFaceCulling = false;
    new WindPlugin(tuftMat);
    this.tuft = toMesh(scene, "farTufts", tuftGeometry(), tuftMat);
    const maxTufts = GRID.nx * GRID.nz * 2;
    this.tuftMatrices = new Float32Array(maxTufts * 16);
    this.tuftColors = new Float32Array(maxTufts * 4);
    this.tuft.thinInstanceSetBuffer("matrix", this.tuftMatrices, 16, false);
    this.tuft.thinInstanceSetBuffer("color", this.tuftColors, 4, false);
    this.tuft.thinInstanceCount = 0;
  }

  private bucketKey(bx: number, bz: number) {
    return (bx + 512) * 4096 + (bz + 512);
  }

  /**
   * Per-individual overrides from the player's harvesting (hidden when cut or
   * dug, smaller when picked over, flowers gone when stripped). Set by the
   * game session; null when nothing has been harvested.
   */
  visibility: ((index: number) => { hidden: boolean; reduced: boolean; bare: boolean }) | null = null;

  private season: SeasonAdjust = NEUTRAL_SEASON;

  /** Recompute every plant's look for the date (and this year's season) and force a refill. */
  setDay(doy: number, season: SeasonAdjust = this.season) {
    if (doy === this.doy && season === this.season) return;
    this.doy = doy;
    this.season = season;
    this.look = PLANTS.map((p) => [appearance(p, doy, 0, season), appearance(p, doy, 1, season)]);
    this.tuftColorByPlant = PLANTS.map((p, i) => fieldColor(p, this.look[i][1]));
    this.tuftHeightByPlant = PLANTS.map((p, i) => {
      const a = this.look[i][1];
      if (!a.visual) return 0;
      const base = a.visual === "basal" ? 0.12 : p.height * a.growth;
      return Math.min(1.3, Math.max(0.08, base));
    });
    this.lastCentre = null;
    this.lastFarCentre = null;
  }

  get day() {
    return this.doy;
  }

  private proto(plant: number, visual: Visual): Proto {
    const key = plant * VISUALS.length + VIS_INDEX.get(visual)!;
    let p = this.protos.get(key);
    if (!p) {
      const mesh = toMesh(this.scene, `herb_${PLANTS[plant].latin}_${visual}`, herbGeometry(PLANTS[plant], visual), this.material);
      p = { mesh, buffer: new Float32Array(16 * 64), capacity: 64, count: 0 };
      mesh.thinInstanceSetBuffer("matrix", p.buffer, 16, false);
      mesh.thinInstanceCount = 0;
      this.protos.set(key, p);
    }
    return p;
  }

  private enabled = true;
  private snow = 0;

  /** Snow cover 0–1: whitens the sward and buries low plants. */
  setSnow(cover: number) {
    if (Math.abs(cover - this.snow) < 0.01) return;
    this.snow = cover;
    this.lastCentre = null;
    this.lastFarCentre = null;
  }

  /** Hide or show all herbaceous vegetation (debug / performance comparison). */
  setEnabled(on: boolean) {
    this.enabled = on;
    for (const p of this.protos.values()) p.mesh.setEnabled(false);
    this.tuft.setEnabled(on);
    this.lastCentre = null;
    this.lastFarCentre = null;
  }

  /** Call every frame; refills buffers only after the player moves a few metres. */
  update(cam: Vector3) {
    if (!this.enabled) return;
    const moved = !this.lastCentre || Math.hypot(cam.x - this.lastCentre.x, cam.z - this.lastCentre.z) > this.quality.rebuildDistance;
    if (moved) this.rebuildNear(cam.x, cam.z);
    const movedFar = !this.lastFarCentre || Math.hypot(cam.x - this.lastFarCentre.x, cam.z - this.lastFarCentre.z) > 4;
    if (movedFar) this.rebuildFar(cam.x, cam.z);
  }

  private rebuildNear(cx: number, cz: number) {
    this.lastCentre = { x: cx, z: cz };
    for (const p of this.protos.values()) p.count = 0;
    const R = this.quality.radius;
    const h = this.herbs;
    const b0x = Math.floor((cx - R) / BUCKET), b1x = Math.floor((cx + R) / BUCKET);
    const b0z = Math.floor((cz - R) / BUCKET), b1z = Math.floor((cz + R) / BUCKET);
    const vis = this.visibility;
    let visible = 0;
    for (let bx = b0x; bx <= b1x; bx++) for (let bz = b0z; bz <= b1z; bz++) {
      const list = this.buckets.get(this.bucketKey(bx, bz));
      if (!list) continue;
      for (const k of list) {
        const dx = h.x[k] - cx, dz = h.z[k] - cz;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d > R) continue;
        const pi = h.plant[k];
        const a = this.look[pi][h.cohort[k]];
        if (!a.visual) continue;
        let visual = a.visual, shrink = 1;
        if (vis) {
          const v = vis(k);
          if (v.hidden) continue;
          if (v.reduced) shrink = 0.68;
          if ((v.reduced || v.bare) && (visual === "flowering" || visual === "fruiting")) visual = "vegetative";
        }
        // Deep snow buries anything short.
        if (this.snow > 0.5 && PLANTS[pi].height * a.growth < 0.25 * this.snow) continue;
        const fade = d > R - FADE ? (R - d) / FADE : 1;
        const s = h.scale[k] * a.growth * fade * shrink;
        if (s < 0.02) continue;
        const sy = s * this.cut[k];
        const proto = this.proto(pi, visual);
        if (proto.count === proto.capacity) this.growProto(proto);
        const o = proto.count++ * 16, m = proto.buffer;
        const c = Math.cos(h.rotY[k]), sn = Math.sin(h.rotY[k]);
        m[o] = s * c; m[o + 1] = 0; m[o + 2] = -s * sn; m[o + 3] = 0;
        m[o + 4] = 0; m[o + 5] = sy; m[o + 6] = 0; m[o + 7] = 0;
        m[o + 8] = s * sn; m[o + 9] = 0; m[o + 10] = s * c; m[o + 11] = 0;
        m[o + 12] = h.x[k]; m[o + 13] = h.y[k]; m[o + 14] = h.z[k]; m[o + 15] = 1;
        visible++;
      }
    }
    for (const p of this.protos.values()) {
      if (p.count === 0) {
        p.mesh.setEnabled(false);
        continue;
      }
      p.mesh.setEnabled(true);
      p.mesh.thinInstanceBufferUpdated("matrix");
      p.mesh.thinInstanceCount = p.count;
    }
    this.visibleCount = visible;
  }

  private growProto(p: Proto) {
    const next = new Float32Array(p.capacity * 2 * 16);
    next.set(p.buffer);
    p.buffer = next;
    p.capacity *= 2;
    p.mesh.thinInstanceSetBuffer("matrix", p.buffer, 16, false);
  }

  /**
   * The sward: low tufts of the dominant cover on every node, near and far.
   * Near the player it is the matted thatch / turf between individual plants;
   * beyond the near radius it stands in for the plants themselves.
   */
  private rebuildFar(cx: number, cz: number) {
    this.lastFarCentre = { x: cx, z: cz };
    const R = this.quality.radius, outer = this.quality.farRadius;
    const m = this.tuftMatrices, col = this.tuftColors;
    const cap = m.length / 16;
    let n = 0;
    const put = (px: number, pz: number, w: number, hgt: number, rot: number, c: RGB) => {
      if (n >= cap) return;
      const o = n * 16;
      const cr = Math.cos(rot), sr = Math.sin(rot);
      m[o] = w * cr; m[o + 1] = 0; m[o + 2] = -w * sr; m[o + 3] = 0;
      m[o + 4] = 0; m[o + 5] = hgt; m[o + 6] = 0; m[o + 7] = 0;
      m[o + 8] = w * sr; m[o + 9] = 0; m[o + 10] = w * cr; m[o + 11] = 0;
      m[o + 12] = px; m[o + 13] = heightAt(px, pz) - 0.02; m[o + 14] = pz; m[o + 15] = 1;
      col[n * 4] = c[0]; col[n * 4 + 1] = c[1]; col[n * 4 + 2] = c[2]; col[n * 4 + 3] = 1;
      n++;
    };
    for (let j = 0; j < GRID.nz; j++) {
      const z = nodeZ(j);
      if (z > SITE.treeline.z0 + 4) break;
      if (Math.abs(z - cz) > outer) continue;
      for (let i = 0; i < GRID.nx; i++) {
        const node = j * GRID.nx + i;
        const dom = this.dominant[node];
        if (dom === NONE) continue;
        const x = nodeX(i);
        const d = Math.hypot(x - cx, z - cz);
        if (d > outer) continue;
        let c = this.tuftColorByPlant[dom];
        if (!c) continue;
        if (this.snow > 0) c = mixRgb(c, [0.93, 0.95, 0.98], Math.min(0.85, this.snow));
        const mow = this.habitat.mow[node];
        const disturbed = this.habitat.disturbance[node];
        if (disturbed > 0.85) continue; // gravel, mud, foundations stay bare
        const fadeOut = Math.min(1, (outer - d) / 15);
        // Sward height: turf when mowed, matted thatch when not; out past the
        // near field it rises to the dominant plant's height.
        const thatch = mow === MOW.weekly ? LAWN_HEIGHT : mow === MOW.periodic ? 0.2 : 0.34;
        const blend = Math.min(1, Math.max(0, (d - (R - FADE)) / FADE));
        const tall = Math.max(thatch, mow === MOW.weekly ? LAWN_HEIGHT : this.tuftHeightByPlant[dom]);
        const hgt = (thatch + (tall - thatch) * blend) * fadeOut;
        if (hgt < 0.03) continue;
        const seed = node * 2.399;
        const jx = ((node * 7919) % 100) / 100 - 0.5, jz = ((node * 104729) % 100) / 100 - 0.5;
        if (d < R) {
          // Near: three small tufts per node for a continuous mat.
          for (let t = 0; t < 3; t++) {
            const ox = ((node * (31 + t * 17)) % 100) / 100 - 0.5, oz = ((node * (57 + t * 29)) % 100) / 100 - 0.5;
            put(x + ox * 1.8, z + oz * 1.8, mow === MOW.weekly ? 0.55 : 0.8, hgt * (0.8 + 0.4 * ((node + t) % 3) / 2), seed + t, c);
          }
        } else if (d < 70 || (i + j) % 2 === 0) {
          put(x + jx, z + jz, d < 70 ? 1.1 : 1.5, hgt, seed, c);
        }
      }
    }
    this.tuft.thinInstanceBufferUpdated("matrix");
    this.tuft.thinInstanceBufferUpdated("color");
    const wasEmpty = this.tuft.thinInstanceCount === 0;
    this.tuft.thinInstanceCount = n;
    // Babylon only switches on per-instance colour if instances exist when the
    // shader is compiled; recompile once the first tufts are in.
    if (wasEmpty && n > 0) this.tuft.material?.markAsDirty(Material.AttributesDirtyFlag);
  }

  /** Nearest visible plant to a ground point, for the look-at readout. */
  nearest(x: number, z: number, maxDist = 0.6): { index: number; distance: number } | null {
    const h = this.herbs;
    let best = -1, bestD = maxDist;
    const bx = Math.floor(x / BUCKET), bz = Math.floor(z / BUCKET);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const k of this.buckets.get(this.bucketKey(bx + dx, bz + dz)) ?? []) {
        if (!this.look[h.plant[k]][h.cohort[k]].visual) continue;
        if (this.visibility?.(k).hidden) continue;
        const d = Math.hypot(h.x[k] - x, h.z[k] - z);
        if (d < bestD) { bestD = d; best = k; }
      }
    }
    return best < 0 ? null : { index: best, distance: bestD };
  }

  plantIndexOf(index: number): number {
    return this.herbs.plant[index];
  }

  /** Placement record for one individual (position, scale, cohort, habitat node). */
  individual(index: number) {
    const h = this.herbs;
    return { x: h.x[index], y: h.y[index], z: h.z[index], scale: h.scale[index], cohort: h.cohort[index], node: h.node[index], plant: h.plant[index] };
  }

  /** Force the near field to refill (after a harvest changes what's visible). */
  invalidate() {
    this.lastCentre = null;
  }

  /** Top of a plant above its base today (m), for VR reach checks. */
  heightOf(index: number): number {
    const a = this.appearanceOf(index);
    const p = PLANTS[this.herbs.plant[index]];
    return (a.visual === "basal" ? 0.12 : p.height * a.growth) * this.herbs.scale[index] * this.cut[index];
  }

  appearanceOf(index: number): Appearance {
    return this.look[this.herbs.plant[index]][this.herbs.cohort[index]];
  }

  /** Per-node colour of the dominant plant today, for tinting the ground. */
  groundTint(): Float32Array {
    const out = new Float32Array(GRID.nx * GRID.nz * 3).fill(-1);
    for (let n = 0; n < this.dominant.length; n++) {
      const d = this.dominant[n];
      if (d === NONE) continue;
      const c = this.tuftColorByPlant[d];
      if (!c) continue;
      out[n * 3] = c[0]; out[n * 3 + 1] = c[1]; out[n * 3 + 2] = c[2];
    }
    return out;
  }

  get prototypeCount() {
    let n = 0;
    for (const p of this.protos.values()) if (p.count > 0) n++;
    return n;
  }
}
