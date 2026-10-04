/**
 * Invisible meshes for the VR teleport: every layout floor and stair ramp is
 * a landing surface, and every blocking wall (plus the roofs) stops the
 * teleport arc. Built from the same layout the desktop walker uses.
 */
import { Mesh, MeshBuilder, VertexData, type Scene } from "@babylonjs/core";
import { layout } from "./layout";

export function createColliders(scene: Scene) {
  const L = layout();
  const floorParts: Mesh[] = [];
  for (const [i, f] of L.floors.entries()) {
    const y0 = f.y, y1 = f.ramp ? f.ramp.y1 : f.y;
    // Quad with the ramp's slope (low end at a0).
    const lowAtZ0 = !f.ramp || f.ramp.a0 <= f.ramp.a1;
    const ya = lowAtZ0 ? y0 : y1, yb = lowAtZ0 ? y1 : y0; // heights at z0 and z1
    const m = new Mesh(`tpFloor_${i}`, scene);
    const vd = new VertexData();
    vd.positions = [f.x0, ya + 0.01, f.z0, f.x1, ya + 0.01, f.z0, f.x1, yb + 0.01, f.z1, f.x0, yb + 0.01, f.z1];
    vd.indices = [0, 2, 1, 0, 3, 2];
    vd.normals = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
    vd.applyToMesh(m);
    floorParts.push(m);
  }
  const floors = Mesh.MergeMeshes(floorParts, true, true)!;
  floors.name = "tpFloors";

  const blockParts: Mesh[] = [];
  for (const [i, b] of L.boxes.entries()) {
    if (!b.block || (b.y1 - b.y0 < 0.5)) continue;
    const m = MeshBuilder.CreateBox(`tpBlock_${i}`, { width: b.x1 - b.x0, height: b.y1 - b.y0, depth: b.z1 - b.z0 }, scene);
    m.position.set((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2);
    blockParts.push(m);
  }
  // Roofs: arcs can't drop through them into the rooms below.
  const A = L.anchors;
  const roof = (x0: number, x1: number, z0: number, z1: number, y: number) => {
    const m = MeshBuilder.CreateBox("tpRoof", { width: x1 - x0, height: 0.1, depth: z1 - z0 }, scene);
    m.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
    blockParts.push(m);
  };
  roof(0.5, 15.5, 50.5, 73.5, A.barnTop + 2.5);
  roof(-3.3, 1, 53.7, 62.3, A.tackTop + 0.2);
  roof(-47.5, -36.5, 63, 73, A.houseTop + 1.2);
  const blockers = Mesh.MergeMeshes(blockParts, true, true)!;
  blockers.name = "tpBlockers";

  for (const m of [floors, blockers]) {
    m.isVisible = false;
    m.isPickable = true;
    m.freezeWorldMatrix();
  }
  return { floors, blockers };
}
