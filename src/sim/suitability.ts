/**
 * How well a plant can live at one habitat node (0–1), and why.
 *
 * suitability = niche fit (light × moisture × disturbance × fertility)
 *             × substrate gate × mowing × sward competition
 *             × land history (conservatism) × seed arrival (dispersal)
 *
 * Every factor is kept separate in `explain()` so the game (and you) can ask
 * "why isn't Rattlesnake Master growing here?" and get a real answer.
 */
import type { Plant } from "../data/plants";
import { MOW, SUBSTRATE, ZONE_ORDER, type HabitatLayers } from "./habitat";
import { GRID } from "./grid";
import { SITE } from "../world/map";

const FENCEROW = ZONE_ORDER.indexOf("fencerow");
const GARDEN = ZONE_ORDER.indexOf("garden");

const gauss = (v: number, [opt, tol]: [number, number]) => Math.exp(-(((v - opt) / tol) ** 2));
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Light a woody plant can reach: fencerow trees grow up through their own shade. */
function woodyLight(L: HabitatLayers, n: number) {
  return Math.max(L.light[n], L.zone[n] === FENCEROW ? 0.85 : 0);
}

export interface SuitabilityFactors {
  niche: number;
  light: number;
  moisture: number;
  disturbance: number;
  fertility: number;
  substrate: number;
  mowing: number;
  sward: number;
  history: number;
  arrival: number;
  total: number;
}

export function explain(p: Plant, L: HabitatLayers, n: number): SuitabilityFactors {
  const woody = p.form === "tree" || p.form === "shrub";
  const light = gauss(woody ? woodyLight(L, n) : L.light[n], p.niche.light);
  const moisture = gauss(L.moisture[n], p.niche.moisture);
  const disturbance = gauss(L.disturbance[n], p.niche.disturbance);
  const fertility = gauss(L.fertility[n], p.niche.fertility);
  const niche = light * moisture * disturbance * fertility;

  // Ground it can root in.
  let substrate = 1;
  const sub = L.substrate[n];
  if (sub === SUBSTRATE.built) substrate = 0;
  else if (p.host === "wood") substrate = 0; // fungi on logs are placed separately
  else if (sub === SUBSTRATE.gravel) substrate = p.host === "soilOrGravel" ? 0.6 : 0.03;

  // Mowing kills anything that can't take it.
  const mowExcess = L.mow[n] - p.mowTolerance;
  const mowing = mowExcess <= 0 ? 1 : [1, 0.3, 0.08, 0.02][mowExcess];

  // In unmowed, undisturbed, sunny ground the sward grows tall and shades out
  // anything short. Grasses and sedges are the sward, so they're exempt.
  // Ditches mowed twice a year still grow tall most of the season.
  let sward = 1;
  const swardStrength = L.mow[n] === MOW.never ? 0.85 : L.mow[n] === MOW.periodic ? 0.5 : 0;
  if (swardStrength && sub === SUBSTRATE.soil && p.form !== "grass" && p.form !== "sedge" && !woody) {
    const tall = clamp01(1 - L.disturbance[n] / 0.3) * clamp01((L.light[n] - 0.5) / 0.4);
    const shortness = clamp01(1 - p.height / 0.7);
    sward = 1 - swardStrength * tall * shortness;
  }

  // Conservative species never come back after the plow.
  let history = 1;
  if (L.plowed[n] === 1) {
    if (p.cValue >= 6) history = 0;
    else if (p.cValue >= 4) history = 0.3;
    else if (p.cValue === 3) history = 0.7;
  }

  // Can seed even get here?
  let arrival = 1;
  // Garden escapes: planted on purpose inside the old garden, creeping out from it.
  // Beyond ~50 m from the garden no escape has made it.
  if (p.dispersal === "escape") arrival = L.zone[n] === GARDEN ? 2.5 : L.homestead[n] > 0.03 ? L.homestead[n] : 0;
  else if (p.dispersal === "bird") arrival = 0.15 + 0.85 * L.perch[n];
  else if (p.dispersal === "caching") {
    // Squirrels and jays bury nuts within a few dozen metres of the parent woods.
    const z = GRID.minZ + Math.floor(n / GRID.nx) * GRID.cell;
    arrival = Math.exp(-Math.max(0, SITE.treeline.z0 - z) / 35);
  }

  const total = niche * substrate * mowing * sward * history * arrival;
  return { niche, light, moisture, disturbance, fertility, substrate, mowing, sward, history, arrival, total };
}

export function suitability(p: Plant, L: HabitatLayers, n: number): number {
  return explain(p, L, n).total;
}

/** The single weakest factor, in words — for the field journal and debug HUD. */
export function limitingFactor(f: SuitabilityFactors): string {
  const named: [string, number][] = [
    ["too shady / too sunny", f.light],
    ["wrong moisture", f.moisture],
    ["wrong disturbance", f.disturbance],
    ["wrong fertility", f.fertility],
    ["can't root here", f.substrate],
    ["mowed too often", f.mowing],
    ["shaded out by tall grass", f.sward],
    ["ground was plowed", f.history],
    ["seed can't reach here", f.arrival],
  ];
  named.sort((a, b) => a[1] - b[1]);
  return named[0][0];
}
