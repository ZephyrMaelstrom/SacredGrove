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
}

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
