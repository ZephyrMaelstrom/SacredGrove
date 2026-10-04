/**
 * M5 — Foraging rules: which tool takes which part, whether a part is there
 * to take today, how much you get, and how good it is.
 *
 * Pure TypeScript: the same rules serve desktop clicks, VR hands and tests.
 */
import type { Plant, Product } from "../data/plants";
import { daysFrom, adjustedPhenology, type Appearance } from "../sim/phenology";
import type { SeasonAdjust } from "../time/season";
import { monthOf, isPrecipitating, isFoggy, type DayWeather } from "../time/climate";
import { rng, mixSeed } from "../sim/random";

export type Tool = "hand" | "knife" | "trowel";
export const TOOLS: Tool[] = ["hand", "knife", "trowel"];
export const TOOL_NAMES: Record<Tool, string> = { hand: "Hands", knife: "Knife", trowel: "Trowel" };

const DIG_PARTS = new Set(["Root", "Rhizome", "Bulb", "Tuber"]);
const CUT_PARTS = new Set(["Bark", "Twig", "Sap", "Resin"]);
/** Which part a tool reaches for first when several are ready. */
const PRIORITY: Record<Tool, string[]> = {
  hand: ["Flower", "Fruit", "Fruiting body", "Seed", "Leaf", "Shoot", "Pad", "Exudate", "Whole"],
  knife: ["Sap", "Resin", "Bark", "Twig", "Whole", "Flower", "Fruit", "Fruiting body", "Seed", "Leaf", "Shoot", "Pad"],
  trowel: ["Root", "Rhizome", "Bulb", "Tuber"],
};

const isWoodyPlant = (p: Plant) => p.form === "tree" || p.form === "shrub";

/** The tool a part needs. Knives can do anything hands can, more cleanly. */
export function toolFor(part: string, plant: Plant): Tool {
  if (DIG_PARTS.has(part)) return "trowel";
  if (CUT_PARTS.has(part)) return "knife";
  if (part === "Whole" && plant.height > 0.5 && plant.form !== "mat") return "knife";
  return "hand";
}
export function toolCanTake(tool: Tool, part: string, plant: Plant): boolean {
  const need = toolFor(part, plant);
  return need === tool || (tool === "knife" && need === "hand");
}

/** Month (1–12) inside a product's harvest window? Windows can wrap the new year. */
export function inHarvestMonths(product: Product, doy: number): boolean {
  const m = monthOf(doy) + 1;
  const [a, b] = product.harvest;
  return a <= b ? m >= a && m <= b : m >= a || m <= b;
}

export interface PlantContext {
  plant: Plant;
  look: Appearance;
  doy: number;
  season: SeasonAdjust;
  /** Biennial cohort: 0 = first-year rosette (best roots). */
  cohort: number;
}

/** Is this part physically on the plant today? */
export function partPresent(part: string, c: PlantContext): boolean {
  const { plant, look, doy } = c;
  const v = look.visual;
  if (!v) return false;
  const woody = isWoodyPlant(plant);
  const ph = adjustedPhenology(plant, c.season);
  switch (part) {
    case "Leaf":
    case "Shoot":
    case "Pad":
      return look.leafy && v !== "standing" && v !== "dormantClump" && v !== "bare" && !look.frostKilled;
    case "Whole":
      return v !== "bare";
    case "Flower":
      return look.stage === "flowering";
    case "Fruit": {
      if (look.fruitFailed || ph.fruitFailed) return false;
      if (look.stage === "fruiting") return true;
      // Persistent fruit: hips, haws, persimmons and sumac hang on well into winter.
      const since = daysFrom(ph.fruitRipe, doy);
      return since <= 75 && (v === "standing" || v === "bare" || v === "senescent" || v === "vegetative") && daysFrom(ph.flowerEnd, doy) < 250;
    }
    case "Seed":
      return look.stage === "fruiting" || (v === "standing" && daysFrom(ph.flowerEnd, doy) < 150);
    case "Fruiting body":
      return true;
    case "Bark":
    case "Twig":
    case "Resin":
      return true;
    case "Sap":
      return woody ? true : look.leafy && v !== "standing";
    case "Exudate":
      return true;
    default: // Root, Rhizome, Bulb, Tuber: dig it if you can find the plant
      return true;
  }
}

export type Pick =
  | { ok: true; product: Product }
  | { ok: false; reason: string };

/** What a tool would take from this plant right now, or why it can't. */
export function choose(tool: Tool, c: PlantContext): Pick {
  const products = c.plant.products;
  const ready = products.filter((pr) => partPresent(pr.part, c) && (pr.part !== "Sap" || !isWoodyPlant(c.plant) || inHarvestMonths(pr, c.doy)));
  for (const part of PRIORITY[tool]) {
    const hit = ready.find((pr) => pr.part === part && toolCanTake(tool, part, c.plant));
    if (hit) return { ok: true, product: hit };
  }
  // Explain why not.
  const otherTool = ready.find((pr) => !toolCanTake(tool, pr.part, c.plant));
  if (otherTool) {
    const need = toolFor(otherTool.part, c.plant);
    return { ok: false, reason: `Use the ${TOOL_NAMES[need].toLowerCase()} for ${otherTool.name} (${otherTool.part.toLowerCase()}).` };
  }
  const WHEN: Record<string, string> = {
    Flower: "when it flowers", Fruit: "when the fruit ripens", Seed: "when it sets seed", Leaf: "when it's in leaf",
    Whole: "in its season", Sap: "when the sap runs in late winter", "Fruiting body": "when it fruits after rain",
  };
  const hints = [...new Set(products.map((p) => WHEN[p.part] ?? `for its ${p.part.toLowerCase()}`))].join(", or ");
  return { ok: false, reason: `Nothing to take from ${c.plant.name} right now. Come back ${hints}.` };
}

// -------------------------------------------------------------- quality

export interface HarvestConditions {
  weather: DayWeather;
  minutes: number;
  /** 0–1 habitat suitability where the plant grows. */
  suitability: number;
  tool: Tool;
  /** Deterministic jitter seed (instance index + day). */
  seed: number;
  /** Instance scale from placement (bigger plants yield more). */
  scale: number;
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const signedDays = (from: number, to: number) => ((to - from + 182 + 365 * 2) % 365) - 182;

/** How well the plant's stage today suits this part (0–1). */
export function stageFit(product: Product, c: PlantContext): number {
  const { look, doy, plant } = c;
  const ph = adjustedPhenology(plant, c.season);
  switch (product.part) {
    case "Flower": {
      const span = Math.max(1, daysFrom(ph.flowerStart, ph.flowerEnd));
      const x = daysFrom(ph.flowerStart, doy) / span;
      return 0.72 + 0.28 * Math.sin(Math.PI * clamp(x, 0, 1)); // best mid-bloom
    }
    case "Leaf":
    case "Shoot":
    case "Pad":
      return { emerging: 0.95, vegetative: 1, flowering: 0.85, fruiting: 0.65, senescent: 0.35, winter: 0.8 }[look.stage as string] ?? 0.7;
    case "Root":
    case "Rhizome":
    case "Bulb":
    case "Tuber": {
      // Roots store the most in fall and winter; bolting biennials go woody.
      if (plant.cycle === "biennial" && c.cohort === 1 && look.stage !== "winter") return 0.4;
      return { winter: 1, senescent: 1, fruiting: 0.9, emerging: 0.6, vegetative: 0.75, flowering: 0.55 }[look.stage as string] ?? 0.7;
    }
    case "Fruit": {
      const d = signedDays(ph.fruitRipe, doy);
      if (d < -25) return 0.35; // green, hard, sometimes dangerous
      if (d < -5) return 0.7;
      if (d <= 30) return 1;
      return 0.85;
    }
    case "Seed":
      return product.seedMonth && monthOf(doy) + 1 === product.seedMonth ? 1 : look.stage === "fruiting" ? 0.85 : 0.7;
    case "Whole":
      if (look.visual === "standing" || look.visual === "dormantClump") return plant.form === "grass" ? 0.9 : 0.4;
      return look.stage === "senescent" ? 0.45 : 0.95;
    case "Bark":
      return look.leafy ? 0.8 : 1;
    default:
      return 1;
  }
}

/** Is this fruit still green? (Matters: unripe mayapple is toxic.) */
export function isUnripe(product: Product, c: PlantContext): boolean {
  if (product.part !== "Fruit") return false;
  return signedDays(adjustedPhenology(c.plant, c.season).fruitRipe, c.doy) < -25;
}

export function potency(product: Product, c: PlantContext, h: HarvestConditions): number {
  let q = stageFit(product, c);
  q *= inHarvestMonths(product, c.doy) ? 1 : 0.6;
  q *= 0.65 + 0.35 * Math.sqrt(clamp(h.suitability / 0.6, 0, 1));
  const delicate = product.part === "Flower" || product.part === "Leaf" || product.part === "Whole";
  if (delicate) {
    if (isPrecipitating(h.weather, h.minutes)) q *= 0.85; // wet herbs mold in the drying rack
    else if (isFoggy(h.weather, h.minutes)) q *= 0.9;
    else if (h.minutes < 9 * 60) q *= 0.93; // dew still on them
    const aromatic = product.compounds.some((cp) => cp.code === "VOL");
    if (aromatic && h.weather.cloud < 0.5 && h.minutes >= 11 * 60 && h.minutes <= 16 * 60 && !isPrecipitating(h.weather, h.minutes)) q *= 1.05;
    if (h.tool === "knife") q *= 1.03; // clean cut, no bruising
  }
  const r = rng(h.seed);
  q *= 0.96 + 0.08 * r();
  return Math.round(clamp(q * 100, 5, 100));
}

/** Grams you take in one harvest. */
export function yieldGrams(product: Product, c: PlantContext, h: HarvestConditions): number {
  const size = clamp(c.plant.height * c.look.growth * h.scale, 0.05, 3);
  const woody = isWoodyPlant(c.plant);
  let g: number;
  switch (product.part) {
    case "Leaf": g = 6 + 25 * size; break;
    case "Flower": g = 3 + 10 * size; break;
    case "Fruit": g = woody ? 60 + 40 * h.scale : 8 + 20 * size; break;
    case "Seed": g = woody ? 120 : 2 + 6 * size; break;
    case "Whole": g = 10 + 60 * size; break;
    case "Root": g = 20 + 80 * size; break;
    case "Rhizome": g = 15 + 40 * size; break;
    case "Bulb": g = 8; break;
    case "Tuber": g = 30 + 40 * size; break;
    case "Bark": g = 80; break;
    case "Twig": g = 40; break;
    case "Sap": g = woody ? 500 : 3; break;
    case "Resin": g = 10; break;
    case "Fruiting body": g = c.plant.height > 0.2 ? 150 : 20; break;
    default: g = 20;
  }
  const r = rng(mixSeed(h.seed, 0x91e1d));
  return Math.max(1, Math.round(g * (0.85 + 0.3 * r())));
}

/** What happens to the plant when this part is taken. */
export type Effect =
  | { kind: "regrow"; days: number } // leaves: picked over, grow back
  | { kind: "strip" }                // flowers / fruit / seed: gone for this season
  | { kind: "cut" }                  // whole plant cut: back next year
  | { kind: "dig" }                  // root dug: plant gone for years
  | { kind: "wound" }                // bark: tree can't be stripped again for a year
  | { kind: "tap" };                 // sap: once a year

export function effectOf(product: Product, plant: Plant): Effect {
  switch (product.part) {
    case "Leaf": case "Shoot": case "Pad": return { kind: "regrow", days: 14 };
    case "Twig": return { kind: "regrow", days: 30 };
    case "Flower": case "Fruit": case "Seed": case "Exudate": return { kind: "strip" };
    case "Fruiting body": return { kind: "cut" };
    case "Whole": return { kind: "cut" };
    case "Bark": return { kind: "wound" };
    case "Sap": return isWoodyPlant(plant) ? { kind: "tap" } : { kind: "regrow", days: 10 };
    case "Resin": return { kind: "regrow", days: 20 };
    default: return { kind: "dig" };
  }
}

/** Years before a dug plant grows back in the same spot. */
export function recoveryYears(plant: Plant): number {
  if (plant.cycle === "summerAnnual" || plant.cycle === "winterAnnual" || plant.cycle === "biennial") return 1;
  const clonal = plant.dispersal === "rhizome" ? -1 : 0;
  return Math.max(1, 1 + Math.floor(plant.cValue / 2) + clonal);
}

// -------------------------------------------------------------- hazards

export interface Hazard {
  status: string;
  label: string;
  minutes: number;
  message: string;
}

/** What handling a plant bare-handed does to you. Gloves prevent all of it. */
export function contactHazard(plant: Plant, tool: Tool, gloves: boolean, weather: DayWeather, minutes: number): Hazard | null {
  if (gloves || tool === "trowel") return null;
  switch (plant.latin) {
    case "Toxicodendron radicans":
      return { status: "rash", label: "Poison ivy rash", minutes: 3 * 1440, message: "Your hands start to itch. That was poison ivy. Gloves next time." };
    case "Urtica dioica":
      return { status: "sting", label: "Nettle stings", minutes: 60, message: "Nettle! Your fingers burn and tingle." };
    case "Pastinaca sativa": {
      const sunny = weather.cloud < 0.6 && minutes >= 9 * 60 && minutes <= 17 * 60;
      return sunny
        ? { status: "burn", label: "Parsnip sap burn", minutes: 4 * 1440, message: "Wild parsnip sap in the sun — blisters are rising on your wrist." }
        : null;
    }
    case "Rubus allegheniensis":
    case "Rubus occidentalis":
    case "Rosa carolina":
    case "Crataegus mollis":
    case "Solanum carolinense":
    case "Dipsacus fullonum":
      return { status: "scratch", label: "Scratched", minutes: 30, message: "Thorns. A few scratches." };
    default:
      return null;
  }
}
