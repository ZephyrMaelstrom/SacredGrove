import {
  Color3,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
  ShadowGenerator,
  Quaternion,
} from "@babylonjs/core";
import { heightAt, noise2 } from "./map";
import { postFence, Builder } from "./buildings";

/**
 * Early-March woody vegetation for Map 1: bare hardwoods, evergreen red cedar,
 * and the two shrubs that actually read from a distance in a Southern Illinois
 * March — bush honeysuckle (already leafing out) and spicebush (yellow bloom).
 *
 * Every tree is a merged prototype mesh drawn as instances, so each prototype
 * costs one draw call no matter how many times it is placed.
 */

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function material(scene: Scene, name: string, c: Color3, alpha = 1) {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = c;
  m.specularColor = Color3.Black();
  if (alpha < 1) {
    m.alpha = alpha;
    m.backFaceCulling = false;
  }
  return m;
}

interface BareSpec {
  height: number; // trunk to first fork
  trunkDia: number;
  spread: number; // branch angle in radians
  depth: number;
  lengthFalloff: number;
  hazeScale: Vector3; // twig haze ellipsoid around the crown
}

/** Recursive bare-branch tree, merged to one mesh, plus a translucent twig haze. */
function bareTree(scene: Scene, name: string, spec: BareSpec, seed: number, barkMat: StandardMaterial, hazeMat: StandardMaterial): Mesh {
  const r = rng(seed);
  const parts: Mesh[] = [];
  const up = new Vector3(0, 1, 0);

  const branch = (base: Vector3, dir: Vector3, len: number, dia: number, level: number) => {
    const seg = MeshBuilder.CreateCylinder("b", { height: len, diameterTop: dia * 0.62, diameterBottom: dia, tessellation: level < 2 ? 7 : 5 }, scene);
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
      // Rotate the parent direction outward by pitch around a random horizontal axis.
      const side = new Vector3(Math.cos(yaw), 0, Math.sin(yaw));
      const nd = dir.scale(Math.cos(pitch)).add(side.scale(Math.sin(pitch))).normalize();
      nd.y = Math.max(nd.y, 0.15);
      branch(tip, nd.normalize(), len * spec.lengthFalloff * (0.8 + r() * 0.4), dia * 0.6, level + 1);
    }
  };

  const lean = new Vector3((r() - 0.5) * 0.12, 1, (r() - 0.5) * 0.12).normalize();
  branch(Vector3.Zero(), lean, spec.height, spec.trunkDia, 0);
  const wood = Mesh.MergeMeshes(parts, true, true)!;
  wood.name = name;
  wood.material = barkMat;

  // Crown haze: reads as the fine twig mass of a bare tree at distance.
  let crownH = spec.height;
  for (let l = 1, s = spec.height * spec.lengthFalloff; l <= spec.depth; l++, s *= spec.lengthFalloff) crownH += s * 0.8;
  const haze = MeshBuilder.CreateSphere(`${name}_haze`, { diameter: 1, segments: 6 }, scene);
  haze.scaling = spec.hazeScale.clone();
  haze.position.y = (spec.height + crownH) / 2 + spec.height * 0.15;
  haze.material = hazeMat;
  haze.parent = wood;
  return wood;
}

function cedar(scene: Scene, name: string, h: number, trunkMat: StandardMaterial, foliageMat: StandardMaterial): Mesh {
  const trunk = MeshBuilder.CreateCylinder("t", { height: h * 0.25, diameter: h * 0.06, tessellation: 6 }, scene);
  trunk.position.y = h * 0.125;
  trunk.material = trunkMat;
  const lower = MeshBuilder.CreateCylinder("c1", { height: h * 0.65, diameterTop: h * 0.12, diameterBottom: h * 0.38, tessellation: 7 }, scene);
  lower.position.y = h * 0.15 + h * 0.325;
  const upper = MeshBuilder.CreateCylinder("c2", { height: h * 0.4, diameterTop: 0, diameterBottom: h * 0.22, tessellation: 7 }, scene);
  upper.position.y = h * 0.6 + h * 0.2;
  lower.material = foliageMat;
  upper.material = foliageMat;
  const m = Mesh.MergeMeshes([trunk, lower, upper], true, true, undefined, false, true)!;
  m.name = name;
  return m;
}

function shrub(scene: Scene, name: string, w: number, h: number, mat: StandardMaterial, seed: number): Mesh {
  const r = rng(seed);
  const lumps: Mesh[] = [];
  for (let i = 0; i < 4; i++) {
    const s = MeshBuilder.CreateSphere("s", { diameter: 1, segments: 4 }, scene);
    s.scaling.set(w * (0.5 + r() * 0.4), h * (0.6 + r() * 0.4), w * (0.5 + r() * 0.4));
    s.position.set((r() - 0.5) * w * 0.6, h * 0.4, (r() - 0.5) * w * 0.6);
    lumps.push(s);
  }
  const m = Mesh.MergeMeshes(lumps, true, true)!;
  m.name = name;
  m.material = mat;
  return m;
}

/** Place an instance of `proto` on the terrain. */
function plant(proto: Mesh, parent: TransformNode, x: number, z: number, scale: number, rotY: number, haze = true) {
  const inst = proto.createInstance(`${proto.name}_i`);
  inst.parent = parent;
  inst.position.set(x, heightAt(x, z) - 0.05, z);
  inst.scaling.setAll(scale);
  inst.rotation.y = rotY;
  inst.isPickable = false;
  // Child meshes (twig haze) need their own instances.
  // Close-up trees skip it: from underneath it reads as a gray lid.
  if (haze) for (const child of proto.getChildMeshes(true) as Mesh[]) {
    const ci = child.createInstance(`${child.name}_i`);
    ci.parent = inst;
    ci.position.copyFrom(child.position);
    ci.scaling.copyFrom(child.scaling);
    ci.isPickable = false;
  }
  return inst;
}

export function createWoody(scene: Scene, builder: Builder, shadows?: ShadowGenerator) {
  const root = new TransformNode("woody", scene);

  const bark = material(scene, "bark", new Color3(0.36, 0.33, 0.3));
  const barkDark = material(scene, "barkDark", new Color3(0.24, 0.21, 0.18));
  const barkPale = material(scene, "barkPale", new Color3(0.5, 0.48, 0.45));
  const twig = material(scene, "twigHaze", new Color3(0.4, 0.35, 0.36), 0.16);
  const twigWarm = material(scene, "twigHazeWarm", new Color3(0.45, 0.37, 0.34), 0.15);
  const cedarGreen = material(scene, "cedarFoliage", new Color3(0.16, 0.25, 0.15));
  const honeysuckle = material(scene, "honeysuckleLeaf", new Color3(0.38, 0.55, 0.22));
  const spicebush = material(scene, "spicebushBloom", new Color3(0.78, 0.74, 0.38), 0.5);
  const bramble = material(scene, "brambleCanes", new Color3(0.4, 0.2, 0.24), 0.7);

  // --- prototypes (hidden; instances are what you see)
  const protos = {
    whiteOak: [1, 2, 3].map((s) =>
      bareTree(scene, `whiteOak${s}`, { height: 5, trunkDia: 0.8, spread: 0.85, depth: 3, lengthFalloff: 0.72, hazeScale: new Vector3(16, 9, 16) }, 100 + s, barkPale, twig)),
    hickory: [1, 2].map((s) =>
      bareTree(scene, `shagbarkHickory${s}`, { height: 9, trunkDia: 0.55, spread: 0.45, depth: 3, lengthFalloff: 0.62, hazeScale: new Vector3(8, 11, 8) }, 200 + s, bark, twig)),
    walnut: [1, 2].map((s) =>
      bareTree(scene, `blackWalnut${s}`, { height: 6, trunkDia: 0.6, spread: 0.7, depth: 3, lengthFalloff: 0.68, hazeScale: new Vector3(12, 8, 12) }, 300 + s, barkDark, twigWarm)),
    maple: [1, 2].map((s) =>
      bareTree(scene, `sugarMaple${s}`, { height: 7, trunkDia: 0.6, spread: 0.55, depth: 3, lengthFalloff: 0.66, hazeScale: new Vector3(10, 11, 10) }, 400 + s, bark, twigWarm)),
    small: [1, 2, 3].map((s) =>
      bareTree(scene, `fencerowTree${s}`, { height: 3.2, trunkDia: 0.3, spread: 0.7, depth: 2, lengthFalloff: 0.7, hazeScale: new Vector3(6, 5, 6) }, 500 + s, barkDark, twigWarm)),
    cedar: [cedar(scene, "redCedar", 9, barkDark, cedarGreen)],
    honeysuckle: [1, 2].map((s) => shrub(scene, `bushHoneysuckle${s}`, 3.2, 3, honeysuckle, 600 + s)),
    spicebush: [shrub(scene, "spicebush", 2.4, 2.4, spicebush, 700)],
    bramble: [1, 2].map((s) => shrub(scene, `bramble${s}`, 2.2, 1.2, bramble, 800 + s)),
  };
  // Prototypes own the instance buffers. Hide the source meshes (instances
  // still draw) and park them below the map so their haze children vanish too.
  for (const list of Object.values(protos)) {
    for (const p of list) {
      p.isVisible = false;
      p.position.y = -500;
      p.isPickable = false;
    }
  }

  const r = rng(42);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];

  // --- Tree line: four rows, denser and darker toward the back.
  const rows = [
    { z: 374, spacing: 6.5, jitter: 2.0, scale: 1.0 },
    { z: 380, spacing: 5.0, jitter: 2.5, scale: 1.05 },
    { z: 387, spacing: 4.5, jitter: 2.5, scale: 1.1 },
    { z: 394, spacing: 4.0, jitter: 2.5, scale: 1.1 },
    { z: 402, spacing: 4.0, jitter: 3.0, scale: 1.15 },
    { z: 411, spacing: 4.0, jitter: 3.0, scale: 1.15 },
    { z: 421, spacing: 4.5, jitter: 3.0, scale: 1.2 },
  ];
  for (const row of rows) {
    for (let x = -150; x <= 150; x += row.spacing * (0.8 + r() * 0.4)) {
      const n = noise2(x * 0.08, row.z * 0.08);
      const proto = n < 0.3 ? pick(protos.whiteOak) : n < 0.5 ? pick(protos.hickory) : n < 0.7 ? pick(protos.maple) : pick(protos.walnut);
      plant(proto, root, x + (r() - 0.5) * row.jitter, row.z + (r() - 0.5) * row.jitter, row.scale * (0.85 + r() * 0.3), r() * Math.PI * 2);
    }
  }

  // --- Forest edge margin (z 360–372): the harvestable fringe.
  for (let x = -70; x <= 70; x += 2.2 + r() * 2.5) {
    const z = 362 + r() * 9;
    const n = noise2(x * 0.11 + 5, z * 0.11);
    if (n < 0.45) plant(pick(protos.honeysuckle), root, x, z, 0.8 + r() * 0.5, r() * 6.28);
    else if (n < 0.65) plant(protos.spicebush[0], root, x, z, 0.8 + r() * 0.4, r() * 6.28);
    else plant(pick(protos.bramble), root, x, z - 3, 0.8 + r() * 0.5, r() * 6.28);
  }

  // --- Fencerows along both property lines.
  for (const side of [-1, 1]) {
    const fx = side * 76;
    postFence(builder, `fencerow_${side < 0 ? "west" : "east"}_posts`, [[side * 72.5, 15], [side * 72.5, 368]], 3, 0);
    // Three strands of barbed wire.
    for (let s = 0; s < 3; s++) {
      const pts: Vector3[] = [];
      for (let z = 15; z <= 368; z += 3) pts.push(new Vector3(side * 72.5, heightAt(side * 72.5, z) + 0.45 + s * 0.32, z));
      const wire = MeshBuilder.CreateLines(`wire_${side}_${s}`, { points: pts }, scene);
      wire.color = new Color3(0.35, 0.34, 0.33);
      wire.alpha = 0.9;
      wire.parent = root;
      wire.isPickable = false;
    }
    for (let z = 18; z < 366; z += 3 + r() * 5) {
      const n = noise2(fx * 0.05, z * 0.07);
      const x = fx + (r() - 0.5) * 5;
      if (n < 0.28) plant(pick(protos.bramble), root, x, z, 0.9 + r() * 0.6, r() * 6.28);
      else if (n < 0.5) plant(pick(protos.honeysuckle), root, x, z, 0.7 + r() * 0.5, r() * 6.28);
      else if (n < 0.62) plant(protos.cedar[0], root, x, z, 0.6 + r() * 0.6, r() * 6.28);
      else if (n < 0.78) plant(pick(protos.small), root, x, z, 0.9 + r() * 0.5, r() * 6.28);
      // else: open gap — fencerows are patchy, which is where the light species grow.
    }
  }

  // --- Yard trees: an old white oak shading the house, a maple by the drive,
  // a cedar windbreak behind the barn.
  const yardOak = plant(protos.whiteOak[0], root, -54, 52, 1.25, 0.4, false);
  const driveMaple = plant(protos.maple[0], root, -27, 27, 1.0, 1.7, false);
  shadows?.addShadowCaster(yardOak, true);
  shadows?.addShadowCaster(driveMaple, true);
  for (let i = 0; i < 6; i++) plant(protos.cedar[0], root, -4 + i * 4.5, 84 + (r() - 0.5) * 2, 0.8 + r() * 0.3, r() * 6.28);

  root.getChildMeshes().forEach((m) => m.freezeWorldMatrix());
  return root;
}
