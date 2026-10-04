import { Mesh, Scene, StandardMaterial, VertexData, Color3 } from "@babylonjs/core";
import { inTerrainHole } from "./layout";
import { MAP, SITE, type ZoneId, distToDrive, distToPolyline, fbm, heightAt, noise2, zoneAt } from "./map";

export type RGB = [number, number, number];

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
  /**
   * Blend the property's ground toward the colour of its vegetation
   * (3 floats per habitat node; r < 0 = no plant there). Keeps the far view
   * consistent with the plants: gray goldenrod field, rust remnant, green lawn.
   */
  setVegetationTint(tint: Float32Array, amount: number): void;
  /** Paint property nodes with a debug colour (null = natural ground). */
  setOverlay(colorOf: ((node: number) => RGB | null) | null): void;
  /** 0–1 snow cover over everything (applied on top of the vegetation tint). */
  setSnow(cover: number): void;
}

export function createTerrain(scene: Scene): Terrain {
  const step = MAP.cell;
  const x0 = MAP.renderMinX, z0 = MAP.renderMinZ;
  const nx = Math.round((MAP.renderMaxX - x0) / step) + 1;
  const nz = Math.round((MAP.renderMaxZ - z0) / step) + 1;
  // Offset from terrain vertices to habitat nodes (both on the same 2 m lattice).
  const ox = Math.round((MAP.minX - x0) / step), oz = Math.round((MAP.minZ - z0) / step);
  const hx = Math.round((MAP.maxX - MAP.minX) / step) + 1, hz = Math.round((MAP.maxZ - MAP.minZ) / step) + 1;
  const nodeOfVertex = (i: number, j: number) => {
    const a = i - ox, b = j - oz;
    return a < 0 || b < 0 || a >= hx || b >= hz ? -1 : b * hx + a;
  };

  const positions: number[] = [];
  const indices: number[] = [];
  const natural: number[] = [];

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
      // The mowed path through the field shows as a shorter, greener stripe.
      if (z > SITE.yard.z1 - 6 && distToPolyline(x, z, SITE.mowPath) < SITE.mowPathWidth / 2) {
        col = mix(col, [0.4, 0.46, 0.26], 0.6);
      }
      natural.push(col[0], col[1], col[2], 1);
    }
  }
  const blur = (src: ArrayLike<number>, stride: number, valid?: (k: number) => boolean) => {
    const out = Array.from(src);
    for (let j = 1; j < nz - 1; j++) {
      for (let i = 1; i < nx - 1; i++) {
        const k = j * nx + i;
        if (valid && !valid(k)) continue;
        for (let ch = 0; ch < 3; ch++) {
          let sum = 0, cnt = 0;
          for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
            const kk = (j + dj) * nx + (i + di);
            if (valid && !valid(kk)) continue;
            sum += src[kk * stride + ch];
            cnt++;
          }
          out[k * stride + ch] = sum / cnt;
        }
      }
    }
    return out;
  };
  // Soften zone borders.
  const base = blur(natural, 4);

  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      // The ground is cut away over the root cellar and its stairwell.
      if (inTerrainHole(x0 + (i + 0.5) * step, z0 + (j + 0.5) * step)) continue;
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
  vd.colors = base;

  const mesh = new Mesh("ground", scene);
  vd.applyToMesh(mesh, true);
  mesh.receiveShadows = true;
  mesh.isPickable = true;
  mesh.freezeWorldMatrix();

  const mat = new StandardMaterial("groundMat", scene);
  mat.diffuseColor = Color3.White();
  mat.specularColor = Color3.Black();
  mesh.material = mat;

  let tinted = base;
  let vegTint: number[] = base;
  let snow = 0;
  const applySnow = () => {
    if (snow <= 0) { tinted = vegTint; return; }
    tinted = vegTint.slice();
    for (let k = 0; k < nx * nz; k++) {
      // Patchy at first: snow fills low spots and leaves ridges and tall stubble showing.
      const x = x0 + (k % nx) * step, z = z0 + Math.floor(k / nx) * step;
      const patch = Math.min(1, Math.max(0, snow * 1.6 - 0.6 * noise2(x * 0.12, z * 0.12)));
      const w = 0.9 * patch;
      tinted[k * 4] = tinted[k * 4] * (1 - w) + 0.93 * w;
      tinted[k * 4 + 1] = tinted[k * 4 + 1] * (1 - w) + 0.95 * w;
      tinted[k * 4 + 2] = tinted[k * 4 + 2] * (1 - w) + 0.98 * w;
    }
  };
  return {
    mesh,
    setSnow(cover: number) {
      if (Math.abs(cover - snow) < 0.01) return;
      snow = cover;
      applySnow();
      mesh.setVerticesData("color", tinted, true);
    },
    setVegetationTint(tint: Float32Array, amount: number) {
      // Expand node tint onto terrain vertices, blur it so single nodes don't speckle.
      const vtx = new Array(nx * nz * 3).fill(-1);
      for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
        const n = nodeOfVertex(i, j);
        if (n < 0 || tint[n * 3] < 0) continue;
        const k = (j * nx + i) * 3;
        vtx[k] = tint[n * 3]; vtx[k + 1] = tint[n * 3 + 1]; vtx[k + 2] = tint[n * 3 + 2];
      }
      const soft = blur(vtx, 3, (k) => vtx[k * 3] >= 0);
      vegTint = base.slice();
      for (let k = 0; k < nx * nz; k++) {
        if (soft[k * 3] < 0) continue;
        for (let ch = 0; ch < 3; ch++) vegTint[k * 4 + ch] = base[k * 4 + ch] * (1 - amount) + soft[k * 3 + ch] * 0.85 * amount;
      }
      applySnow();
      mesh.setVerticesData("color", tinted, true);
    },
    setOverlay(colorOf) {
      if (!colorOf) {
        mesh.setVerticesData("color", tinted, true);
        return;
      }
      const out = tinted.slice();
      for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
        const n = nodeOfVertex(i, j);
        const k = (j * nx + i) * 4;
        const c = n < 0 ? null : colorOf(n);
        if (c) { out[k] = c[0]; out[k + 1] = c[1]; out[k + 2] = c[2]; }
        else { const g = (out[k] + out[k + 1] + out[k + 2]) / 3 * 0.6; out[k] = out[k + 1] = out[k + 2] = g; }
      }
      mesh.setVerticesData("color", out, true);
    },
  };
}
