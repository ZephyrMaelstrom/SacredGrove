/**
 * Draws the garden: each planting with the same procedural plant meshes as
 * the wild ones (sized by how far it has grown, picked-over plants smaller,
 * flowers gone once taken), a label stake where seed is in but nothing is up
 * yet, weeds coming up between, and bed soil that darkens when watered.
 */
import { Color3, Mesh, MeshBuilder, StandardMaterial, VertexData, type Scene } from "@babylonjs/core";
import { plantByLatin, PLANT_INDEX, type Plant } from "../data/plants";
import type { Visual } from "../sim/phenology";
import type { SeasonAdjust } from "../time/season";
import { absDay } from "../time/clock";
import { SITE, heightAt } from "../world/map";
import type { GameStateData } from "../game/state";
import { SLOTS, SLOTS_PER_BED, plantingLook } from "../game/garden";
import { herbGeometry, type Geometry } from "./geometry";
import { WindPlugin } from "./wind";

interface Proto { mesh: Mesh; mats: number[] }

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
  mesh.alwaysSelectAsActiveMesh = true;
  return mesh;
}

const matrix = (s: number, sy: number, rot: number, x: number, y: number, z: number) => {
  const c = Math.cos(rot), sn = Math.sin(rot);
  return [s * c, 0, -s * sn, 0, 0, sy, 0, 0, s * sn, 0, s * c, 0, x, y, z, 1];
};

export class GardenRenderer {
  private material: StandardMaterial;
  private protos = new Map<string, Proto>();
  private stake: Mesh;
  private wet: Mesh[] = [];
  private weedPlant: Plant;

  constructor(private scene: Scene) {
    this.material = new StandardMaterial("gardenPlantMat", scene);
    this.material.diffuseColor = Color3.White();
    this.material.specularColor = Color3.Black();
    this.material.backFaceCulling = false;
    new WindPlugin(this.material);
    this.weedPlant = plantByLatin(PLANT_INDEX.has("Stellaria media") ? "Stellaria media" : "Lamium amplexicaule");

    const stakeMat = new StandardMaterial("stakeMat", scene);
    stakeMat.diffuseColor = new Color3(0.85, 0.8, 0.66);
    this.stake = MeshBuilder.CreateBox("gardenStake", { width: 0.05, height: 0.22, depth: 0.012 }, scene);
    this.stake.material = stakeMat;
    this.stake.isPickable = false;

    // A dark film over each bed's soil: more opaque when the soil is wet.
    for (const [i, [bx, bz]] of SITE.raisedBeds.entries()) {
      const m = MeshBuilder.CreateGround(`bedWet_${i}`, { width: 1.04, height: 3.84 }, scene);
      m.position.set(bx, heightAt(bx, bz) + 0.362, bz);
      const mat = new StandardMaterial(`bedWetMat_${i}`, scene);
      mat.diffuseColor = new Color3(0.1, 0.07, 0.05);
      mat.specularColor = new Color3(0.08, 0.08, 0.08);
      mat.alpha = 0;
      m.material = mat;
      m.isPickable = false;
      this.wet.push(m);
    }
  }

  private proto(p: Plant, visual: Visual): Proto {
    const key = `${p.latin}|${visual}`;
    let pr = this.protos.get(key);
    if (!pr) {
      pr = { mesh: toMesh(this.scene, `garden_${key}`, herbGeometry(p, visual), this.material), mats: [] };
      this.protos.set(key, pr);
    }
    return pr;
  }

  update(s: GameStateData, season: SeasonAdjust) {
    for (const pr of this.protos.values()) pr.mats = [];
    const stakes: number[] = [];
    const { doy, year } = s.clock;
    const day = absDay(s.clock);

    for (const spot of SLOTS) {
      const pl = s.garden.slots[spot.index];
      if (!pl) continue;
      const p = plantByLatin(pl.latin);
      const rot = (spot.index * 2.399) % (Math.PI * 2);
      if (pl.upDay === null || pl.dead === "never came up") {
        stakes.push(...matrix(1, 1, 0, spot.x + 0.12, spot.y + 0.11, spot.z - 0.18));
        continue;
      }
      const look = plantingLook(pl, p, doy, year, season, day);
      if (!look?.visual) {
        stakes.push(...matrix(1, 1, 0, spot.x + 0.12, spot.y + 0.11, spot.z - 0.18));
        continue;
      }
      let visual = look.visual;
      let shrink = 1;
      if (pl.pickedUntil !== undefined && day < pl.pickedUntil) shrink = 0.7;
      if ((shrink < 1 || pl.strippedYear === year) && (visual === "flowering" || visual === "fruiting")) visual = "vegetative";
      // Well-fed garden plants run a little larger than wild ones.
      const sc = look.growth * shrink * 1.25;
      // A sown spot comes up as a little stand of plants; a division as a clump of stems.
      const n = pl.from === "seed" ? Math.min(5, 2 + Math.floor(pl.seeds / 4)) : 3;
      const proto = this.proto(p, visual);
      for (let k = 0; k < n; k++) {
        const a = rot + (k * Math.PI * 2) / n, r = k === 0 ? 0 : 0.1 + 0.03 * (k % 2);
        const ks = k === 0 ? 1 : 0.8 + 0.1 * ((spot.index + k) % 3);
        proto.mats.push(...matrix(sc * ks, sc * ks, rot + k * 1.7, spot.x + Math.cos(a) * r, spot.y, spot.z + Math.sin(a) * r));
      }
    }

    // Weeds: a few more each week until you pull them.
    for (let b = 0; b < s.garden.beds.length; b++) {
      const bed = s.garden.beds[b];
      const n = Math.round(bed.weeds * 14);
      const [bx, bz] = SITE.raisedBeds[b];
      const top = heightAt(bx, bz) + 0.36;
      for (let k = 0; k < n; k++) {
        const h = (b * 97 + k * 61) % 101 / 101, v = (b * 53 + k * 89) % 103 / 103;
        const sc = 0.35 + 0.45 * (((k * 37) % 10) / 10) * bed.weeds;
        this.proto(this.weedPlant, "vegetative").mats.push(...matrix(sc, sc, k, bx - 0.48 + h * 0.96, top, bz - 1.85 + v * 3.7));
      }
      const wet = this.wet[b].material as StandardMaterial;
      wet.alpha = Math.max(0, Math.min(0.45, (bed.moisture - 0.25) * 0.65));
    }
    void SLOTS_PER_BED;

    for (const pr of this.protos.values()) {
      pr.mesh.setEnabled(pr.mats.length > 0);
      if (pr.mats.length) pr.mesh.thinInstanceSetBuffer("matrix", new Float32Array(pr.mats), 16, false);
    }
    this.stake.setEnabled(stakes.length > 0);
    if (stakes.length) this.stake.thinInstanceSetBuffer("matrix", new Float32Array(stakes), 16, false);
  }
}
