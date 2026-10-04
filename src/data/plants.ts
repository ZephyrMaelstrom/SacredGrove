/**
 * Typed access to the plant database (generated from the workbook by
 * `npm run data`; never edit plants.gen.json by hand).
 */
import raw from "./plants.gen.json";

export type GrowthForm =
  | "rosette" | "mat" | "forb" | "tallForb" | "grass" | "sedge" | "bulb" | "vine"
  | "cane" | "horsetail" | "fungus" | "fungusBracket" | "shrub" | "tree";
export type LifeCycle = "winterAnnual" | "summerAnnual" | "biennial" | "perennial" | "woody" | "fungus";
export type WinterForm = "none" | "rosette" | "mat" | "standing" | "clump" | "evergreen" | "bare";
export type Crown = "spreading" | "upright" | "conifer" | "vase" | "multistem" | "arching";
export type Origin = "native" | "introduced" | "invasive" | "escape";
export type Dispersal = "wind" | "bird" | "animal" | "caching" | "gravity" | "rhizome" | "ballistic" | "escape" | "spores";
export type Host = "soil" | "soilOrGravel" | "wood";
export type FlowerShape = "cluster" | "umbel" | "plume" | "spike" | "daisy" | "globe" | "bell";

export interface Product {
  id: string;
  name: string;
  tier: "Base" | "Workhorse" | "Rare Active";
  biome: string;
  part: string;
  /** Harvest window in months (1–12); start > end wraps the new year. */
  harvest: [number, number];
  seedMonth: number | null;
  compounds: { code: string; str: number }[];
  toxicity: number;
  taste: string;
  smell: string;
  use: string;
  rarity: number;
  basePrice: number;
  shelfLifeDays: number;
  /** What a preparation of it does, 0–1 by effect tag (hidden from the player until learned). */
  effects: Partial<Record<EffectTag, number>>;
  /** Raw is harmful: must be cooked (simmered) first. */
  cookOnly: boolean;
}

export const EFFECT_TAGS = [
  "sleep", "calm", "digestion", "cough", "fever", "wound", "skin", "pain", "immunity", "stamina",
  "kidney", "flavor", "food", "dye", "repellent", "toxic",
] as const;
export type EffectTag = (typeof EFFECT_TAGS)[number];
export const EFFECT_WORDS: Record<EffectTag, string> = {
  sleep: "sleep", calm: "calming", digestion: "digestion", cough: "cough & throat", fever: "fever", wound: "wounds & bleeding",
  skin: "skin & rashes", pain: "pain", immunity: "colds & infection", stamina: "strength & stamina", kidney: "kidneys",
  flavor: "flavor", food: "food", dye: "dye", repellent: "pest repellent", toxic: "toxic",
};

export interface Plant {
  latin: string;
  name: string;
  maps: number[];
  form: GrowthForm;
  cycle: LifeCycle;
  height: number;
  colors: { leaf: string; flower: string; dormant: string };
  phenology: {
    greenUp: number;
    flowerStart: number;
    flowerEnd: number;
    fruitRipe: number;
    dieback: number;
    winterForm: WinterForm;
  };
  crown: Crown | null;
  /** [optimum, tolerance] for each habitat layer. */
  niche: {
    light: [number, number];
    moisture: [number, number];
    disturbance: [number, number];
    fertility: [number, number];
  };
  mowTolerance: number;
  cValue: number;
  origin: Origin;
  dispersal: Dispersal;
  patchScale: number;
  abundance: number;
  host: Host;
  flowerShape: FlowerShape;
  notes: string;
  products: Product[];
}

/**
 * All plants, sorted by Latin name. A plant's array index is used inside a
 * single session (instance buffers, worker messages); anything saved to disk
 * must store `latin` instead, because the index shifts when plants are added.
 */
export const PLANTS: readonly Plant[] = (raw as unknown as { plants: Plant[] }).plants;

export const PLANT_INDEX: ReadonlyMap<string, number> = new Map(PLANTS.map((p, i) => [p.latin, i]));

export function plantByLatin(latin: string): Plant {
  const i = PLANT_INDEX.get(latin);
  if (i === undefined) throw new Error(`Unknown plant: ${latin}`);
  return PLANTS[i];
}

/** Trees and shrubs: placed sparsely, rendered map-wide. Everything else streams in near the player. */
export const isWoody = (p: Plant) => p.form === "tree" || p.form === "shrub";
export const onMap = (p: Plant, map: number) => p.maps.includes(map);
