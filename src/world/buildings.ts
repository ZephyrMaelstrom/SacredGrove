import {
  Color3,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  TransformNode,
  VertexData,
  ShadowGenerator,
} from "@babylonjs/core";
import { SITE, heightAt } from "./map";

/**
 * Gray-box homestead (M1). Every building is simple primitives at true scale so
 * walking distances and sight lines can be judged in the headset before final
 * Blender models replace them in M6. Each top-level node is named so the
 * replacement can be dropped in at the same transform.
 */

const PALETTE = {
  houseWall: new Color3(0.86, 0.85, 0.8),
  trim: new Color3(0.93, 0.93, 0.9),
  roofShingle: new Color3(0.24, 0.25, 0.27),
  window: new Color3(0.12, 0.15, 0.18),
  barnWall: new Color3(0.5, 0.47, 0.43),
  barnRoof: new Color3(0.47, 0.31, 0.22),
  wood: new Color3(0.52, 0.4, 0.27),
  darkWood: new Color3(0.32, 0.24, 0.17),
  concrete: new Color3(0.62, 0.61, 0.58),
  tin: new Color3(0.6, 0.62, 0.63),
  soil: new Color3(0.27, 0.2, 0.14),
  manure: new Color3(0.25, 0.19, 0.12),
  sign: new Color3(0.13, 0.15, 0.13),
};

export class Builder {
  private mats = new Map<string, StandardMaterial>();
  constructor(public readonly scene: Scene, private shadows?: ShadowGenerator) {}

  mat(key: keyof typeof PALETTE): StandardMaterial {
    let m = this.mats.get(key);
    if (!m) {
      m = new StandardMaterial(`mat_${key}`, this.scene);
      m.diffuseColor = PALETTE[key];
      m.specularColor = new Color3(0.04, 0.04, 0.04);
      this.mats.set(key, m);
    }
    return m;
  }

  private finish(mesh: Mesh, parent: TransformNode, mat: keyof typeof PALETTE, cast = true) {
    mesh.parent = parent;
    mesh.material = this.mat(mat);
    mesh.receiveShadows = true;
    if (cast) this.shadows?.addShadowCaster(mesh);
    return mesh;
  }

  /** Box whose position is its bottom-centre, in the parent's space. */
  box(name: string, parent: TransformNode, mat: keyof typeof PALETTE, w: number, h: number, d: number, x: number, y: number, z: number, cast = true) {
    const m = MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, this.scene);
    m.position.set(x, y + h / 2, z);
    return this.finish(m, parent, mat, cast);
  }

  /** Triangular prism roof: ridge runs along local Z. Bottom-centre at (x, y, z). */
  gable(name: string, parent: TransformNode, mat: keyof typeof PALETTE, w: number, rise: number, d: number, x: number, y: number, z: number) {
    const hw = w / 2, hd = d / 2;
    const p = [
      -hw, 0, -hd, hw, 0, -hd, 0, rise, -hd, // front triangle
      -hw, 0, hd, hw, 0, hd, 0, rise, hd, // back triangle
    ];
    const idx = [0, 2, 1, 3, 4, 5, 0, 3, 5, 0, 5, 2, 1, 2, 5, 1, 5, 4, 0, 1, 4, 0, 4, 3];
    const vd = new VertexData();
    vd.positions = p;
    vd.indices = idx;
    const m = new Mesh(name, this.scene);
    vd.applyToMesh(m);
    m.convertToFlatShadedMesh();
    m.position.set(x, y, z);
    return this.finish(m, parent, mat);
  }

  cyl(name: string, parent: TransformNode, mat: keyof typeof PALETTE, dia: number, h: number, x: number, y: number, z: number, cast = true) {
    const m = MeshBuilder.CreateCylinder(name, { diameter: dia, height: h, tessellation: 8 }, this.scene);
    m.position.set(x, y + h / 2, z);
    return this.finish(m, parent, mat, cast);
  }

  /** A node seated on the terrain at (x, z). */
  site(name: string, x: number, z: number, rotY = 0): TransformNode {
    const n = new TransformNode(name, this.scene);
    n.position.set(x, heightAt(x, z), z);
    n.rotation.y = rotY;
    return n;
  }
}

// ------------------------------------------------------------------ farmhouse

function farmhouse(b: Builder) {
  const { x, z, w, d } = SITE.farmhouse;
  const root = b.site("farmhouse", x, z);
  // Foundation runs below grade so the house never floats on uneven ground.
  b.box("fh_foundation", root, "concrete", w + 0.3, 1.2, d + 0.3, 0, -0.8, 0);
  b.box("fh_body", root, "houseWall", w, 5.8, d, 0, 0.4, 0);
  b.gable("fh_roof", root, "roofShingle", d + 1.0, 2.8, w + 0.8, 0, 6.2, 0).rotation.y = Math.PI / 2;
  b.box("fh_chimney", root, "concrete", 0.8, 3.2, 0.8, 2.6, 6.0, 1.5);

  // Front (south) porch facing the road.
  b.box("fh_porch_deck", root, "wood", w, 0.25, 2.6, 0, 0.15, -d / 2 - 1.3);
  for (const px of [-w / 2 + 0.2, -1.5, 1.5, w / 2 - 0.2]) {
    b.box(`fh_porch_post_${px}`, root, "trim", 0.18, 2.6, 0.18, px, 0.4, -d / 2 - 2.45);
  }
  const porchRoof = b.box("fh_porch_roof", root, "roofShingle", w + 0.4, 0.12, 3.0, 0, 3.0, -d / 2 - 1.4);
  porchRoof.rotation.x = -0.18;
  b.box("fh_door", root, "darkWood", 1.0, 2.1, 0.08, 0, 0.4, -d / 2 - 0.04);
  b.box("fh_steps", root, "wood", 1.6, 0.15, 0.6, 0, 0, -d / 2 - 2.9, false);

  // Windows: two stories on the front, the player room is upstairs front-left.
  for (const [wx, wy] of [[-3, 1.4], [3, 1.4], [-3, 4.2], [3, 4.2], [0, 4.2]] as const) {
    b.box(`fh_win_f_${wx}_${wy}`, root, "window", 1.0, 1.4, 0.06, wx, wy, -d / 2 - 0.03, false);
  }
  for (const [wz, wy] of [[-2.2, 1.4], [2.2, 1.4], [-2.2, 4.2], [2.2, 4.2]] as const) {
    b.box(`fh_win_e_${wz}_${wy}`, root, "window", 0.06, 1.4, 1.0, w / 2 + 0.03, wy, wz, false);
    b.box(`fh_win_w_${wz}_${wy}`, root, "window", 0.06, 1.4, 1.0, -w / 2 - 0.03, wy, wz, false);
  }

  // Root cellar bulkhead on the east side: sloped double doors into the ground.
  const bulk = b.box("rootcellar_bulkhead", root, "darkWood", 1.6, 0.12, 2.0, w / 2 + 1.0, 0.45, -1.5);
  bulk.rotation.z = -0.35;
  b.box("rootcellar_curb", root, "concrete", 1.9, 0.35, 2.2, w / 2 + 1.0, -0.05, -1.5);
  return root;
}

// ----------------------------------------------------------------------- barn

function barn(b: Builder) {
  const { x, z, w, d } = SITE.barn;
  const root = b.site("barn", x, z);
  b.box("barn_foundation", root, "concrete", w + 0.2, 1.0, d + 0.2, 0, -0.6, 0);
  b.box("barn_body", root, "barnWall", w, 5.2, d, 0, 0.4, 0);
  // Gambrel read as a tall gable for the gray-box.
  b.gable("barn_roof", root, "barnRoof", w + 1.0, 5.0, d + 1.0, 0, 5.6, 0);
  // South gable end: big doors (apothecary entrance) and hayloft door.
  b.box("barn_door_main", root, "darkWood", 4.2, 3.6, 0.1, 0, 0.4, -d / 2 - 0.05);
  b.box("barn_hayloft_door", root, "darkWood", 2.0, 1.8, 0.1, 0, 6.2, -d / 2 - 0.05);
  b.box("barn_hay_hood", root, "barnRoof", 2.6, 0.15, 1.2, 0, 8.6, -d / 2 - 0.55);
  // Tack room lean-to on the west side.
  b.box("tackroom_body", root, "barnWall", 4, 3.0, 8, -w / 2 - 2, 0.4, -4);
  const shed = b.box("tackroom_roof", root, "barnRoof", 4.8, 0.12, 8.6, -w / 2 - 2.1, 3.5, -4);
  shed.rotation.z = 0.28;
  b.box("tackroom_door", root, "darkWood", 0.9, 2.0, 0.08, -w / 2 - 2, 0.4, -8.04);
  // Concrete apron where the drive meets the barn.
  b.box("barn_apron", root, "concrete", 8, 0.15, 5, 0, -0.05, -d / 2 - 2.5, false);
  return root;
}

// ------------------------------------------------------------- outdoor pieces

function postFence(b: Builder, name: string, pts: [number, number][], spacing: number, rails: number, gap?: [number, number]) {
  const root = new TransformNode(name, b.scene);
  const tall = rails > 0 ? 1.3 : 1.2;
  for (let s = 0; s < pts.length - 1; s++) {
    const [ax, az] = pts[s], [bx, bz] = pts[s + 1];
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.round(len / spacing));
    for (let i = 0; i <= n; i++) {
      if (s > 0 && i === 0) continue;
      const px = ax + ((bx - ax) * i) / n, pz = az + ((bz - az) * i) / n;
      if (gap && Math.hypot(px - gap[0], pz - gap[1]) < 2.0) continue;
      b.cyl(`${name}_post`, root, "darkWood", 0.14, tall, px, heightAt(px, pz) - 0.1, pz, false);
    }
    for (let r = 0; r < rails; r++) {
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      const rail = b.box(`${name}_rail`, root, "wood", 0.06, 0.12, len, mx, heightAt(mx, mz) + 0.45 + r * 0.4, mz, false);
      rail.rotation.y = Math.atan2(bx - ax, bz - az);
    }
  }
  return root;
}

function barnyard(b: Builder) {
  const { x0, x1, z0, z1 } = SITE.barnyard;
  const pts: [number, number][] = [[x0, z0], [x1, z0], [x1, z1], [x0, z1], [x0, z0]];
  postFence(b, "barnyard_fence", pts, 2.5, 3, [x0, (z0 + z1) / 2]);
  const root = b.site("manure_pile", x1 - 6, z1 - 6);
  const pile = MeshBuilder.CreateSphere("manure", { diameter: 4, segments: 6 }, b.scene);
  pile.scaling.y = 0.35;
  pile.parent = root;
  pile.material = b.mat("manure");
}

function gardenAndBeds(b: Builder) {
  const g = SITE.garden;
  postFence(b, "garden_fence", [[g.x0, g.z0], [g.x1, g.z0], [g.x1, g.z1], [g.x0, g.z1], [g.x0, g.z0]], 2, 2, [(g.x0 + g.x1) / 2, g.z0]);
  // Four raised beds in the side yard east of the house.
  for (let i = 0; i < 4; i++) {
    const bx = -30 + i * 2.4, bz = 74;
    const root = b.site(`raised_bed_${i + 1}`, bx, bz);
    b.box(`bed_frame_${i}`, root, "wood", 1.2, 0.35, 4, 0, 0, 0, false);
    b.box(`bed_soil_${i}`, root, "soil", 1.05, 0.36, 3.85, 0, 0, 0, false);
  }
}

function farmStand(b: Builder) {
  const { x, z } = SITE.farmStand;
  const root = b.site("farm_stand", x, z);
  b.box("stand_counter", root, "wood", 3.2, 0.95, 1.2, 0, 0, 0);
  b.box("stand_shelf", root, "wood", 3.2, 0.06, 0.5, 0, 1.4, 0.4, false);
  for (const [px, pz] of [[-1.5, -0.55], [1.5, -0.55], [-1.5, 0.55], [1.5, 0.55]] as const) {
    b.box(`stand_post`, root, "darkWood", 0.1, pz < 0 ? 2.3 : 2.0, 0.1, px, 0, pz);
  }
  const roof = b.box("stand_roof", root, "tin", 3.8, 0.04, 1.9, 0, 2.2, 0);
  roof.rotation.x = 0.16;
  const sign = b.box("stand_sign", root, "sign", 1.2, 0.8, 0.05, 2.3, 0.3, -0.4);
  sign.rotation.y = -0.4;
  b.box("stand_cashbox", root, "tin", 0.3, 0.2, 0.2, 1.2, 0.95, -0.2, false);
  return root;
}

function roadside(b: Builder) {
  // Mailbox at the drive, utility poles along the road.
  const mb = b.site("mailbox", -23, 9.5);
  b.box("mailbox_post", mb, "darkWood", 0.1, 1.05, 0.1, 0, 0, 0, false);
  b.box("mailbox_box", mb, "tin", 0.25, 0.25, 0.5, 0, 1.05, 0, false);
  for (const px of [-70, -30, 10, 50]) {
    const pole = b.site(`utility_pole_${px}`, px, 10.5);
    b.cyl("pole", pole, "darkWood", 0.28, 9, 0, -0.5, 0);
    b.box("crossarm", pole, "darkWood", 2.2, 0.12, 0.12, 0, 7.9, 0, false);
  }
}

export function createHomestead(scene: Scene, shadows?: ShadowGenerator): Builder {
  const b = new Builder(scene, shadows);
  farmhouse(b);
  barn(b);
  barnyard(b);
  gardenAndBeds(b);
  farmStand(b);
  roadside(b);
  return b;
}

export { postFence };
