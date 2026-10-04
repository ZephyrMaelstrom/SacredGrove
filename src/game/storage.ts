/**
 * M6 — Where things are kept, and what time does to them there.
 *
 *   basket   carried around: fresh herbs wilt in the sun
 *   loft     the barn hayloft: bundles hang to dry. Airflow (vent door open
 *            or shut), the day's humidity, crowding and attic heat decide
 *            whether they dry green and fragrant, cook, or mold
 *   cellar   under the house: cool, dark, damp. Roots, tubers, bulbs and
 *            fruit keep for months; leaves and flowers rot; dried herbs pick
 *            up moisture
 *   tack     the tack room's seed catalog: dry and steady; seeds hold their
 *            viability; other dried goods keep well
 *   shelf    the apothecary's jar shelf: sealed jars keep dried herbs best;
 *            finished preparations wait here
 *   stand    the roadside stand: sun and dust; fresh things wilt fast
 *
 * One call to `stepDay` per item per day. Pure TypeScript, tested.
 */
import type { DayWeather } from "../time/climate";
import { PLANTS } from "../data/plants";
import { stepStock } from "./garden";
import { DRY_BELOW, isPrep, isStock, type HerbLot, type Item, type PrepItem } from "./items";

export type PlaceId = "basket" | "loft" | "cellar" | "tack" | "shelf" | "stand";
export const STORAGE_PLACES: Exclude<PlaceId, "basket">[] = ["loft", "cellar", "tack", "shelf", "stand"];

export interface PlaceSpec {
  name: string;
  slots: number;
  /** Largest lot a slot takes (g); bigger lots are split when stored. */
  maxGrams: number;
  /** Things that may go here. */
  accepts: (i: Item) => boolean;
  hint: string;
}

const herbOnly = (i: Item) => !isPrep(i);
export const PLACES: Record<Exclude<PlaceId, "basket">, PlaceSpec> = {
  loft: { name: "Drying loft", slots: 24, maxGrams: 600, accepts: herbOnly, hint: "Hang bundles to dry. Open the vent on dry days; close it in the rain." },
  cellar: { name: "Root cellar", slots: 16, maxGrams: 3000, accepts: () => true, hint: "Cool and damp: roots, tubers, bulbs, fruit and finished brews keep here." },
  tack: { name: "Seed catalog", slots: 40, maxGrams: 1000, accepts: herbOnly, hint: "Dry and steady: seeds keep their viability; dried goods keep well." },
  shelf: { name: "Jar shelf", slots: 30, maxGrams: 2000, accepts: () => true, hint: "Sealed jars: the best place for dried herbs and finished preparations." },
  stand: { name: "Roadside stand", slots: 8, maxGrams: 2000, accepts: () => true, hint: "Whatever's here is for sale to passers-by at about 60% of its value." },
};

export interface PlaceConditions {
  humidity: number; // 0–1
  airflow: number; // 0–1
  tempF: number;
  /** How full the place is, 0–1 (crowded racks mold). */
  crowding: number;
  sealed: boolean;
  /** Drying happens here (loft racks; slower anywhere else). */
  drying: boolean;
}

/** The day's outdoor humidity from the weather. */
export function humidityOf(w: DayWeather): number {
  switch (w.condition) {
    case "storm":
    case "rain": return 0.92;
    case "snow": return 0.8;
    case "fog": return 0.86;
    case "overcast": return 0.68;
    case "partly": return 0.56;
    default: return 0.46;
  }
}

export function conditions(place: PlaceId, w: DayWeather, opts: { ventOpen: boolean; crowding: number; doy: number }): PlaceConditions {
  const outside = humidityOf(w);
  const mean = (w.highF + w.lowF) / 2;
  switch (place) {
    case "loft": {
      const wetDay = w.precipMm > 0;
      return {
        // An open vent lets the day's air through: great when it's dry, bad in the rain.
        humidity: opts.ventOpen ? Math.min(0.98, outside + (wetDay ? 0.06 : -0.04)) : 0.35 + outside * 0.45,
        airflow: opts.ventOpen ? 0.95 : 0.45,
        tempF: w.highF + 8, // attic heat
        crowding: opts.crowding,
        sealed: false,
        drying: true,
      };
    }
    case "cellar": {
      // Earth-tempered: mid-40s in winter, low 60s by late summer.
      const t = 53 + 9 * Math.sin(((opts.doy - 130) / 365) * 2 * Math.PI);
      return { humidity: 0.88, airflow: 0.15, tempF: t, crowding: opts.crowding, sealed: false, drying: false };
    }
    case "tack":
      return { humidity: 0.42, airflow: 0.3, tempF: Math.max(45, Math.min(80, mean)), crowding: 0, sealed: false, drying: false };
    case "shelf":
      return { humidity: 0.5, airflow: 0.3, tempF: Math.max(45, Math.min(85, mean + 4)), crowding: 0, sealed: true, drying: false };
    case "stand":
      return { humidity: outside, airflow: 0.6, tempF: w.highF + 4, crowding: 0, sealed: false, drying: false };
    default: // basket
      return { humidity: outside, airflow: 0.5, tempF: w.highF, crowding: 0, sealed: false, drying: false };
  }
}

// ---------------------------------------------------------------- rates

/** How fast a part dries (per day, at full airflow and dry air). */
const DRY_RATE: Record<string, number> = {
  Leaf: 0.55, Flower: 0.5, Whole: 0.42, Shoot: 0.35, Seed: 0.35, Fruit: 0.12, Root: 0.18, Rhizome: 0.18,
  Bulb: 0.07, Tuber: 0.06, Bark: 0.35, Twig: 0.3, Resin: 0.5, Sap: 0, "Fruiting body": 0.35, Pad: 0.05, Exudate: 0.4,
};
/** Fraction of potency lost per day while still fresh (at 60 °F). */
const FRESH_LOSS: Record<string, number> = {
  Leaf: 0.06, Flower: 0.08, Whole: 0.06, Shoot: 0.1, Seed: 0.004, Fruit: 0.05, Root: 0.015, Rhizome: 0.015,
  Bulb: 0.01, Tuber: 0.01, Bark: 0.01, Twig: 0.01, Resin: 0.002, Sap: 0.15, "Fruiting body": 0.2, Pad: 0.03, Exudate: 0.01,
};
/** Parts the cellar keeps (slows fresh loss ×0.2). */
const CELLAR_KEEPERS = new Set(["Root", "Rhizome", "Bulb", "Tuber", "Fruit"]);

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const productOf = (lot: HerbLot) => PLANTS.find((p) => p.latin === lot.latin)?.products.find((p) => p.id === lot.productId);
const aromatic = (lot: HerbLot) => !!productOf(lot)?.compounds.some((c) => c.code === "VOL");

/** Days a dried lot keeps (it loses about 40% over this span in fair storage). */
export function driedLife(lot: HerbLot): number {
  return Math.min(900, Math.max(120, (productOf(lot)?.shelfLifeDays ?? 45) * 8));
}

/** One day passes for a herb lot in a place. Returns a short note when something notable happens. */
export function stepHerb(lot: HerbLot, place: PlaceId, c: PlaceConditions): string | null {
  if (lot.state === "moldy" || lot.state === "spoiled") return null;
  const part = lot.part;
  const heat = clamp(1 + (c.tempF - 60) / 40, 0.4, 2.2);
  let note: string | null = null;
  const loss = (f: number) => { lot.potency = Math.max(0, lot.potency * (1 - f)); };

  if (lot.state === "fresh") {
    // Drying: exponential approach to dry, driven by airflow and dry air.
    const rate = (DRY_RATE[part] ?? 0.3) * (c.drying ? 1 : 0.25) * c.airflow * clamp(1.15 - c.humidity, 0.05, 1) * (lot.ground > 0 ? 1.6 : 1);
    lot.moisture = Math.max(0.04, lot.moisture * Math.exp(-rate));

    // Fresh material loses potency until it's dry (slowly on the racks, fast in a hot basket).
    let f = (FRESH_LOSS[part] ?? 0.05) * heat;
    if (place === "cellar" && CELLAR_KEEPERS.has(part)) f *= 0.2;
    if (c.drying) f = Math.min(f, 0.025); // drying fixes the leaf before it can wilt away
    if (place === "stand" || place === "basket") f *= 1.3;
    loss(f);

    // Mold: damp air, wet material, crowding. Leaves and flowers rot in the cellar;
    // whole roots, bulbs and fruit are what a cellar is for (skins intact, cold),
    // so they rot only slowly there.
    const keeper = place === "cellar" && CELLAR_KEEPERS.has(part);
    const damp = Math.max(0, c.humidity - 0.62) * lot.moisture * (0.6 + 0.8 * c.crowding) * (keeper ? 0.03 : 1);
    const cellarRot = place === "cellar" && !CELLAR_KEEPERS.has(part) ? 0.25 : 0;
    lot.mold += damp * 1.6 + cellarRot;
    if (c.humidity < 0.6) lot.mold *= 0.85;

    if (lot.mold >= 1) {
      lot.state = "moldy";
      lot.potency = 0;
      return `${lot.productName} went moldy.`;
    }
    if (lot.moisture < DRY_BELOW) {
      lot.state = "dried";
      note = `${lot.productName} is dry.`;
    } else if (lot.potency < 10) {
      lot.state = "spoiled";
      lot.potency = 0;
      return `${lot.productName} has wilted past using.`;
    }
  } else {
    // Dried: slow decline; jars are best. The workbook's shelf life is for the
    // fresh product; dried material keeps several times longer (a year for
    // most leaves and flowers, longer for roots and bark).
    const shelf = driedLife(lot);
    let f = 0.5 / shelf;
    if (c.sealed) f *= 0.7;
    if (place === "loft" || place === "stand") f *= 1.5; // light and dust
    if (lot.ground > 0) f *= 1.8; // powder goes stale faster
    if (place === "tack" && part === "Seed") f *= 0.5;
    loss(f * heat);
    // Damp places put water back into dried herbs.
    if (!c.sealed && c.humidity > 0.75) {
      lot.moisture = Math.min(0.5, lot.moisture + 0.015 * (c.humidity - 0.7) * 10);
      if (lot.moisture > 0.2) {
        lot.mold += (c.humidity - 0.7) * lot.moisture;
        if (lot.mold >= 1) {
          lot.state = "moldy";
          lot.potency = 0;
          return `${lot.productName} took on damp and molded.`;
        }
      }
    }
  }
  // Attic heat drives off volatile oils.
  if (c.tempF > 88 && aromatic(lot)) loss(0.01 * ((c.tempF - 88) / 10 + 1));
  return note;
}

/** Water-based preparations turn sour in a couple of days; the cellar buys a few more. */
export function stepPrep(p: PrepItem, place: PlaceId, c: PlaceConditions, day: number): string | null {
  if (p.spoiled) return null;
  const life = (place === "cellar" ? 6 : place === "stand" ? 1.5 : 2.5) - (c.tempF > 80 ? 0.5 : 0);
  if (day - p.madeDay >= life) {
    p.spoiled = true;
    return `${p.name} has turned sour.`;
  }
  return null;
}

/** Simulate every day since each item was last updated. */
export function stepItems(items: Item[], place: PlaceId, weatherOn: (absDay: number) => { w: DayWeather; doy: number }, today: number, opts: { ventOpen: boolean; slots: number }): string[] {
  const notes: string[] = [];
  const crowding = opts.slots > 0 ? Math.min(1, items.length / opts.slots) : 0;
  for (const it of items) {
    if (isPrep(it)) {
      const { w, doy } = weatherOn(today);
      const n = stepPrep(it, place, conditions(place, w, { ventOpen: opts.ventOpen, crowding, doy }), today);
      if (n) notes.push(n);
      continue;
    }
    while (it.updatedDay < today) {
      it.updatedDay++;
      const { w, doy } = weatherOn(it.updatedDay);
      const c = conditions(place, w, { ventOpen: opts.ventOpen, crowding, doy });
      const n = isStock(it) ? stepStock(it, place, conditions("cellar", w, { ventOpen: true, crowding: 0, doy }).tempF, (w.highF + w.lowF) / 2) : stepHerb(it, place, c);
      if (n) notes.push(n);
    }
  }
  return notes;
}

/** Can this item go into this place, and is there room? */
export function canStore(items: Item[], place: Exclude<PlaceId, "basket">, item: Item): string | null {
  const spec = PLACES[place];
  if (!spec.accepts(item)) return `The ${spec.name.toLowerCase()} is for plant material only.`;
  if (items.length >= spec.slots) return `The ${spec.name.toLowerCase()} is full.`;
  return null;
}

/** How a lot looks right now, in words. */
export function herbCondition(l: HerbLot): string {
  if (l.state === "moldy") return "moldy";
  if (l.state === "spoiled") return "spoiled";
  if (l.state === "dried") return l.ground > 0 ? (l.ground > 0.8 ? "fine powder" : "coarsely ground") : l.moisture > 0.18 ? "dried, gone limp with damp" : "dried";
  if (l.moisture > 0.6) return "fresh";
  if (l.moisture > 0.3) return "wilting / half-dry";
  return "nearly dry";
}
