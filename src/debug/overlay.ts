/**
 * Habitat overlays painted onto the terrain (M2 debug view).
 *
 * Z cycles: natural → zones → light → moisture → wetness → disturbance →
 *           fertility → homestead → perch → mowing → plow history
 * X shows where the plant you're looking at can grow (its suitability map).
 */
import type { Plant } from "../data/plants";
import { ZONES } from "../world/map";
import type { Terrain, RGB } from "../world/terrain";
import { ZONE_ORDER, type ContinuousLayer, type HabitatLayers } from "../sim/habitat";
import { suitability } from "../sim/suitability";

export type OverlayMode =
  | "natural" | "zones" | ContinuousLayer | "mow" | "plowed" | "suitability";

export const OVERLAY_CYCLE: OverlayMode[] = [
  "natural", "zones", "light", "moisture", "wetness", "disturbance", "fertility", "homestead", "perch", "mow", "plowed",
];

export const OVERLAY_LABEL: Record<OverlayMode, string> = {
  natural: "Natural ground",
  zones: "Zones",
  light: "Light (growing season)",
  moisture: "Soil moisture",
  wetness: "Wetness index (water flow)",
  disturbance: "Disturbance",
  fertility: "Fertility",
  homestead: "Garden escape reach",
  perch: "Bird perches (seed rain)",
  mow: "Mowing",
  plowed: "Plow history",
  suitability: "Suitability",
};

// Perceptual ramp (dark violet → teal → yellow), readable on a headset.
const STOPS: RGB[] = [[0.27, 0.0, 0.33], [0.23, 0.32, 0.55], [0.13, 0.57, 0.55], [0.37, 0.79, 0.38], [0.99, 0.91, 0.14]];
export function ramp(v: number): RGB {
  const t = Math.min(0.9999, Math.max(0, v)) * (STOPS.length - 1);
  const i = Math.floor(t), f = t - i;
  const a = STOPS[i], b = STOPS[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

const MOW_COLORS: RGB[] = [[0.25, 0.25, 0.3], [0.5, 0.4, 0.7], [0.3, 0.6, 0.9], [0.4, 0.9, 0.4]];

export function applyOverlay(terrain: Terrain, L: HabitatLayers, mode: OverlayMode, plant?: Plant | null) {
  switch (mode) {
    case "natural":
      return terrain.setOverlay(null);
    case "zones":
      return terrain.setOverlay((n) => ZONES[ZONE_ORDER[L.zone[n]]].debug);
    case "mow":
      return terrain.setOverlay((n) => MOW_COLORS[L.mow[n]]);
    case "plowed":
      return terrain.setOverlay((n) => (L.plowed[n] ? [0.62, 0.48, 0.3] : [0.2, 0.55, 0.3]));
    case "suitability": {
      if (!plant) return terrain.setOverlay(null);
      const vals = new Float32Array(L.zone.length);
      let max = 1e-6;
      for (let n = 0; n < vals.length; n++) max = Math.max(max, (vals[n] = suitability(plant, L, n)));
      return terrain.setOverlay((n) => ramp(vals[n] / max));
    }
    default: {
      const layer = L[mode];
      return terrain.setOverlay((n) => ramp(layer[n]));
    }
  }
}
