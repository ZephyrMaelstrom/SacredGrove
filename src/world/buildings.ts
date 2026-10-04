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
import { layout } from "./layout";

/**
 * The homestead. Walls, floors, stairs and furniture come from the shared
 * layout (layout.ts), so what you see is what you walk on and bump into;
 * this file adds roofs, doors, trim and the outdoor pieces. Still simple
 * primitives at true scale: final models can replace them at the same
 * transforms later.
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
  plank: new Color3(0.6, 0.47, 0.32),
  plaster: new Color3(0.9, 0.87, 0.8),
  stone: new Color3(0.5, 0.48, 0.44),
  glass: new Color3(0.62, 0.72, 0.78),
  paper: new Color3(0.9, 0.86, 0.72),
  iron: new Color3(0.16, 0.16, 0.17),
  quilt: new Color3(0.55, 0.22, 0.2),
  gravel: new Color3(0.55, 0.53, 0.49),
};

export class Builder {
  private mats = new Map<string, StandardMaterial>();
  /** Every mesh made, with whether it casts shadows — merged per material by mergeStatic(). */
  private made: { mesh: Mesh; cast: boolean }[] = [];
  constructor(public readonly scene: Scene, private shadows?: ShadowGenerator) {}

  /**
   * Gray-box geometry is hundreds of tiny meshes (every fence post is one).
   * Merge them per material so the homestead costs a handful of draw calls.
   * Call once, after everything static has been built.
   */
  mergeStatic() {
    const groups = new Map<string, Mesh[]>();
    for (const { mesh, cast } of this.made) {
      if (mesh.isDisposed()) continue;
      mesh.computeWorldMatrix(true);
      // Babylon can only merge meshes with identical vertex attributes.
      const kinds = mesh.getVerticesDataKinds().sort().join(",");
      const key = `${mesh.material?.name ?? "none"}|${kinds}|${cast}`;
      const list = groups.get(key) ?? [];
      list.push(mesh);
      groups.set(key, list);
    }
    for (const [key, meshes] of groups) {
      if (meshes.length < 2) continue;
      for (const m of meshes) this.shadows?.removeShadowCaster(m);
      const merged = Mesh.MergeMeshes(meshes, true, true);
      if (!merged) continue;
      merged.name = `static_${key.split("|")[0]}`;
      merged.receiveShadows = true;
      merged.isPickable = false;
      merged.freezeWorldMatrix();
      if (key.endsWith("true")) this.shadows?.addShadowCaster(merged);
    }
    this.made = [];
  }

  mat(key: keyof typeof PALETTE): StandardMaterial {
    let m = this.mats.get(key);
    if (!m) {
      m = new StandardMaterial(`mat_${key}`, this.scene);
      m.diffuseColor = PALETTE[key];
      m.specularColor = new Color3(0.04, 0.04, 0.04);
      if (key === "glass") {
        m.alpha = 0.22;
        m.specularColor = new Color3(0.5, 0.5, 0.5);
      }
      this.mats.set(key, m);
    }
    return m;
  }

  private finish(mesh: Mesh, parent: TransformNode, mat: keyof typeof PALETTE, cast = true) {
    mesh.parent = parent;
    mesh.material = this.mat(mat);
    mesh.receiveShadows = true;
    if (cast) this.shadows?.addShadowCaster(mesh);
    this.made.push({ mesh, cast });
    return mesh;
  }

  /** Box whose position is its bottom-centre, in the parent's space. */
  box(name: string, parent: TransformNode, mat: keyof typeof PALETTE, w: number, h: number, d: number, x: number, y: number, z: number, cast = true) {
    const m = MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, this.scene);
    m.position.set(x, y + h / 2, z);
    return this.finish(m, parent, mat, cast);
  }

  /** Triangular prism roof: ridge runs along local Z. Bottom-centre at (x, y, z). */
  gable(
    name: string, parent: TransformNode, mat: keyof typeof PALETTE, w: number, rise: number, d: number, x: number, y: number, z: number,
    opts: { openBottom?: boolean; inner?: keyof typeof PALETTE } = {},
  ) {
    const hw = w / 2, hd = d / 2;
    const p = [
      -hw, 0, -hd, hw, 0, -hd, 0, rise, -hd, // front triangle
      -hw, 0, hd, hw, 0, hd, 0, rise, hd, // back triangle
    ];
    const idx = [0, 2, 1, 3, 4, 5, 0, 3, 5, 0, 5, 2, 1, 2, 5, 1, 5, 4];
    if (!opts.openBottom) idx.push(0, 1, 4, 0, 4, 3);
    if (opts.inner) {
      // The same surfaces seen from inside (reversed winding), in an interior colour.
      const rev: number[] = [];
      for (let i = 0; i < idx.length; i += 3) rev.push(idx[i], idx[i + 2], idx[i + 1]);
      const vi = new VertexData();
      vi.positions = p.slice();
      vi.indices = rev;
      vi.uvs = new Array((p.length / 3) * 2).fill(0);
      const mi = new Mesh(`${name}_inner`, this.scene);
      vi.applyToMesh(mi);
      mi.convertToFlatShadedMesh();
      mi.position.set(x, y, z);
      this.finish(mi, parent, opts.inner, false);
    }
    const vd = new VertexData();
    vd.positions = p;
    vd.indices = idx;
    vd.uvs = new Array((p.length / 3) * 2).fill(0); // match boxes so they can merge
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

// ------------------------------------------------------------------ the layout

/** Every wall, floor, stair and piece of furniture from the shared layout (see layout.ts). */
function layoutBoxes(b: Builder) {
  const root = new TransformNode("homestead_layout", b.scene);
  for (const [i, x] of layout().boxes.entries()) {
    if (!x.mat) continue;
    b.box(`lb_${i}`, root, x.mat, x.x1 - x.x0, x.y1 - x.y0, x.z1 - x.z0, (x.x0 + x.x1) / 2, x.y0, (x.z0 + x.z1) / 2, !!x.cast && x.mat !== "glass");
  }
}

// ------------------------------------------------------------------ farmhouse

function farmhouse(b: Builder) {
  const { x, z, w, d } = SITE.farmhouse;
  const A = layout().anchors;
  const root = b.site("farmhouse", x, z);
  root.position.y = A.gH;
  b.gable("fh_roof", root, "roofShingle", d + 1.0, 2.8, w + 0.8, 0, 6.2, 0).rotation.y = Math.PI / 2;
  b.box("fh_chimney", root, "concrete", 0.8, 3.2, 0.8, 2.6, 6.0, 1.5);
  // Porch posts and roof.
  for (const px of [-w / 2 + 0.2, -1.5, 1.5, w / 2 - 0.2]) {
    b.box(`fh_porch_post_${px}`, root, "trim", 0.18, 2.6, 0.18, px, 0.4, -d / 2 - 2.45);
  }
  const porchRoof = b.box("fh_porch_roof", root, "roofShingle", w + 0.4, 0.12, 3.0, 0, 3.0, -d / 2 - 1.4);
  porchRoof.rotation.x = -0.18;
  // Front door, standing open into the kitchen.
  b.box("fh_door", root, "darkWood", 0.05, 2.1, 0.95, -0.47, 0.4, -d / 2 + 0.7, false);
  // Window trim on the outside.
  for (const [wx, wy] of [[-3, 1.4], [3, 1.4], [-3, 4.2], [3, 4.2], [0, 4.2]] as const) {
    b.box(`fh_trim_${wx}_${wy}`, root, "trim", 1.2, 0.1, 0.12, wx, wy - 0.1, -d / 2 - 0.05, false);
  }
  return root;
}

// ----------------------------------------------------------------------- barn

function barn(b: Builder) {
  const { x, z, w, d } = SITE.barn;
  const A = layout().anchors;
  const root = b.site("barn", x, z);
  root.position.y = A.gB;
  // Gambrel read as a tall gable: open underneath so the loft sees the rafters.
  b.gable("barn_roof", root, "barnRoof", w + 1.0, 5.0, d + 1.0, 0, 5.6, 0, { openBottom: true, inner: "plank" });
  // Rafters, for the loft.
  for (let rz = -d / 2 + 1; rz < d / 2; rz += 2) {
    const r1 = b.box(`barn_rafter_a${rz}`, root, "darkWood", 0.1, 0.12, 0.1, 0, 0, rz, false);
    r1.scaling.x = 88; // 8.8 m slope
    r1.position.set(-3.7, 5.6 + 2.35, rz);
    r1.rotation.z = Math.atan2(5, w / 2 + 0.5);
    const r2 = b.box(`barn_rafter_b${rz}`, root, "darkWood", 0.1, 0.12, 0.1, 0, 0, rz, false);
    r2.scaling.x = 88;
    r2.position.set(3.7, 5.6 + 2.35, rz);
    r2.rotation.z = -Math.atan2(5, w / 2 + 0.5);
  }
  // The big doors, slid open along the outside of the south wall.
  b.box("barn_door_l", root, "darkWood", 2.3, 3.7, 0.08, -3.3, 0.4, -d / 2 - 0.08);
  b.box("barn_door_r", root, "darkWood", 2.3, 3.7, 0.08, 3.3, 0.4, -d / 2 - 0.08);
  b.box("barn_door_track", root, "iron", 9.2, 0.08, 0.1, 0, 4.1, -d / 2 - 0.08, false);
  // Old hayloft door up in the south gable, and its hood.
  b.box("barn_hayloft_door", root, "darkWood", 2.0, 1.8, 0.1, 0, 6.2, -d / 2 - 0.05);
  b.box("barn_hay_hood", root, "barnRoof", 2.6, 0.15, 1.2, 0, 8.6, -d / 2 - 0.55);
  // Tack room lean-to roof, sloping away from the barn.
  const tackTop = A.tackTop - A.gB;
  const shed = b.box("tackroom_roof", root, "barnRoof", 4.6, 0.12, 8.6, -w / 2 - 2.15, tackTop, -4);
  shed.rotation.z = 0.06;
  b.box("tackroom_door", root, "darkWood", 0.05, 2.0, 0.85, -w / 2 - 3.0 - 0.45, 0.4, -8 + 0.65, false);
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
  layoutBoxes(b);
  farmhouse(b);
  barn(b);
  barnyard(b);
  gardenAndBeds(b);
  farmStand(b);
  roadside(b);
  return b;
}

export { postFence };
