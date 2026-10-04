/**
 * The Field Journal. Nothing in it is handed to you: a plant gets an entry
 * when you first notice it, a name when you examine it closely or harvest it,
 * and its smell and taste notes only when you test a sample yourself.
 * Tasting is how you learn what's dangerous, which is exactly as risky as it
 * sounds.
 */
import type { Plant, Product } from "../data/plants";

export interface JournalEntry {
  latin: string;
  identified: boolean;
  firstSeenDay: number;
  identifiedDay?: number;
  timesHarvested: number;
  /** Product ids collected at least once. */
  collected: string[];
  /** Zones where you've found it. */
  zones: string[];
  /** Months (1–12) you've harvested it in. */
  months: number[];
  smelled: string[];
  tasted: string[];
  /** Best potency you've taken, by product id. */
  best: Record<string, number>;
  /** Things you learned the hard way. */
  notes: string[];
  /** Effects you've confirmed, by product id (from tasting single-herb brews or customer reports). */
  effects?: Record<string, string[]>;
  /** Effects you suspect (felt in a blend that included this product). */
  suspected?: Record<string, string[]>;
  /** Effects you've seen it fail at. */
  doesnt?: Record<string, string[]>;
}

export type Journal = Record<string, JournalEntry>;

export function entryFor(j: Journal, plant: Plant, day: number): JournalEntry {
  return (j[plant.latin] ??= {
    latin: plant.latin, identified: false, firstSeenDay: day, timesHarvested: 0,
    collected: [], zones: [], months: [], smelled: [], tasted: [], best: {}, notes: [],
  });
}

const addOnce = <T,>(list: T[], v: T) => { if (!list.includes(v)) list.push(v); };

/** Returns true the moment the plant becomes identified. */
export function identify(j: Journal, plant: Plant, day: number, zone: string): boolean {
  const e = entryFor(j, plant, day);
  addOnce(e.zones, zone);
  if (e.identified) return false;
  e.identified = true;
  e.identifiedDay = day;
  return true;
}

export function recordHarvest(j: Journal, plant: Plant, product: Product, day: number, month: number, zone: string, potency: number) {
  const e = entryFor(j, plant, day);
  identify(j, plant, day, zone);
  e.timesHarvested++;
  addOnce(e.collected, product.id);
  addOnce(e.months, month);
  e.best[product.id] = Math.max(e.best[product.id] ?? 0, potency);
}

export function note(j: Journal, plant: Plant, day: number, text: string) {
  addOnce(entryFor(j, plant, day).notes, text);
}

export interface TasteOutcome {
  severity: "none" | "mild" | "sick" | "collapse";
  message: string;
  status?: { id: string; label: string; minutes: number };
}

/** What tasting a sample does to you. */
export function tasteOutcome(product: Product): TasteOutcome {
  const t = product.toxicity;
  if (t >= 9) {
    return {
      severity: "collapse",
      message: "Your mouth goes numb, then your vision tunnels. You wake at home the next morning, empty-handed and lucky.",
      status: { id: "recovering", label: "Recovering", minutes: 1440 },
    };
  }
  if (t >= 5) {
    return {
      severity: "sick",
      message: "Bitter, then burning. Your stomach turns. You'll be sick for a few hours.",
      status: { id: "nauseous", label: "Nauseous", minutes: 180 },
    };
  }
  if (t >= 3) {
    return {
      severity: "mild",
      message: "Unpleasant. Your stomach complains for a while.",
      status: { id: "upset", label: "Upset stomach", minutes: 60 },
    };
  }
  return { severity: "none", message: product.taste ? `Taste: ${product.taste}.` : "Not much flavor." };
}

export function recordTaste(j: Journal, plant: Plant, product: Product, day: number, outcome: TasteOutcome) {
  const e = entryFor(j, plant, day);
  addOnce(e.tasted, product.id);
  if (outcome.severity === "collapse") addOnce(e.notes, `${product.name}: deadly. Never taste it.`);
  else if (outcome.severity === "sick") addOnce(e.notes, `${product.name}: toxic. Made me sick.`);
  else if (outcome.severity === "mild") addOnce(e.notes, `${product.name}: mildly toxic.`);
}

export function recordSmell(j: Journal, plant: Plant, product: Product, day: number) {
  addOnce(entryFor(j, plant, day).smelled, product.id);
}

/** Record what you learned about a product's effects. */
export function learnEffect(j: Journal, plant: Plant, productId: string, tag: string, day: number, how: "confirmed" | "suspected" | "doesnt") {
  const e = entryFor(j, plant, day);
  const field = how === "confirmed" ? "effects" : how;
  const map = (e[field] ??= {});
  const list = (map[productId] ??= []);
  addOnce(list, tag);
  if (how === "confirmed") {
    // Confirmed beats suspected / disproved.
    if (e.suspected?.[productId]) e.suspected[productId] = e.suspected[productId].filter((t) => t !== tag);
    if (e.doesnt?.[productId]) e.doesnt[productId] = e.doesnt[productId].filter((t) => t !== tag);
  }
}

export interface Protocol {
  key: string;
  name: string;
  method: string;
  ingredients: { productId: string; name: string; share: number }[];
  waterMl: number;
  minutes: number;
  covered: boolean;
  /** Best result known for each effect (player-known only). */
  best: Record<string, number>;
  made: number;
  notes: string[];
}
