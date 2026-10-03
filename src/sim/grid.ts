import { MAP } from "../world/map";

/**
 * The habitat grid: one node every 2 m over the property, aligned with the
 * terrain mesh vertices (both start on even metres), so a node's index maps
 * straight onto a terrain vertex for overlays.
 *
 * Node (i, j) sits at x = minX + i·cell, z = minZ + j·cell and represents the
 * 2 × 2 m cell centred on it.
 */
export const GRID = {
  cell: MAP.cell,
  minX: MAP.minX,
  minZ: MAP.minZ,
  nx: Math.round((MAP.maxX - MAP.minX) / MAP.cell) + 1, // 81
  nz: Math.round((MAP.maxZ - MAP.minZ) / MAP.cell) + 1, // 201
} as const;

export const NODE_COUNT = GRID.nx * GRID.nz;

export const nodeX = (i: number) => GRID.minX + i * GRID.cell;
export const nodeZ = (j: number) => GRID.minZ + j * GRID.cell;
export const nodeIndex = (i: number, j: number) => j * GRID.nx + i;

/** Nearest node to a world position, or -1 when off the property. */
export function nodeAt(x: number, z: number): number {
  const i = Math.round((x - GRID.minX) / GRID.cell);
  const j = Math.round((z - GRID.minZ) / GRID.cell);
  if (i < 0 || j < 0 || i >= GRID.nx || j >= GRID.nz) return -1;
  return nodeIndex(i, j);
}

/** Bilinear sample of a node layer at a world position (clamped to the grid). */
export function sampleLayer(layer: ArrayLike<number>, x: number, z: number): number {
  const fx = Math.min(GRID.nx - 1.0001, Math.max(0, (x - GRID.minX) / GRID.cell));
  const fz = Math.min(GRID.nz - 1.0001, Math.max(0, (z - GRID.minZ) / GRID.cell));
  const i = Math.floor(fx), j = Math.floor(fz);
  const u = fx - i, v = fz - j;
  const a = layer[nodeIndex(i, j)], b = layer[nodeIndex(i + 1, j)];
  const c = layer[nodeIndex(i, j + 1)], d = layer[nodeIndex(i + 1, j + 1)];
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}
