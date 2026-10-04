/**
 * Foraging actions, tying the rules to the save: harvest a plant, examine it.
 * (Smelling, tasting and everything done with what you've gathered lives in
 * homestead.ts.) Pure TypeScript; desktop and VR controls both call these.
 */
import type { Plant } from "../data/plants";
import type { Appearance } from "../sim/phenology";
import type { SeasonAdjust } from "../time/season";
import { monthOf, type DayWeather } from "../time/climate";
import { absDay } from "../time/clock";
import { mixSeed } from "../sim/random";
import { choose, contactHazard, isUnripe, potency, yieldGrams, TOOL_NAMES, type PlantContext } from "./harvest";
import type { HarvestState } from "./harvestState";
import type { Product } from "../data/plants";
import { daysFrom, formatDoy, adjustedPhenology } from "../sim/phenology";
import { applyGardenHarvest, divisible, gardenBlocked, makeStock, plantingLook, setsSeed, SLOTS } from "./garden";
import type { StockItem } from "./items";
import { addToBasket, basketWeight, BASKET_CAPACITY_G, type Lot } from "./basket";
import { isHerb } from "./items";
import { identify, note, recordHarvest, entryFor } from "./journal";
import { addStatus, hasStatus, type GameStateData } from "./state";
export type { ActionResult as Result };

export interface Target {
  /** h: wild herb · w: tree or shrub · g: garden planting (index = slot). */
  layer: "h" | "w" | "g";
  index: number;
  plant: Plant;
  cohort: number;
  x: number;
  z: number;
  scale: number;
  zone: string;
  suitability: number;
}

export interface World {
  look: Appearance;
  season: SeasonAdjust;
  weather: DayWeather;
}

export interface ActionResult {
  ok: boolean;
  message: string;
  /** Extra line (hazards, discoveries). */
  detail?: string;
  lot?: Lot;
  /** The renderer should refresh this individual. */
  changed?: boolean;
  /** Tasting something deadly: the caller fades out and wakes the player at home. */
  collapse?: boolean;
}

/** Hold-to-harvest finished: take what the tool in hand takes from this plant. */
export function harvest(s: GameStateData, hs: HarvestState, t: Target, w: World): ActionResult {
  if (s.tool === "envelope") return collectSeed(s, hs, t, w);
  if (t.layer === "g") return gardenHarvest(s, t, w);
  const r = wildHarvest(s, hs, t, w);
  // The trowel lifts a living division from perennials with no root to take.
  if (!r.ok && s.tool === "trowel" && t.layer === "h" && divisible(t.plant) && !hs.blocked("h", t.index, DIG, t.plant, s.clock.year, absDay(s.clock)) && !/basket is full/.test(r.message)) {
    return liftDivision(s, hs, t, w);
  }
  return r;
}

const DIG = { part: "Root", id: "division", name: "division" } as unknown as Product;
const SEED = { part: "Seed", id: "seed", name: "seed" } as unknown as Product;

function wildHarvest(s: GameStateData, hs: HarvestState, t: Target, w: World): ActionResult {
  const layer = t.layer as "h" | "w";
  const day = absDay(s.clock);
  const ctx: PlantContext = { plant: t.plant, look: w.look, doy: s.clock.doy, season: w.season, cohort: t.cohort };
  const pick = choose(s.tool, ctx);
  const known = s.journal[t.plant.latin]?.identified;
  const name = known ? t.plant.name : "this plant";
  if (!pick.ok) return { ok: false, message: known ? pick.reason : pick.reason.replace(t.plant.name, name) };
  const product = pick.product;

  const blocked = hs.blocked(layer, t.index, product, t.plant, s.clock.year, day);
  if (blocked) return { ok: false, message: blocked };
  if (basketWeight(s.basket) >= BASKET_CAPACITY_G) return { ok: false, message: "Your basket is full. Take it home first." };

  const cond = {
    weather: w.weather, minutes: s.clock.minutes, suitability: t.suitability, tool: s.tool,
    seed: mixSeed(t.index * 2 + (t.layer === "w" ? 1 : 0), day), scale: t.scale,
  };
  let pot = potency(product, ctx, cond);
  // Hurting hands make for sloppy work.
  if (hasStatus(s, "rash") || hasStatus(s, "burn")) pot = Math.max(5, pot - 8);
  const grams = yieldGrams(product, ctx, cond);

  const added = addToBasket(s.basket, {
    latin: t.plant.latin, productId: product.id, productName: product.name, part: product.part,
    grams, potency: pot, harvestedDay: day,
  });
  hs.apply(layer, t.index, product, t.plant, t.x, t.z, s.clock.year, day);
  const firstTime = !known;
  recordHarvest(s.journal, t.plant, product, day, monthOf(s.clock.doy) + 1, t.zone, pot);
  s.stats.harvests++;

  const details: string[] = [];
  if (firstTime) details.push(`New journal entry: ${t.plant.name} (${t.plant.latin}).`);
  if (isUnripe(product, ctx)) details.push("It's still green and hard. Unripe.");
  const hazard = contactHazard(t.plant, s.tool, s.gloves, w.weather, s.clock.minutes);
  if (hazard) {
    addStatus(s, hazard.status, hazard.label, hazard.minutes);
    note(s.journal, t.plant, day, hazard.message.split(".")[0] + ".");
    details.push(hazard.message);
  }
  if (added < grams) details.push("Basket full — you left some behind.");
  const pressure = hs.pressure(t.plant.latin, t.x, t.z);
  if (pressure > 0.25 && pressure <= 0.34) details.push("This patch is getting thin. Leave some to seed.");
  if (pressure > 0.34) details.push("You've taken more than a third of this patch. It will come back thinner.");

  const lot = s.basket.find((l): l is Lot => isHerb(l) && l.productId === product.id && l.harvestedDay === day);
  return {
    ok: true,
    message: `${product.name} (${product.part.toLowerCase()}) · ${added} g · potency ${pot}% · ${TOOL_NAMES[s.tool]}`,
    detail: details.join(" "),
    lot,
    changed: true,
  };
}

/** Looking closely at a plant for a couple of seconds identifies it. */
export function examine(s: GameStateData, t: Target): ActionResult {
  const day = absDay(s.clock);
  const fresh = identify(s.journal, t.plant, day, t.zone);
  return fresh
    ? { ok: true, message: `Identified: ${t.plant.name}`, detail: `${t.plant.latin}. ${t.plant.notes}` }
    : { ok: false, message: "" };
}

/** Notice a plant without identifying it (gives it a journal page). */
export function notice(s: GameStateData, t: Target) {
  const e = entryFor(s.journal, t.plant, absDay(s.clock));
  if (!e.zones.includes(t.zone)) e.zones.push(t.zone);
}


// ---------------------------------------------------------------- seed & divisions

/** Add stock to the basket, merging a packet of the same plant collected today. */
function addStock(s: GameStateData, st: StockItem): StockItem {
  const same = st.form === "seed" && s.basket.find((i): i is StockItem => i.kind === "stock" && i.form === "seed" && i.latin === st.latin && i.collectedDay === st.collectedDay);
  if (same) {
    same.viability = Math.round((same.viability * same.count + st.viability * st.count) / (same.count + st.count));
    same.count += st.count;
    return same;
  }
  s.basket.push(st);
  return st;
}

function seedReady(t: Target, w: World, doy: number): boolean {
  const look = w.look;
  if (look.stage === "fruiting") return true;
  if (look.visual === "standing") return daysFrom(adjustedPhenology(t.plant, w.season).flowerEnd, doy) < 150;
  return false;
}

/** The seed envelope: collect ripe seed for the garden. */
export function collectSeed(s: GameStateData, hs: HarvestState, t: Target, w: World): ActionResult {
  const day = absDay(s.clock);
  const known = s.journal[t.plant.latin]?.identified;
  const name = known ? t.plant.name : "this plant";
  if (t.plant.form === "tree" || t.plant.form === "shrub") return { ok: false, message: "Tree and shrub seed won't fit a raised bed. Use your hands for fruit and nuts." };
  if (!setsSeed(t.plant)) {
    return { ok: false, message: `${known ? t.plant.name : "This plant"} sets no seed worth saving.`, detail: divisible(t.plant) ? "Lift a division with the trowel instead." : undefined };
  }
  const garden = t.layer === "g" ? s.garden.slots[t.index] : null;
  const spentAnnual = !!garden?.dead && garden.dead.startsWith("went to seed");
  if (!spentAnnual && !seedReady(t, w, s.clock.doy)) {
    const seedMonth = t.plant.products.find((p) => p.seedMonth)?.seedMonth;
    const when = seedMonth ? ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][seedMonth - 1] : formatDoy(t.plant.phenology.fruitRipe);
    return { ok: false, message: `No ripe seed on ${name}.`, detail: `It sets seed around ${when}.` };
  }
  if (garden) {
    if (garden.strippedYear === s.clock.year) return { ok: false, message: "You already saved seed from this one this year." };
    garden.strippedYear = s.clock.year;
  } else {
    const blocked = hs.blocked(t.layer as "h" | "w", t.index, SEED, t.plant, s.clock.year, day);
    if (blocked) return { ok: false, message: blocked };
    hs.apply(t.layer as "h" | "w", t.index, SEED, t.plant, t.x, t.z, s.clock.year, day);
  }
  const r = mixSeed(t.index * 7 + (t.layer === "g" ? 3 : 0), day);
  const jitter = ((r % 1000) / 1000);
  const weathered = w.look.visual === "standing" || spentAnnual;
  const count = Math.max(6, Math.round((15 + 110 * jitter) * Math.max(0.4, t.scale) * (garden ? 1.5 : 1)));
  const viability = Math.max(20, Math.min(97, 52 + 38 * t.suitability * (weathered ? 0.75 : 1) + 8 * jitter));
  const st = addStock(s, makeStock("seed", t.plant, count, viability, day));
  identify(s.journal, t.plant, day, t.zone);
  note(s.journal, t.plant, day, `Saved seed in ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][monthOf(s.clock.doy)]}.`);
  s.stats.harvests++;
  s.stats.seedsSaved = (s.stats.seedsSaved ?? 0) + 1;
  return { ok: true, message: `${t.plant.name} seed · ${count} seeds`, detail: weathered ? "Weathered seed heads: some of it won't be good." : "Plump, ripe seed.", changed: !garden && st.count > 0 };
}

/** The trowel on a perennial with no root to take: lift a living clump for the garden. */
export function liftDivision(s: GameStateData, hs: HarvestState, t: Target, w: World): ActionResult {
  const day = absDay(s.clock);
  if (!w.look.visual) return { ok: false, message: "You can't find it this time of year." };
  if (basketWeight(s.basket) + 150 > BASKET_CAPACITY_G) return { ok: false, message: "Your basket is full. Take it home first." };
  const summer = s.clock.doy > 160 && s.clock.doy < 245;
  const viability = Math.max(15, Math.min(95, 55 + 35 * t.suitability - (summer ? 25 : 0)));
  if (t.layer === "g") {
    const pl = s.garden.slots[t.index]!;
    if (pl.size < 0.6) return { ok: false, message: "It's too small to divide. Let it fill out first." };
    pl.size *= 0.6;
    pl.health = Math.max(0.3, pl.health - 0.15);
  } else {
    hs.apply("h", t.index, DIG, t.plant, t.x, t.z, s.clock.year, day);
  }
  addStock(s, makeStock("division", t.plant, 1, viability, day));
  identify(s.journal, t.plant, day, t.zone);
  s.stats.harvests++;
  return {
    ok: true,
    message: `${t.plant.name} division lifted`,
    detail: summer ? "Dividing in summer heat is hard on it. Plant it soon and keep it watered." : "Plant it soon (or keep it cool in the root cellar).",
    changed: true,
  };
}

// ---------------------------------------------------------------- garden

function gardenHarvest(s: GameStateData, t: Target, w: World): ActionResult {
  const day = absDay(s.clock);
  const pl = s.garden.slots[t.index];
  if (!pl) return { ok: false, message: "" };
  const look = w.look;
  const ctx: PlantContext = { plant: t.plant, look, doy: s.clock.doy, season: w.season, cohort: pl.upYear !== null && s.clock.year > pl.upYear ? 1 : 0 };
  const pick = choose(s.tool, ctx);
  if (!pick.ok) {
    if (s.tool === "trowel" && divisible(t.plant)) return liftDivision(s, null as unknown as HarvestState, t, w);
    return { ok: false, message: pick.reason };
  }
  const product = pick.product;
  const blocked = gardenBlocked(pl, product, t.plant, day, s.clock.year);
  if (blocked) return { ok: false, message: blocked };
  if (basketWeight(s.basket) >= BASKET_CAPACITY_G) return { ok: false, message: "Your basket is full. Take it home first." };
  const cond = {
    weather: w.weather, minutes: s.clock.minutes, suitability: Math.min(1, 0.55 + 0.45 * pl.health), tool: s.tool,
    seed: mixSeed(t.index * 13 + 5, day), scale: 0.8 + 0.8 * pl.size,
  };
  const pot = potency(product, ctx, cond);
  const grams = yieldGrams(product, ctx, cond);
  const added = addToBasket(s.basket, { latin: t.plant.latin, productId: product.id, productName: product.name, part: product.part, grams, potency: pot, harvestedDay: day });
  const gone = applyGardenHarvest(s.garden, t.index, product, t.plant, day, s.clock.year);
  recordHarvest(s.journal, t.plant, product, day, monthOf(s.clock.doy) + 1, "the garden", pot);
  s.stats.harvests++;
  s.stats.gardenHarvests = (s.stats.gardenHarvests ?? 0) + 1;
  const lot = s.basket.find((l): l is Lot => isHerb(l) && l.productId === product.id && l.harvestedDay === day);
  return {
    ok: true,
    message: `${product.name} (${product.part.toLowerCase()}) · ${added} g · potency ${pot}% · from the garden`,
    detail: gone ? `That's the last of the ${t.plant.name} in ${SLOTS[t.index].label}.` : undefined,
    lot, changed: true,
  };
}

export { plantingLook };
