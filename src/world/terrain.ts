import { Mesh, Scene, StandardMaterial, VertexData, Color3 } from "@babylonjs/core";
import { MAP, ZONES, type ZoneId, distToDrive, fbm, heightAt, noise2, zoneAt } from "./map";

type RGB = [number, number, number];

const mix = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/**
 * Early-March ground colours for each zone. Vegetation meshes arrive in M3;
 * until then the ground itself carries the season.
 */
function naturalColor(zone: ZoneId, x: number, z: number): RGB {
  const n = fbm(x * 0.15, z * 0.15);
  const fine = noise2(x * 1.7, z * 1.7);
  switch (zone) {
    case "road":
      return mix([0.5, 0.48, 0.44], [0.6, 0.57, 0.51], fine);
    case "ditch":
      // Dead stalks on the banks, green showing in the wet bottom.
      return mix([0.47, 0.41, 0.29], [0.33, 0.42, 0.22], n);
    case "yard": {
      // Dull spring lawn with purple henbit/deadnettle drifts.
      const lawn = mix([0.34, 0.43, 0.21], [0.42, 0.47, 0.27], fine);
      const henbit = fbm(x * 0.16 + 11, z * 0.16 - 4);
      return henbit > 0.56 ? mix(lawn, [0.47, 0.35, 0.52], Math.min(1, (henbit - 0.56) * 6)) : lawn;
    }
    case "barnyard":
      return mix([0.33, 0.26, 0.19], [0.42, 0.34, 0.24], n);
    case "garden":
      return mix([0.27, 0.21, 0.16], [0.36, 0.38, 0.22], fine * 0.6);
    case "prairie":
      // Dormant straw with green rosettes coming up at the base.
      return mix([0.64, 0.56, 0.38], [0.45, 0.47, 0.27], n * 0.55 + fine * 0.15);
    case "remnant":
      // Rust-coloured little bluestem.
      return mix([0.6, 0.39, 0.25], [0.66, 0.52, 0.33], n);
    case "fencerow":
      return mix([0.38, 0.3, 0.2], [0.3, 0.33, 0.2], n);
    case "edge":
      return mix([0.36, 0.29, 0.2], [0.31, 0.34, 0.2], n);
    case "treeline":
      return mix([0.28, 0.22, 0.15], [0.33, 0.27, 0.18], n);
    case "neighborWest":
      // Winter wheat greening up in drilled rows.
      return mix([0.3, 0.45, 0.2], [0.36, 0.5, 0.24], 0.5 + 0.5 * Math.sin(x * 2.2) * fine);
    case "neighborEast":
      return mix([0.58, 0.5, 0.36], [0.46, 0.4, 0.3], 0.5 + 0.5 * Math.sin(x * 1.3));
    case "neighborSouth":
      return mix([0.4, 0.44, 0.27], [0.5, 0.48, 0.33], n);
  }
}

export interface Terrain {
  mesh: Mesh;
  /** Swap between the natural March colours and the zone debug overlay. */
  setDebugZones(on: boolean): void;
}

export function createTerrain(scene: Scene): Terrain {
  const step = MAP.cell;
  const x0 = MAP.renderMinX, z0 = MAP.renderMinZ;
  const nx = Math.round((MAP.renderMaxX - x0) / step) + 1;
  const nz = Math.round((MAP.renderMaxZ - z0) / step) + 1;

  const positions: number[] = [];
  const indices: number[] = [];
  const natural: number[] = [];
  const debug: number[] = [];

  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * step;
      const z = z0 + j * step;
      positions.push(x, heightAt(x, z), z);

      const zone = zoneAt(x, z);
      let col = naturalColor(zone, x, z);
      // The drive is graded gravel through the yard.
      if (z > 6 && distToDrive(x, z) < 1.9) {
        col = mix([0.52, 0.5, 0.45], [0.6, 0.57, 0.5], noise2(x * 2, z * 2));
      }
      natural.push(col[0], col[1], col[2], 1);
      const d = ZONES[zone].debug;
      debug.push(d[0], d[1], d[2], 1);
    }
  }
  // Soften zone borders: one 3x3 box blur over the natural colours.
  const soft = natural.slice();
  for (let j = 1; j < nz - 1; j++) {
    for (let i = 1; i < nx - 1; i++) {
      for (let ch = 0; ch < 3; ch++) {
        let sum = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) sum += natural[((j + dj) * nx + (i + di)) * 4 + ch];
        soft[(j * nx + i) * 4 + ch] = sum / 9;
      }
    }
  }
  for (let k = 0; k < soft.length; k++) natural[k] = soft[k];

  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }

  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  const vd = new VertexData();
  vd.positions = positions;
  vd.indices = indices;
  vd.normals = normals;
  vd.colors = natural;

  const mesh = new Mesh("ground", scene);
  vd.applyToMesh(mesh, true);
  mesh.receiveShadows = true;
  mesh.isPickable = true;
  mesh.freezeWorldMatrix();

  const mat = new StandardMaterial("groundMat", scene);
  mat.diffuseColor = Color3.White();
  mat.specularColor = Color3.Black();
  mesh.material = mat;

  return {
    mesh,
    setDebugZones(on: boolean) {
      mesh.setVerticesData("color", on ? debug : natural, true);
    },
  };
}
