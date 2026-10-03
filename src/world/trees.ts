/**
 * Structural woody features of Map 1 — the parts placed by design rather than
 * by the habitat model:
 *
 *   • the tree line (a wall of real species: white oak, shagbark hickory,
 *     sugar maple, black walnut — no entry on this map)
 *   • the two old yard trees and the cedar windbreak behind the barn
 *   • fencerow posts and barbed wire
 *   • fallen logs at the forest edge (host wood for fungi)
 *
 * The fencerow shrubs and trees themselves are habitat-placed (src/sim/placement.ts)
 * and drawn by the WoodyRenderer alongside these.
 */
import { Color3, MeshBuilder, Scene, StandardMaterial, TransformNode, Vector3 } from "@babylonjs/core";
import { SITE, heightAt, noise2 } from "./map";
import { postFence, type Builder } from "./buildings";
import type { WoodyRenderer } from "../veg/woody";
import { rng } from "../sim/random";

const TREELINE_ROWS = [
  { z: 374, spacing: 6.5, jitter: 2.0, scale: 0.75 },
  { z: 380, spacing: 5.0, jitter: 2.5, scale: 0.8 },
  { z: 387, spacing: 4.5, jitter: 2.5, scale: 0.85 },
  { z: 394, spacing: 4.0, jitter: 2.5, scale: 0.85 },
  { z: 403, spacing: 5.0, jitter: 3.5, scale: 0.95 }, // last row: fog and the rows in front hide the rest
];

export function createStructuralWoody(scene: Scene, builder: Builder, woody: WoodyRenderer) {
  const root = new TransformNode("structuralWoody", scene);
  const r = rng(42);

  // --- Tree line: upland oak–hickory woods with maple and walnut.
  for (const row of TREELINE_ROWS) {
    for (let x = -135; x <= 135; x += row.spacing * (0.8 + r() * 0.4)) {
      const n = noise2(x * 0.08, row.z * 0.08);
      const latin = n < 0.32 ? "Quercus alba" : n < 0.5 ? "Carya ovata" : n < 0.7 ? "Acer saccharum" : "Juglans nigra";
      const px = x + (r() - 0.5) * row.jitter, pz = row.z + (r() - 0.5) * row.jitter;
      woody.addByLatin(latin, px, heightAt(px, pz), pz, row.scale * (0.85 + r() * 0.3), r() * Math.PI * 2);
    }
  }

  // --- Yard trees (open-grown, so wider and lower than the woods' trees) and the windbreak.
  for (const t of SITE.yardTrees) {
    const latin = t.species === "whiteOak" ? "Quercus alba" : "Acer saccharum";
    woody.addByLatin(latin, t.x, heightAt(t.x, t.z), t.z, t.species === "whiteOak" ? 0.95 : 0.7, 0.4, true);
  }
  const wb = SITE.windbreak;
  for (let x = wb.x0; x <= wb.x1; x += 4.5) {
    const z = wb.z + (r() - 0.5) * 1.5;
    woody.addByLatin("Juniperus virginiana", x, heightAt(x, z), z, 0.8 + r() * 0.25, r() * 6.28, true);
  }

  // --- Fencerow posts and three strands of barbed wire on both property lines.
  const wireMat = new Color3(0.35, 0.34, 0.33);
  for (const side of [-1, 1]) {
    postFence(builder, `fencerow_${side < 0 ? "west" : "east"}_posts`, [[side * 72.5, 15], [side * 72.5, 368]], 3, 0);
    for (let s = 0; s < 3; s++) {
      const pts: Vector3[] = [];
      for (let z = 15; z <= 368; z += 3) pts.push(new Vector3(side * 72.5, heightAt(side * 72.5, z) + 0.45 + s * 0.32, z));
      const wire = MeshBuilder.CreateLines(`wire_${side}_${s}`, { points: pts }, scene);
      wire.color = wireMat;
      wire.parent = root;
      wire.isPickable = false;
    }
  }

  // --- Fallen logs at the forest edge.
  const logMat = new StandardMaterial("logBark", scene);
  logMat.diffuseColor = new Color3(0.33, 0.29, 0.25);
  logMat.specularColor = Color3.Black();
  for (const [i, g] of SITE.logs.entries()) {
    const log = MeshBuilder.CreateCylinder(`log_${i}`, { height: g.len, diameterTop: g.dia * 0.8, diameterBottom: g.dia, tessellation: 8 }, scene);
    // Cylinder axis is local Y: pitch it flat (along +Z), then yaw to the log's heading.
    log.rotation.set(Math.PI / 2, g.rotY, 0);
    log.position.set(g.x, heightAt(g.x, g.z) + g.dia * 0.35, g.z);
    log.material = logMat;
    log.parent = root;
    log.isPickable = false;
  }
  return root;
}
