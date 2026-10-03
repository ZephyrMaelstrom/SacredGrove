/**
 * Trees and shrubs: the habitat-placed woody plants (fencerows, edge, old-field
 * invaders) plus the structural tree line and yard trees, all sharing one
 * prototype per species so the whole woody landscape changes season together.
 */
import { Color3, InstancedMesh, Mesh, Scene, ShadowGenerator, StandardMaterial } from "@babylonjs/core";
import { PLANTS, PLANT_INDEX, type Plant } from "../data/plants";
import { appearance } from "../sim/phenology";
import type { InstanceSet } from "../sim/placement";
import { hashString } from "../sim/random";
import { crownMesh, woodMesh } from "./treeMeshes";
import { hexToRgb, mixRgb, type RGB } from "./geometry";

/** Autumn colour by species (falls back to a leaf→dormant blend). */
const FALL: Record<string, string> = {
  "Sassafras albidum": "#d8642a",
  "Rhus glabra": "#b8261c",
  "Acer saccharum": "#e0782a",
  "Quercus alba": "#7a3428",
  "Carya ovata": "#c8a032",
  "Juglans nigra": "#c0b048",
  "Diospyros virginiana": "#c88a2a",
  "Prunus serotina": "#c8702a",
  "Crataegus mollis": "#b8502a",
  "Morus rubra": "#c8b040",
  "Lindera benzoin": "#e0c040",
  "Sambucus canadensis": "#a8a048",
  "Lonicera maackii": "#6a8a3a",
};

interface Proto {
  plant: Plant;
  wood: Mesh;
  crown: Mesh | null;
  crownMat: StandardMaterial;
}

interface Placed {
  plant: number;
  x: number;
  z: number;
  scale: number;
}

const rgb3 = (c: RGB) => new Color3(c[0], c[1], c[2]);
const PARK_Y = -1000; // prototypes live out of sight; instances are what you see

export class WoodyRenderer {
  private protos = new Map<number, Proto>();
  private placed: Placed[] = [];
  private bark = new Map<string, StandardMaterial>();

  constructor(private scene: Scene, private shadows?: ShadowGenerator) {}

  private material(name: string, c: RGB) {
    const m = new StandardMaterial(name, this.scene);
    m.diffuseColor = rgb3(c);
    m.specularColor = Color3.Black();
    return m;
  }

  private proto(pi: number): Proto {
    let p = this.protos.get(pi);
    if (p) return p;
    const plant = PLANTS[pi];
    const crown = plant.crown ?? "multistem";
    const seed = hashString(plant.latin);
    const barkKey = plant.colors.dormant;
    let bark = this.bark.get(barkKey);
    if (!bark) {
      bark = this.material(`bark_${barkKey}`, mixRgb(hexToRgb(plant.colors.dormant), [0.42, 0.4, 0.37], 0.35));
      this.bark.set(barkKey, bark);
    }
    const foliage = this.material(`foliage_${plant.latin}`, hexToRgb(plant.colors.leaf));
    const wood = woodMesh(this.scene, `wood_${plant.latin}`, crown, plant.height, seed, bark, foliage);
    wood.position.y = PARK_Y;
    wood.isVisible = false;
    wood.isPickable = false;
    const crownMat = this.material(`crown_${plant.latin}`, hexToRgb(plant.colors.leaf));
    crownMat.backFaceCulling = false;
    let crownProto: Mesh | null = null;
    if (crown !== "conifer") {
      crownProto = crownMesh(this.scene, `crown_${plant.latin}`, crown, plant.height, seed, crownMat);
      crownProto.position.y = PARK_Y;
      crownProto.isPickable = false;
    }
    p = { plant, wood, crown: crownProto, crownMat };
    this.protos.set(pi, p);
    return p;
  }

  /** Place one woody plant. `castShadow` for the few near the homestead. */
  add(pi: number, x: number, y: number, z: number, scale: number, rotY: number, castShadow = false): InstancedMesh {
    const p = this.proto(pi);
    const inst = p.wood.createInstance(`${p.plant.latin}_i`);
    inst.position.set(x, y - 0.05, z);
    inst.scaling.setAll(scale);
    inst.rotation.y = rotY;
    inst.isPickable = false;
    inst.freezeWorldMatrix();
    if (p.crown) {
      const c = p.crown.createInstance(`${p.plant.latin}_crown_i`);
      c.position.set(x, y - 0.05, z);
      c.scaling.setAll(scale);
      c.rotation.y = rotY;
      c.isPickable = false;
      c.freezeWorldMatrix();
    }
    if (castShadow) this.shadows?.addShadowCaster(inst, false);
    this.placed.push({ plant: pi, x, z, scale });
    return inst;
  }

  addByLatin(latin: string, x: number, y: number, z: number, scale: number, rotY: number, castShadow = false) {
    const i = PLANT_INDEX.get(latin);
    if (i === undefined) throw new Error(`No plant ${latin} in the database`);
    return this.add(i, x, y, z, scale, rotY, castShadow);
  }

  addPopulation(set: InstanceSet) {
    for (let k = 0; k < set.count; k++) {
      this.add(set.plant[k], set.x[k], set.y[k], set.z[k], set.scale[k], set.rotY[k]);
    }
  }

  /** Leaf-out, bloom, fall colour and bare winter crowns for every species. */
  setDay(doy: number) {
    for (const p of this.protos.values()) {
      if (!p.crown) continue;
      const a = appearance(p.plant, doy, 1);
      const leaf = hexToRgb(p.plant.colors.leaf);
      const flower = hexToRgb(p.plant.colors.flower);
      const m = p.crownMat;
      p.crown.setEnabled(true);
      if (a.stage === "flowering" && !a.leafy) {
        m.diffuseColor = rgb3(flower);
        m.alpha = 0.35; // blossom haze on bare twigs (spicebush, maple, cherry)
      } else if (a.leafy && a.stage === "senescent") {
        m.diffuseColor = rgb3(FALL[p.plant.latin] ? hexToRgb(FALL[p.plant.latin]) : mixRgb(leaf, hexToRgb(p.plant.colors.dormant), 0.5));
        m.alpha = 1;
      } else if (a.leafy) {
        const c = a.stage === "flowering" ? mixRgb(leaf, flower, 0.45) : a.stage === "emerging" ? mixRgb(leaf, [0.75, 0.85, 0.45], 0.4) : leaf;
        m.diffuseColor = rgb3(c);
        m.alpha = a.stage === "emerging" ? 0.6 : 1; // thin new leaves
      } else {
        // Bare: a faint twig haze so the canopy still reads at a distance.
        m.diffuseColor = rgb3(mixRgb(hexToRgb(p.plant.colors.dormant), [0.45, 0.4, 0.4], 0.5));
        m.alpha = 0.1;
      }
    }
  }

  /** Nearest woody plant to a ground point (for the look-at readout). */
  nearest(x: number, z: number, maxDist: number): { plant: Plant; distance: number } | null {
    let best: Placed | null = null, bestD = maxDist;
    for (const w of this.placed) {
      const d = Math.hypot(w.x - x, w.z - z) - 0.3 * w.scale * PLANTS[w.plant].height * 0.1;
      if (d < bestD) { bestD = d; best = w; }
    }
    return best ? { plant: PLANTS[best.plant], distance: bestD } : null;
  }

  get count() {
    return this.placed.length;
  }
}
