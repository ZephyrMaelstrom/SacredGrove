/**
 * What's stored shows up in the world: bundles hanging from the loft racks
 * (green when fresh, tan when dry, gray-white when moldy), jars on the
 * shelf, crates in the cellar, goods on the stand, a pot on the stove while
 * something simmers, and the loft vent door open or shut.
 *
 * Thin instances, rebuilt only when the save changes.
 */
import { Color3, Material, Mesh, MeshBuilder, StandardMaterial, TransformNode, Matrix, Quaternion, Vector3, type Scene, type ShadowGenerator } from "@babylonjs/core";
import { layout } from "./layout";
import type { GameStateData } from "../game/state";
import { isPrep, type Item } from "../game/items";

type RGB = [number, number, number];
const lerp = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function itemColor(i: Item): RGB {
  if (isPrep(i)) return i.spoiled ? [0.5, 0.5, 0.4] : i.flavor.astringent > 0.4 || (i.effects.dye ?? 0) > 0.3 ? [0.45, 0.12, 0.1] : [0.62, 0.38, 0.14];
  if (i.kind === "stock") return i.form === "seed" ? [0.82, 0.74, 0.55] : [0.4, 0.3, 0.2];
  if (i.state === "moldy") return [0.78, 0.78, 0.74];
  if (i.state === "spoiled") return [0.28, 0.2, 0.13];
  const fresh: RGB = i.part === "Root" || i.part === "Rhizome" || i.part === "Tuber" || i.part === "Bark" ? [0.45, 0.32, 0.2]
    : i.part === "Flower" ? [0.7, 0.55, 0.35] : i.part === "Fruit" ? [0.45, 0.15, 0.25] : [0.25, 0.48, 0.18];
  const dried: RGB = lerp(fresh, [0.58, 0.52, 0.34], 0.6);
  const dry = i.state === "dried" ? 1 : Math.min(1, Math.max(0, 1 - (i.moisture - 0.12) / 0.6));
  return lerp(fresh, dried, dry);
}

class Instances {
  constructor(readonly mesh: Mesh) {
    mesh.isPickable = false;
  }
  set(items: { pos: Vector3; color: RGB; scale?: number; rotY?: number }[]) {
    const m = new Float32Array(Math.max(1, items.length) * 16);
    const c = new Float32Array(Math.max(1, items.length) * 4);
    items.forEach((it, k) => {
      const s = it.scale ?? 1;
      Matrix.Compose(new Vector3(s, s, s), Quaternion.FromEulerAngles(0, it.rotY ?? 0, 0), it.pos).copyToArray(m, k * 16);
      c.set([...it.color, 1], k * 4);
    });
    this.mesh.thinInstanceSetBuffer("matrix", m, 16, false);
    this.mesh.thinInstanceSetBuffer("color", c, 4, false);
    this.mesh.thinInstanceCount = items.length;
    this.mesh.isVisible = items.length > 0;
    this.mesh.material?.markAsDirty(Material.AttributesDirtyFlag);
  }
}

export class HomesteadProps {
  private bundles: Instances;
  private jars: Instances;
  private crates: Instances;
  private standGoods: Instances;
  private ventHinge: TransformNode;
  private pot: Mesh;
  private coldJar: Mesh;

  constructor(scene: Scene, shadows?: ShadowGenerator) {
    const A = layout().anchors;
    const mat = (name: string, c: Color3, alpha = 1) => {
      const m = new StandardMaterial(name, scene);
      m.diffuseColor = c;
      m.specularColor = new Color3(0.05, 0.05, 0.05);
      m.alpha = alpha;
      return m;
    };
    const white = mat("propMat", new Color3(1, 1, 1));

    const bundle = MeshBuilder.CreateCylinder("bundles", { diameterTop: 0.08, diameterBottom: 0.24, height: 0.5, tessellation: 6 }, scene);
    bundle.material = white;
    this.bundles = new Instances(bundle);
    const jar = MeshBuilder.CreateCylinder("jars", { diameter: 0.11, height: 0.17, tessellation: 8 }, scene);
    jar.material = white;
    this.jars = new Instances(jar);
    const crate = MeshBuilder.CreateBox("crates", { width: 0.42, height: 0.24, depth: 0.5 }, scene);
    crate.material = white;
    this.crates = new Instances(crate);
    const goods = MeshBuilder.CreateBox("standGoods", { width: 0.28, height: 0.16, depth: 0.22 }, scene);
    goods.material = white;
    this.standGoods = new Instances(goods);
    for (const m of [bundle, jar, crate, goods]) {
      m.receiveShadows = true;
      shadows?.addShadowCaster(m);
    }

    // Loft vent door, hinged on its west edge.
    this.ventHinge = new TransformNode("ventHinge", scene);
    this.ventHinge.position.set(A.vent.x - A.vent.width / 2, A.vent.y0, A.vent.z + 0.05);
    const door = MeshBuilder.CreateBox("ventDoor", { width: A.vent.width, height: A.vent.y1 - A.vent.y0, depth: 0.06 }, scene);
    door.material = mat("ventDoorMat", new Color3(0.32, 0.24, 0.17));
    door.parent = this.ventHinge;
    door.position.set(A.vent.width / 2, (A.vent.y1 - A.vent.y0) / 2, 0);
    door.isPickable = false;

    // A pot on the stove while a decoction simmers; a jar on the bench for cold infusions.
    this.pot = MeshBuilder.CreateCylinder("pot", { diameter: 0.28, height: 0.22, tessellation: 10 }, scene);
    this.pot.material = mat("potMat", new Color3(0.2, 0.2, 0.22));
    this.pot.position.set(A.stove.x, A.stove.y + 0.11, A.stove.z);
    this.coldJar = MeshBuilder.CreateCylinder("coldJar", { diameter: 0.14, height: 0.24, tessellation: 10 }, scene);
    this.coldJar.material = mat("coldJarMat", new Color3(0.55, 0.65, 0.45), 0.7);
    this.coldJar.position.set(A.mortar.x, A.mortar.y + 0.12, A.mortar.z + 1.6);
    for (const m of [this.pot, this.coldJar]) { m.isPickable = false; m.setEnabled(false); }

    // Mortar and pestle on the bench (where VR grinding happens).
    const mortar = MeshBuilder.CreateCylinder("mortar", { diameterTop: 0.2, diameterBottom: 0.14, height: 0.12, tessellation: 12 }, scene);
    mortar.material = mat("mortarMat", new Color3(0.6, 0.58, 0.54));
    mortar.position.set(A.mortar.x, A.mortar.y + 0.06, A.mortar.z);
    const pestle = MeshBuilder.CreateCylinder("pestle", { diameterTop: 0.03, diameterBottom: 0.05, height: 0.2, tessellation: 8 }, scene);
    pestle.material = mortar.material;
    pestle.position.set(A.mortar.x + 0.03, A.mortar.y + 0.17, A.mortar.z);
    pestle.rotation.z = 0.4;
    for (const m of [mortar, pestle]) m.isPickable = false;
  }

  update(s: GameStateData) {
    const A = layout().anchors;
    // Bundles: 6 racks × 4 hooks.
    const hooks: Vector3[] = [];
    for (const z of A.racks.z) for (const x of [3.3, 5.8, 8.6, 11.1]) hooks.push(new Vector3(x, A.racks.y - 0.28, z));
    this.bundles.set(s.storage.loft.slice(0, hooks.length).map((it, k) => ({
      pos: hooks[k], color: itemColor(it), scale: 0.7 + 0.6 * Math.min(1, (it as { grams?: number }).grams! / 600 || 0.5), rotY: k,
    })));

    // Jars: 4 boards × 8.
    const jarSlots: Vector3[] = [];
    for (const y of A.shelf.ys) for (let k = 0; k < 8; k++) jarSlots.push(new Vector3(A.shelf.x, y + 0.085, A.shelf.z0 + 0.3 + k * 0.57));
    this.jars.set(s.storage.shelf.slice(0, jarSlots.length).map((it, k) => ({ pos: jarSlots[k], color: itemColor(it) })));

    // Cellar crates: 3 shelves × 6.
    const crateSlots: Vector3[] = [];
    for (const y of A.cellarShelf.ys) for (let k = 0; k < 6; k++) crateSlots.push(new Vector3(A.cellarShelf.x, y + 0.12, A.cellarShelf.z0 + 0.6 + k * 1.12));
    this.crates.set(s.storage.cellar.slice(0, crateSlots.length).map((it, k) => ({ pos: crateSlots[k], color: itemColor(it) })));

    // Stand: 8 spots along the counter.
    const st = A.standShelf;
    this.standGoods.set(s.storage.stand.slice(0, 8).map((it, k) => ({
      pos: new Vector3(st.x0 + 0.2 + k * ((st.x1 - st.x0 - 0.4) / 7), st.y + 0.08, st.z - 0.2), color: itemColor(it),
    })));

    this.ventHinge.rotation.y = s.ventOpen ? -1.75 : 0;
    this.pot.setEnabled(s.jobs.some((j) => j.prep.method === "decoction"));
    this.coldJar.setEnabled(s.jobs.some((j) => j.prep.method !== "decoction"));
  }
}
