/**
 * M8 — The garden: four raised beds east of the house, six planting spots
 * each.
 *
 * What you plant comes from the land: seed collected with the envelope, or
 * divisions lifted with the trowel (and fresh roots, like horseradish).
 * Each plant follows its own biology from the species data:
 *
 *   Germination  seed needs warm enough soil (cool-season plants come up in
 *                40s °F soil, warm-season ones wait for the 50s–60s) and
 *                moisture. Native perennial seed also needs a cold, damp
 *                winter first (stratification): sow it in fall, or bank the
 *                chill in the root cellar. Spring-sown without it, it never
 *                comes up — and the journal says so.
 *   Growth       driven by warmth, water, weeds and how well the plant suits
 *                full sun and rich bed soil (shade lovers sulk).
 *   Life cycle   annuals flower some weeks after they come up, set seed and
 *                die (frost kills tender ones); biennials make a rosette the
 *                first year and bloom the second; perennials raised from seed
 *                mostly wait a year to bloom; divisions bloom right away.
 *   Care         beds dry out in summer heat (water them); weeds come up all
 *                season (pull them); a drought-stressed plant loses health.
 *
 * Harvesting a garden plant works like the wild one (same tools and parts),
 * with garden vigor: bigger yields, and potency from the plant's health.
 *
 * Pure TypeScript, tested.
 */
import { plantByLatin, type Plant, type Product } from "../data/plants";
import { SITE, heightAt } from "../world/map";
import { appearance, daysFrom, type Appearance, type Cohort } from "../sim/phenology";
import { NEUTRAL_SEASON, type SeasonAdjust } from "../time/season";
import type { DayWeather } from "../time/climate";
import { hashString, mixSeed, rng } from "../sim/random";
import { effectOf } from "./harvest";
import { newId, type HerbLot, type Item, type StockItem } from "./items";

// ---------------------------------------------------------------- where

export const SLOTS_PER_BED = 6;
export const BED_COUNT = SITE.raisedBeds.length;
export const SLOT_COUNT = BED_COUNT * SLOTS_PER_BED;
const COLS = ["A", "B"];

export interface SlotSpot {
  index: number;
  bed: number;
  label: string;
  x: number;
  y: number;
  z: number;
}

/** Every planting spot in the world (bed soil surface). */
export const SLOTS: SlotSpot[] = SITE.raisedBeds.flatMap(([bx, bz], bed) => {
  const top = heightAt(bx, bz) + 0.36;
  return [0, 1, 2].flatMap((row) => [0, 1].map((col) => ({
    index: bed * SLOTS_PER_BED + row * 2 + col,
    bed,
    label: `Bed ${bed + 1}, ${COLS[col]}${row + 1}`,
    x: bx + (col === 0 ? -0.28 : 0.28),
    y: top,
    z: bz + (row - 1) * 1.3,
  })));
});

// ---------------------------------------------------------------- state

export interface Planting {
  id: string;
  latin: string;
  from: "seed" | "division";
  sownDay: number;
  /** Absolute day it came up (or was planted, for divisions). */
  upDay: number | null;
  /** Year it came up: first-year plants are cohort 0. */
  upYear: number | null;
  /** 0–100 chance per seed still alive in the ground. */
  viability: number;
  /** Seeds sown in the spot. */
  seeds: number;
  /** Cold, damp days banked (stratification). */
  chill: number;
  /** 0–1 toward full size. */
  size: number;
  /** 0–1. */
  health: number;
  pickedUntil?: number;
  strippedYear?: number;
  /** Why it died, if it did (the plant stays until you pull it). */
  dead?: string;
  deadDay?: number;
  updatedDay: number;
  /** Planted from a labeled packet: you know what it is. */
  labeled?: boolean;
}

export interface BedState {
  /** Soil moisture 0–1. */
  moisture: number;
  /** Weed cover 0–1. */
  weeds: number;
}

export interface GardenState {
  slots: (Planting | null)[];
  beds: BedState[];
  updatedDay: number;
}

export const emptyGarden = (day: number): GardenState => ({
  slots: Array.from({ length: SLOT_COUNT }, () => null),
  beds: Array.from({ length: BED_COUNT }, () => ({ moisture: 0.55, weeds: 0.15 })),
  updatedDay: day,
});

// ---------------------------------------------------------------- biology

const isAnnual = (p: Plant) => p.cycle === "summerAnnual" || p.cycle === "winterAnnual";

/** Days of cold, damp chilling a plant's seed needs before it will germinate. */
export function chillNeeded(p: Plant): number {
  if (p.origin !== "native") return 0;
  if (p.cycle === "perennial") return p.form === "grass" || p.form === "sedge" ? 30 : 60;
  if (p.cycle === "biennial") return 30;
  return 0;
}

/** Soil temperature window (°F, daily mean) for germination. */
export function germWindow(p: Plant): [number, number] {
  if (p.cycle === "winterAnnual") return [38, 70];
  if (p.cycle === "summerAnnual") return p.phenology.greenUp <= 80 ? [45, 85] : [58, 95];
  return p.phenology.greenUp <= 85 ? [42, 80] : [52, 92];
}

/** Can it go in a garden bed at all? */
export function gardenable(p: Plant): string | null {
  if (p.form === "tree" || p.form === "shrub") return `${p.name} is a woody plant; it won't fit in a raised bed.`;
  if (p.form === "fungus" || p.form === "fungusBracket" || p.cycle === "fungus") return "Fungi don't grow from beds of soil.";
  return null;
}

/** Days from coming up to first flowers, for annuals. */
export function daysToFlower(p: Plant): number {
  return Math.max(40, Math.min(110, daysFrom(p.phenology.greenUp, p.phenology.flowerStart)));
}

const gauss = (v: number, [opt, tol]: [number, number]) => Math.exp(-(((v - opt) / tol) ** 2));
/** How well the plant takes to a raised bed: full sun, rich, loose soil. */
export function bedFit(p: Plant): number {
  return 0.35 + 0.65 * gauss(1.0, p.niche.light) * (0.5 + 0.5 * gauss(0.75, p.niche.fertility));
}

/** Can the plant set viable seed you could collect? */
export function setsSeed(p: Plant): boolean {
  if (gardenable(p)) return false;
  // Sterile hybrids and things the workbook says spread only vegetatively.
  if (p.latin.includes("×")) return false;
  return p.products.some((pr) => pr.seedMonth !== null) || p.dispersal !== "escape";
}

/** Can the trowel lift a living division from it? */
export function divisible(p: Plant): boolean {
  return !gardenable(p) && p.cycle === "perennial";
}

// ---------------------------------------------------------------- planting

export interface Sowable {
  latin: string;
  form: "seed" | "division";
  viability: number;
  chill: number;
}

/** What an item would plant, if anything. */
export function sowable(i: Item): Sowable | null {
  if (i.kind === "stock") return { latin: i.latin, form: i.form, viability: i.viability, chill: i.chill };
  if (i.kind === "prep") return null;
  const lot = i as HerbLot;
  // Fresh roots, rhizomes, bulbs and tubers of perennials can be replanted.
  const plant = plantByLatin(lot.latin);
  if (["Root", "Rhizome", "Bulb", "Tuber"].includes(lot.part) && lot.state === "fresh" && lot.moisture > 0.45 && plant.cycle === "perennial" && lot.grams >= 15) {
    return { latin: lot.latin, form: "division", viability: Math.min(95, lot.potency), chill: 0 };
  }
  return null;
}

export interface GardenResult {
  ok: boolean;
  message: string;
  /** Game minutes the work took. */
  minutes?: number;
}
const fail = (message: string): GardenResult => ({ ok: false, message });

/** Put a seed pinch or a division into an empty spot. Consumes from the item. */
export function plant(g: GardenState, slot: number, item: Item, day: number, year: number): GardenResult {
  if (g.slots[slot]) return fail("Something's already growing there. Pull it first.");
  const s = sowable(item);
  if (!s) return fail("That won't grow. Plant seed, a division, or a fresh root.");
  const p = plantByLatin(s.latin);
  const no = gardenable(p);
  if (no) return fail(no);
  let seeds = 1;
  if (item.kind === "stock") {
    if (item.form === "seed") {
      seeds = Math.min(item.count, 12);
      item.count -= seeds;
    } else item.count -= 1;
  } else {
    (item as HerbLot).grams -= Math.min((item as HerbLot).grams, 30);
  }
  const division = s.form === "division";
  g.slots[slot] = {
    id: newId("plant"),
    latin: s.latin,
    from: s.form,
    sownDay: day,
    upDay: division ? day : null,
    upYear: division ? year : null,
    viability: s.viability,
    seeds,
    chill: s.chill,
    size: division ? 0.45 : 0,
    health: division ? 0.35 + 0.5 * (s.viability / 100) : 1,
    updatedDay: day,
    labeled: item.kind === "stock" ? !!item.labeled : true,
  };
  return { ok: true, message: division ? `You set the ${p.name} division in and firm the soil around it. Water it in.` : `You sow a pinch of ${p.name} seed (${seeds}).`, minutes: division ? 10 : 5 };
}

/** The item is used up after planting? */
export const usedUp = (i: Item) => (i.kind === "stock" ? i.count <= 0 : i.kind !== "prep" && (i as HerbLot).grams <= 0);

export function water(g: GardenState, bed: number): GardenResult {
  const b = g.beds[bed];
  if (!b) return fail("");
  b.moisture = Math.max(b.moisture, 0.95);
  return { ok: true, message: `You water bed ${bed + 1}.`, minutes: 5 };
}

export function weed(g: GardenState, bed: number): GardenResult {
  const b = g.beds[bed];
  if (!b) return fail("");
  const before = b.weeds;
  b.weeds = 0;
  return { ok: true, message: before > 0.05 ? `You weed bed ${bed + 1}.` : `Bed ${bed + 1} is already clean.`, minutes: Math.round(4 + 20 * before) };
}

export function pull(g: GardenState, slot: number): GardenResult {
  const pl = g.slots[slot];
  if (!pl) return fail("");
  g.slots[slot] = null;
  return { ok: true, message: `You pull the ${plantByLatin(pl.latin).name}${pl.dead ? "" : " and toss it on the compost"}.`, minutes: 2 };
}

// ---------------------------------------------------------------- one day

export interface GardenNote {
  text: string;
  /** Something the journal should remember about this plant. */
  learn?: { latin: string; note: string };
}

/** The bed and its plants live through one day of weather. */
export function stepGarden(g: GardenState, day: number, year: number, doy: number, w: DayWeather): GardenNote[] {
  const notes: GardenNote[] = [];
  const mean = (w.highF + w.lowF) / 2;
  const growing = mean > 45;
  for (const [bi, b] of g.beds.entries()) {
    // Water in: rain; water out: drainage and heat (raised beds dry fast).
    b.moisture += w.precipMm / 18;
    const et = mean < 35 ? 0.005 : 0.03 + Math.max(0, w.highF - 60) * 0.0045;
    b.moisture = Math.min(0.95, Math.max(0.02, b.moisture - et));
    // Weeds: all season long, faster when it's warm and wet.
    if (growing) b.weeds = Math.min(1, b.weeds + 0.006 + 0.01 * Math.min(1, (mean - 45) / 30) * (0.5 + b.moisture));
    void bi;
  }

  for (let i = 0; i < g.slots.length; i++) {
    const pl = g.slots[i];
    if (!pl || pl.updatedDay >= day) continue;
    pl.updatedDay = day;
    if (pl.dead) continue;
    const p = plantByLatin(pl.latin);
    const b = g.beds[Math.floor(i / SLOTS_PER_BED)];
    const r = rng(mixSeed(hashString(pl.id), day));

    // ---- seed in the ground
    if (pl.upDay === null) {
      if (mean < 41 && b.moisture > 0.25) pl.chill++;
      const need = chillNeeded(p);
      const [lo, hi] = germWindow(p);
      const soilT = mean + 2; // dark bed soil runs a little warm
      if (pl.chill >= need && soilT >= lo && soilT <= hi && b.moisture >= 0.3) {
        const anyUp = 1 - (1 - pl.viability / 100) ** pl.seeds;
        if (r() < 0.16 * anyUp) {
          pl.upDay = day;
          pl.upYear = year;
          pl.size = 0.04;
          pl.health = 0.9;
          notes.push({ text: `${p.name} is up in ${SLOTS[i].label}.`, learn: { latin: p.latin, note: `Came up ${day - pl.sownDay} days after sowing${need ? ` (after ${pl.chill} cold days)` : ""}.` } });
          continue;
        }
      }
      // Seed slowly rots in the ground, faster when warm and wet.
      pl.viability -= 0.35 + (b.moisture > 0.85 && mean > 60 ? 1 : 0);
      if (pl.viability <= 3) {
        pl.dead = "never came up";
        pl.deadDay = day;
        const why = need && pl.chill < need
          ? `Sown without a winter's cold, it never came up. Native seed like this may need a cold, damp spell first (sow in fall, or keep it in the root cellar over winter).`
          : b.moisture < 0.3 ? "Never came up; the bed was too dry." : "Never came up.";
        notes.push({ text: `The ${p.name} in ${SLOTS[i].label} never came up.`, learn: { latin: p.latin, note: why } });
      }
      continue;
    }

    // ---- frost
    const tender = p.cycle === "summerAnnual";
    // Cool-season seedlings shrug off light freezes; a hard one still kills them.
    const seedlingKill = p.cycle === "winterAnnual" ? -99 : p.phenology.greenUp <= 85 ? 22 : 28;
    if ((tender && w.lowF <= 31) || (pl.size < 0.12 && w.lowF <= seedlingKill)) {
      pl.dead = "killed by frost";
      pl.deadDay = day;
      notes.push({ text: `Frost killed the ${p.name} in ${SLOTS[i].label}.`, learn: tender && doy < 160 ? { latin: p.latin, note: "Tender: a spring frost killed the seedlings. Sow after the last frost." } : undefined });
      continue;
    }

    // ---- life cycle endings
    const age = day - pl.upDay;
    if (isAnnual(p)) {
      const T = daysToFlower(p);
      if (age > T + 90) {
        pl.dead = "went to seed and died back";
        pl.deadDay = day;
        notes.push({ text: `The ${p.name} in ${SLOTS[i].label} has finished; its seed heads are dry.` });
        continue;
      }
    } else if (p.cycle === "biennial" && pl.upYear !== null && year > pl.upYear && doy > p.phenology.dieback && p.phenology.dieback < 366) {
      pl.dead = "flowered in its second year and died, as biennials do";
      pl.deadDay = day;
      notes.push({ text: `The ${p.name} in ${SLOTS[i].label} has finished its two years.` });
      continue;
    }

    // ---- growth
    const look = plantingLook(pl, p, doy, year);
    const dormant = !look || look.stage === "winter" || look.stage === "absent";
    const moist = b.moisture;
    const waterF = moist < 0.12 ? 0 : moist < 0.3 ? (moist - 0.12) / 0.18 : 1;
    if (!dormant) {
      const base = p.phenology.greenUp <= 85 ? 40 : 50;
      const warmth = Math.max(0, Math.min(1.2, (mean - base) / 22));
      const span = isAnnual(p) ? daysToFlower(p) : pl.from === "division" ? 60 : 110;
      const grow = (1 / span) * warmth * waterF * (1 - 0.65 * b.weeds) * bedFit(p) * (0.4 + 0.6 * pl.health);
      pl.size = Math.min(1, pl.size + grow * 1.15);
      // Drought, weeds and a poor fit stress it; good care heals.
      if (moist < 0.12 && mean > 55) pl.health -= 0.07;
      else if (b.weeds > 0.7) pl.health -= 0.01;
      else pl.health += 0.03 * waterF;
      pl.health = Math.min(1, Math.max(0, pl.health));
      if (pl.health <= 0) {
        pl.dead = "dried out";
        pl.deadDay = day;
        notes.push({ text: `The ${p.name} in ${SLOTS[i].label} dried out and died.`, learn: { latin: p.latin, note: "Lost one to drought in a raised bed: they dry out fast in summer heat." } });
      }
    }
  }
  g.updatedDay = day;
  return notes;
}

// ---------------------------------------------------------------- looks

/** How a planting looks today (null: bare soil, nothing showing). */
export function plantingLook(pl: Planting, p: Plant, doy: number, year: number, season: SeasonAdjust = NEUTRAL_SEASON, day?: number): Appearance | null {
  if (pl.upDay === null) return null;
  if (pl.dead) {
    if (pl.dead === "never came up") return null;
    // Dead stalks stand (seed heads to collect from spent annuals).
    return { stage: "senescent", visual: pl.dead.startsWith("went to seed") || pl.dead.startsWith("flowered") ? "standing" : "senescent", growth: Math.max(0.3, pl.size), leafy: false };
  }
  const shrink = (a: Appearance): Appearance => ({ ...a, growth: Math.max(0.15, a.growth * (0.3 + 0.7 * pl.size)) });
  if (isAnnual(p)) {
    // Annuals run on their own clock from the day they came up.
    const age = (day ?? pl.updatedDay) - pl.upDay;
    const T = daysToFlower(p);
    if (age < 14) return shrink({ stage: "emerging", visual: p.form === "grass" ? "vegetative" : "basal", growth: 0.4, leafy: true });
    if (age < T || pl.size < 0.55) return shrink({ stage: "vegetative", visual: "vegetative", growth: Math.min(1, 0.5 + age / T / 2), leafy: true });
    if (age < T + 45) return shrink({ stage: "flowering", visual: "flowering", growth: 1, leafy: true });
    if (age < T + 80) return shrink({ stage: "fruiting", visual: "fruiting", growth: 1, leafy: true });
    return shrink({ stage: "senescent", visual: "senescent", growth: 1, leafy: true });
  }
  const cohort: Cohort = pl.upYear !== null && year > pl.upYear ? 1 : pl.from === "division" ? 1 : 0;
  let a = appearance(p, doy, cohort, season);
  // First-year perennials from seed put their year into roots and leaves.
  if (cohort === 0 && p.cycle === "perennial" && (a.stage === "flowering" || a.stage === "fruiting")) {
    a = { ...a, stage: "vegetative", visual: "vegetative" };
  }
  if (!a.visual) return null;
  if (pl.size < 0.2 && a.visual !== "basal" && a.stage !== "winter") a = { ...a, visual: p.form === "grass" ? "vegetative" : "basal" };
  return shrink(a);
}

/** Words for a planting's state, for the garden panel. */
export function plantingStatus(pl: Planting, p: Plant, doy: number, year: number, day: number): string {
  if (pl.dead) return `dead — ${pl.dead}`;
  if (pl.upDay === null) return `sown ${day - pl.sownDay} day${day - pl.sownDay === 1 ? "" : "s"} ago, nothing up yet`;
  const look = plantingLook(pl, p, doy, year, NEUTRAL_SEASON, day);
  const stage = !look ? "dormant below ground" : look.stage === "winter" ? "dormant for winter" : look.stage === "emerging" ? "seedling" : look.stage === "vegetative" ? (pl.size < 0.5 ? "young plant" : "growing") : look.stage;
  const health = pl.health > 0.75 ? "" : pl.health > 0.4 ? ", a bit stressed" : ", struggling";
  return `${stage}${health}`;
}

// ---------------------------------------------------------------- harvest

/** Can this part be taken from the garden plant today? */
export function gardenBlocked(pl: Planting, product: Product, plantData: Plant, day: number, year: number): string | null {
  if (pl.dead && pl.dead !== "went to seed and died back") return "That plant is dead.";
  const eff = effectOf(product, plantData);
  if (eff.kind === "regrow" && pl.pickedUntil !== undefined && day < pl.pickedUntil) return `Already picked over; give it about ${pl.pickedUntil - day} more days.`;
  if (eff.kind === "strip" && pl.strippedYear === year) return `You've already taken the ${product.part.toLowerCase()} from this one this year.`;
  if (pl.size < 0.3) return "It's too small to harvest yet. Let it grow.";
  return null;
}

/** What harvesting does to a garden plant. Returns true if the plant is gone. */
export function applyGardenHarvest(g: GardenState, slot: number, product: Product, plantData: Plant, day: number, year: number): boolean {
  const pl = g.slots[slot];
  if (!pl) return true;
  const eff = effectOf(product, plantData);
  switch (eff.kind) {
    case "regrow": pl.pickedUntil = day + (eff.days ?? 14) - 4; break; // well-tended plants regrow a little faster
    case "strip": pl.strippedYear = year; break;
    case "cut":
      if (plantData.cycle === "perennial") {
        // Cut back: it regrows from the crown.
        pl.size = Math.max(0.25, pl.size * 0.35);
        pl.pickedUntil = day + 21;
      } else {
        g.slots[slot] = null;
        return true;
      }
      break;
    default:
      g.slots[slot] = null;
      return true;
  }
  return false;
}

// ---------------------------------------------------------------- stock

/** A new seed packet or division. */
export function makeStock(form: "seed" | "division", p: Plant, count: number, viability: number, day: number): StockItem {
  return { kind: "stock", id: newId(form === "seed" ? "seed" : "div"), form, latin: p.latin, name: p.name, count, viability: Math.round(viability), chill: 0, collectedDay: day, updatedDay: day };
}

/**
 * A day of storage for seed and divisions. Seed keeps for years somewhere
 * dry (the seed catalog best); in the cellar it slowly loses viability but
 * banks chilling through the cold months. Divisions wilt fast out of soil
 * unless kept cool and damp in the cellar.
 */
export function stepStock(st: StockItem, place: string, cellarTempF: number, outsideMeanF: number): string | null {
  if (st.form === "division") {
    const loss = place === "cellar" ? 0.6 : place === "basket" || place === "stand" ? 6 : 4;
    st.viability = Math.max(0, st.viability - loss);
    return st.viability <= 0 ? `The ${st.name} division dried out.` : null;
  }
  const loss = place === "tack" ? 0.01 : place === "cellar" ? 0.06 : place === "loft" || place === "stand" ? 0.05 : 0.03;
  st.viability = Math.max(0, st.viability - loss);
  if (place === "cellar" && cellarTempF < 46) st.chill++;
  void outsideMeanF;
  return null;
}
