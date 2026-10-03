/**
 * Tree and shrub meshes, built per species from the database's Crown shape
 * and height. Two parts per species:
 *
 *   wood  — trunk and branches (always visible)
 *   crown — the leaf volume; shown in leaf, flower or fall colour, or as a faint
 *           twig haze in winter so a bare canopy still reads at a distance.
 *
 * Both are prototypes drawn through instances (one draw call each per species).
 */
import { Mesh, MeshBuilder, Quaternion, Scene, StandardMaterial, Vector3 } from "@babylonjs/core";
import type { Crown } from "../data/plants";
import { rng } from "../sim/random";

interface BranchSpec {
  trunk: number; // trunk length before the first fork (relative units)
  trunkDia: number;
  spread: number; // radians away from the parent branch
  depth: number;
  falloff: number; // child length / parent length
  stems: number; // >1 = multi-stemmed from the ground
  stemSplay: number;
}

const SPECS: Record<Crown, BranchSpec> = {
  spreading: { trunk: 1, trunkDia: 0.16, spread: 0.85, depth: 3, falloff: 0.72, stems: 1, stemSplay: 0 },
  upright: { trunk: 1.4, trunkDia: 0.11, spread: 0.45, depth: 3, falloff: 0.64, stems: 1, stemSplay: 0 },
  vase: { trunk: 0.7, trunkDia: 0.07, spread: 0.55, depth: 1, falloff: 0.6, stems: 4, stemSplay: 0.35 },
  multistem: { trunk: 0.9, trunkDia: 0.05, spread: 0.5, depth: 1, falloff: 0.55, stems: 6, stemSplay: 0.45 },
  arching: { trunk: 0.9, trunkDia: 0.04, spread: 0.7, depth: 1, falloff: 0.6, stems: 5, stemSplay: 0.7 },
  conifer: { trunk: 1, trunkDia: 0.08, spread: 0, depth: 0, falloff: 0, stems: 1, stemSplay: 0 },
};

/** Where the leaf mass sits, relative to tree height. */
export const CROWN_VOLUME: Record<Crown, { radius: number; height: number; centre: number }> = {
  spreading: { radius: 0.48, height: 0.55, centre: 0.62 },
  upright: { radius: 0.3, height: 0.62, centre: 0.64 },
  vase: { radius: 0.45, height: 0.5, centre: 0.68 },
  multistem: { radius: 0.48, height: 0.62, centre: 0.55 },
  arching: { radius: 0.5, height: 0.6, centre: 0.5 },
  conifer: { radius: 0.2, height: 0.8, centre: 0.5 },
};

/** Trunk and branches scaled to `height` metres. Conifers include their green cones. */
export function woodMesh(scene: Scene, name: string, crown: Crown, height: number, seed: number, bark: StandardMaterial, foliage: StandardMaterial): Mesh {
  const spec = SPECS[crown];
  const r = rng(seed);
  const parts: Mesh[] = [];
  const up = new Vector3(0, 1, 0);

  if (crown === "conifer") {
    const trunk = MeshBuilder.CreateCylinder("t", { height: height * 0.25, diameter: height * 0.05, tessellation: 6 }, scene);
    trunk.position.y = height * 0.125;
    trunk.material = bark;
    const lower = MeshBuilder.CreateCylinder("c1", { height: height * 0.62, diameterTop: height * 0.12, diameterBottom: height * 0.38, tessellation: 7 }, scene);
    lower.position.y = height * 0.15 + height * 0.31;
    const upper = MeshBuilder.CreateCylinder("c2", { height: height * 0.42, diameterTop: 0, diameterBottom: height * 0.22, tessellation: 7 }, scene);
    upper.position.y = height * 0.58 + height * 0.21;
    lower.material = foliage;
    upper.material = foliage;
    const m = Mesh.MergeMeshes([trunk, lower, upper], true, true, undefined, false, true)!;
    m.name = name;
    return m;
  }

  const branch = (base: Vector3, dir: Vector3, len: number, dia: number, level: number) => {
    // No end caps (never seen) and fewer sides on twigs: trees are the biggest triangle cost.
    const seg = MeshBuilder.CreateCylinder("b", { height: len, diameterTop: dia * 0.62, diameterBottom: dia, tessellation: level === 0 ? 5 : level === 1 ? 4 : 3, cap: Mesh.NO_CAP }, scene);
    const q = new Quaternion();
    Quaternion.FromUnitVectorsToRef(up, dir, q);
    seg.rotationQuaternion = q;
    seg.position = base.add(dir.scale(len / 2));
    parts.push(seg);
    if (level >= spec.depth) return;
    const tip = base.add(dir.scale(len));
    const kids = level === 0 ? 3 + Math.floor(r() * 2) : 2 + Math.floor(r() * 2);
    for (let k = 0; k < kids; k++) {
      const yaw = (k / kids) * Math.PI * 2 + r() * 1.2;
      const pitch = spec.spread * (0.7 + r() * 0.6);
      const side = new Vector3(Math.cos(yaw), 0, Math.sin(yaw));
      const nd = dir.scale(Math.cos(pitch)).add(side.scale(Math.sin(pitch))).normalize();
      nd.y = Math.max(nd.y, 0.15);
      branch(tip, nd.normalize(), len * spec.falloff * (0.8 + r() * 0.4), dia * 0.6, level + 1);
    }
  };
  for (let s = 0; s < spec.stems; s++) {
    const yaw = (s / spec.stems) * Math.PI * 2 + r();
    const splay = spec.stems > 1 ? spec.stemSplay * (0.6 + r() * 0.6) : 0.06 * r();
    const dir = new Vector3(Math.cos(yaw) * Math.sin(splay), Math.cos(splay), Math.sin(yaw) * Math.sin(splay)).normalize();
    branch(new Vector3((r() - 0.5) * 0.1, 0, (r() - 0.5) * 0.1), dir, spec.trunk * (0.85 + r() * 0.3), spec.trunkDia, 0);
  }
  const wood = Mesh.MergeMeshes(parts, true, true)!;
  // Normalise to the species' height.
  const box = wood.getBoundingInfo().boundingBox;
  wood.scaling.setAll(height / Math.max(0.01, box.maximum.y));
  wood.bakeCurrentTransformIntoVertices();
  wood.name = name;
  wood.material = bark;
  return wood;
}

/** Leaf volume: a few overlapping low-poly blobs inside the crown envelope. */
export function crownMesh(scene: Scene, name: string, crown: Crown, height: number, seed: number, mat: StandardMaterial): Mesh {
  const v = CROWN_VOLUME[crown];
  const r = rng(seed ^ 0xc0ffee);
  const blobs: Mesh[] = [];
  const n = crown === "multistem" || crown === "vase" ? 4 : 3;
  for (let k = 0; k < n; k++) {
    // Icosahedron blobs: 20 faces each; crowns are drawn hundreds of times.
    const s = MeshBuilder.CreatePolyhedron("cb", { type: 3, size: 0.5 }, scene);
    const rad = height * v.radius * (0.7 + r() * 0.35);
    s.scaling.set(rad * 2, height * v.height * (0.7 + r() * 0.3), rad * 2);
    const a = (k / n) * Math.PI * 2 + r();
    const off = height * v.radius * 0.35;
    s.position.set(Math.cos(a) * off, height * v.centre + (r() - 0.5) * height * 0.1, Math.sin(a) * off);
    blobs.push(s);
  }
  const m = Mesh.MergeMeshes(blobs, true, true)!;
  m.name = name;
  m.material = mat;
  return m;
}
