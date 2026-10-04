/**
 * Things you can carry and store.
 *
 *   HerbLot  — harvested plant material: fresh, then dried (or moldy/spoiled).
 *              Moisture falls as it dries; potency falls with time, heat and
 *              bad storage. Dried material can be ground in the mortar.
 *   PrepItem — something made at the apothecary bench (an infusion, a
 *              decoction): a liquid with effects, a flavor and a shelf life.
 *   StockItem — living material for the garden: a seed packet (collected
 *              with the seed envelope) or a division (a clump lifted with the
 *              trowel). Viability falls with age and bad storage; native
 *              perennial seed needs a cold, damp winter (or the root cellar)
 *              before it will come up.
 */
export type HerbState = "fresh" | "dried" | "moldy" | "spoiled";

export interface HerbLot {
  kind?: "herb"; // absent on saves from before M6
  id: string;
  latin: string;
  productId: string;
  productName: string;
  part: string;
  grams: number;
  /** 0–100. For seeds: viability. */
  potency: number;
  harvestedDay: number;
  /** Water content 0–1 (fresh leaves ~0.8, dried < 0.12). */
  moisture: number;
  state: HerbState;
  /** Accumulated mold risk; 1 = moldy. */
  mold: number;
  /** Grind fineness 0–1 (0 = whole). */
  ground: number;
  /** Last absolute day this lot was simulated. */
  updatedDay: number;
}

export type Method = "hot" | "cold" | "decoction";
export const METHOD_NAMES: Record<Method, string> = { hot: "Hot infusion", cold: "Cold infusion", decoction: "Decoction" };

export interface Flavor {
  bitter: number;
  astringent: number;
  sweet: number;
  sour: number;
  aroma: number;
  slimy: number;
}

export interface PrepItem {
  kind: "prep";
  id: string;
  name: string;
  method: Method;
  volumeMl: number;
  /** Effect strengths 0–1 per cup, by effect tag. */
  effects: Record<string, number>;
  flavor: Flavor;
  /** 0–1: how harmful a cup is. */
  toxicity: number;
  madeDay: number;
  /** Absolute day it turns (water-based preparations don't keep). */
  spoilDay: number;
  ingredients: { productId: string; latin: string; name: string; grams: number }[];
  /** What it looks and smells like. */
  description: string;
  /** Identifies the recipe (ingredients + method) for the journal. */
  protocol: string;
  /** Tasted or reported on, so its effects are known to the player. */
  known: boolean;
  spoiled?: boolean;
  /** How it was made (for the journal's protocol). */
  brewed?: { waterMl: number; minutes: number; covered: boolean };
}

export interface StockItem {
  kind: "stock";
  id: string;
  form: "seed" | "division";
  latin: string;
  /** Plant name (shown once the plant is identified). */
  name: string;
  /** Seeds in the packet, or 1 for a division. */
  count: number;
  /** 0–100: chance a seed comes up / a division takes. */
  viability: number;
  /** Days of cold, damp chilling banked so far (stratification). */
  chill: number;
  collectedDay: number;
  updatedDay: number;
  /** Written on (the old owner's packets): you know what's in it. */
  labeled?: boolean;
}

export type Item = HerbLot | PrepItem | StockItem;

export const isPrep = (i: Item): i is PrepItem => i.kind === "prep";
export const isStock = (i: Item): i is StockItem => i.kind === "stock";
export const isHerb = (i: Item): i is HerbLot => i.kind === undefined || i.kind === "herb";
export const itemGrams = (i: Item) => (isPrep(i) ? i.volumeMl : isStock(i) ? (i.form === "division" ? 150 : Math.max(1, Math.round(i.count / 200))) : i.grams);
/** A cup is 250 ml; a cup that steamed down a little still counts. */
export const CUP_ML = 250;
export const FULL_CUP_ML = 225;
export const servings = (p: PrepItem) => Math.max(1, Math.floor((p.volumeMl + CUP_ML - FULL_CUP_ML) / CUP_ML));

/** Water content of freshly harvested material, by part. */
export const FRESH_MOISTURE: Record<string, number> = {
  Leaf: 0.8, Flower: 0.78, Whole: 0.75, Shoot: 0.85, Pad: 0.9, Fruit: 0.85, Seed: 0.15,
  Root: 0.72, Rhizome: 0.7, Bulb: 0.8, Tuber: 0.78, Bark: 0.45, Twig: 0.45, Sap: 0.98,
  Resin: 0.1, "Fruiting body": 0.9, Exudate: 0.5,
};
export const DRY_BELOW = 0.12;

let counter = 0;
export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** Fill in fields older saves didn't have. */
export function upgradeLot(l: Partial<HerbLot> & { id: string }, day: number): HerbLot {
  const part = l.part ?? "Leaf";
  return {
    kind: "herb",
    latin: "", productId: "", productName: "", grams: 0, potency: 50, harvestedDay: day,
    ...l,
    part,
    moisture: l.moisture ?? FRESH_MOISTURE[part] ?? 0.7,
    state: l.state ?? "fresh",
    mold: l.mold ?? 0,
    ground: l.ground ?? 0,
    updatedDay: l.updatedDay ?? l.harvestedDay ?? day,
  } as HerbLot;
}
