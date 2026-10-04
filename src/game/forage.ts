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
import type { HarvestState, Layer } from "./harvestState";
import { addToBasket, basketWeight, BASKET_CAPACITY_G, type Lot } from "./basket";
import { isHerb } from "./items";
import { identify, note, recordHarvest, entryFor } from "./journal";
import { addStatus, hasStatus, type GameStateData } from "./state";
export type { ActionResult as Result };

export interface Target {
  layer: Layer;
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

export function harvest(s: GameStateData, hs: HarvestState, t: Target, w: World): ActionResult {
  const day = absDay(s.clock);
  const ctx: PlantContext = { plant: t.plant, look: w.look, doy: s.clock.doy, season: w.season, cohort: t.cohort };
  const pick = choose(s.tool, ctx);
  const known = s.journal[t.plant.latin]?.identified;
  const name = known ? t.plant.name : "this plant";
  if (!pick.ok) return { ok: false, message: known ? pick.reason : pick.reason.replace(t.plant.name, name) };
  const product = pick.product;

  const blocked = hs.blocked(t.layer, t.index, product, t.plant, s.clock.year, day);
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
  hs.apply(t.layer, t.index, product, t.plant, t.x, t.z, s.clock.year, day);
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

