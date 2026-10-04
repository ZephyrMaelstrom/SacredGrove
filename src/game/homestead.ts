/**
 * Everything you do with what you've gathered: carry and store it, smell and
 * taste it, grind it, brew it, sell it, and fill orders. Plus the daily
 * tick: drying and spoilage everywhere, sales at the stand, new and expired
 * orders.
 *
 * Pure TypeScript over GameStateData; desktop and VR panels call these.
 */
import { PLANTS, type EffectTag } from "../data/plants";
import { absDay } from "../time/clock";
import type { DayWeather } from "../time/climate";
import { isHerb, isPrep, isStock, itemGrams, newId, servings, CUP_ML, FULL_CUP_ML, type HerbLot, type Item, type Method, type PrepItem } from "./items";
import { BASKET_CAPACITY_G, basketWeight } from "./basket";
import { PLACES, canStore, stepItems, type PlaceId } from "./storage";
import { brew, canGrind, grind, productById, tastePrep, BREW_LIMITS, strengthWord } from "./apothecary";
import { deliver as deliverOrder, makeOrder, money, simulateStandDay, value } from "./market";
import { learnEffect, note, recordSmell, recordTaste, tasteOutcome, type Protocol } from "./journal";
import { plant as plantSlot, pull, stepGarden, usedUp, water, weed, BED_COUNT } from "./garden";
import { addStatus, absMinute, hasStatus, log, type GameStateData, type StoragePlace } from "./state";
import { WORLD_SEED } from "../sim/placement";
import { EFFECT_WORDS } from "../data/plants";

export interface Result {
  ok: boolean;
  message: string;
  detail?: string;
  collapse?: boolean;
  /** Game minutes the work took (the clock moves on). */
  minutes?: number;
}
const fail = (message: string): Result => ({ ok: false, message });

export function listOf(s: GameStateData, place: PlaceId): Item[] {
  return place === "basket" ? s.basket : s.storage[place];
}

export function findItem(s: GameStateData, id: string): { place: PlaceId; item: Item } | null {
  for (const place of ["basket", "loft", "cellar", "tack", "shelf", "stand"] as PlaceId[]) {
    const item = listOf(s, place).find((i) => i.id === id);
    if (item) return { place, item };
  }
  return null;
}

const plantOf = (latin: string) => PLANTS.find((p) => p.latin === latin)!;

export function itemName(s: GameStateData, i: Item): string {
  if (isPrep(i)) return i.name;
  const known = s.journal[i.latin]?.identified;
  if (isStock(i)) {
    const named = known || i.labeled;
    return i.form === "seed" ? `${named ? i.name : "Unknown"} seed` : `${named ? i.name : "Unknown plant"} division`;
  }
  return known ? i.productName : `Unknown ${i.part.toLowerCase()}`;
}

// ---------------------------------------------------------------- moving

/** Move an item (or part of a herb lot) between the basket and a storage place. */
export function move(s: GameStateData, id: string, to: PlaceId, grams = Infinity): Result {
  const found = findItem(s, id);
  if (!found) return fail("");
  if (found.place === to) return fail("");
  const item = found.item;
  const from = listOf(s, found.place), dest = listOf(s, to);
  let amount = isHerb(item) ? Math.min(item.grams, grams) : itemGrams(item);
  if (to === "basket") {
    const room = BASKET_CAPACITY_G - basketWeight(s.basket);
    if (room <= 0) return fail("Your basket is full.");
    if (isPrep(item) && item.volumeMl > room) return fail("That won't fit in your basket.");
    amount = Math.min(amount, room);
  } else {
    const why = canStore(dest, to as StoragePlace, item);
    if (why) return fail(why);
    if (isHerb(item)) amount = Math.min(amount, PLACES[to as StoragePlace].maxGrams);
  }
  // Dried herbs keep their own state wherever they go; just move or split.
  if (isHerb(item) && amount < item.grams) {
    const part: HerbLot = { ...item, id: newId(item.productId), grams: Math.round(amount) };
    item.grams -= part.grams;
    dest.push(part);
  } else {
    from.splice(from.indexOf(item), 1);
    dest.push(item);
  }
  const where = to === "basket" ? "your basket" : PLACES[to as StoragePlace].name.toLowerCase();
  return { ok: true, message: `${itemName(s, item)} → ${where}` };
}

export function discard(s: GameStateData, id: string): Result {
  const found = findItem(s, id);
  if (!found) return fail("");
  const list = listOf(s, found.place);
  list.splice(list.indexOf(found.item), 1);
  return { ok: true, message: `Tossed ${itemName(s, found.item)} on the compost.` };
}

// ---------------------------------------------------------------- senses

export function smell(s: GameStateData, id: string): Result {
  const found = findItem(s, id);
  if (!found) return fail("");
  const it = found.item;
  if (isPrep(it)) return { ok: true, message: `${it.name}: ${it.description}.` };
  if (isStock(it)) return { ok: true, message: it.form === "seed" ? "Dry seed: dusty, faintly nutty." : "Damp roots and soil." };
  const info = productById(it.productId);
  if (!info) return fail("");
  recordSmell(s.journal, plantOf(it.latin), info.product, absDay(s.clock));
  if (it.state === "moldy") return { ok: true, message: "Musty and sour. It's molded." };
  return { ok: true, message: `${itemName(s, it)} smells ${info.product.smell ? `of ${info.product.smell.toLowerCase()}` : "of very little"}.` };
}

export function taste(s: GameStateData, id: string): Result {
  const found = findItem(s, id);
  if (!found) return fail("");
  if (hasStatus(s, "nauseous") || hasStatus(s, "recovering")) return fail("Your stomach can't take another taste right now.");
  const it = found.item;
  const day = absDay(s.clock);
  const list = listOf(s, found.place);
  if (isStock(it)) return fail("That's your planting stock. Grow it first.");

  if (isPrep(it)) {
    const t = tastePrep(it);
    it.volumeMl -= 30; // a few sips
    if (it.volumeMl <= 0) list.splice(list.indexOf(it), 1);
    if (t.status) addStatus(s, t.status.id, t.status.label, t.status.minutes);
    // What you felt teaches you about the herbs in it.
    if (!it.spoiled) {
      it.known = true;
      const single = it.ingredients.length === 1;
      for (const ing of it.ingredients) {
        const plant = plantOf(ing.latin);
        for (const tag of t.felt) learnEffect(s.journal, plant, ing.productId, tag, day, single ? "confirmed" : "suspected");
        if (t.severity === "sick" || t.severity === "collapse") learnEffect(s.journal, plant, ing.productId, "toxic", day, single ? "confirmed" : "suspected");
      }
      recordProtocol(s, it);
    }
    if (t.severity === "collapse") {
      s.basket.length = 0;
      return { ok: true, message: t.message, collapse: true };
    }
    return { ok: true, message: `${it.name}: ${t.message}` };
  }

  const info = productById(it.productId);
  if (!info) return fail("");
  const out = tasteOutcome(info.product);
  recordTaste(s.journal, plantOf(it.latin), info.product, day, out);
  it.grams = Math.max(0, it.grams - 1);
  if (it.grams === 0) list.splice(list.indexOf(it), 1);
  if (out.status) addStatus(s, out.status.id, out.status.label, out.status.minutes);
  if (out.severity === "collapse") {
    s.basket.length = 0;
    return { ok: true, message: out.message, collapse: true };
  }
  if (it.state === "moldy") {
    addStatus(s, "upset", "Upset stomach", 60);
    return { ok: true, message: "Musty and bitter. That was moldy." };
  }
  return { ok: true, message: out.severity === "none" ? `${itemName(s, it)} — ${out.message}` : out.message };
}

// ---------------------------------------------------------------- protocols

/** Remember a recipe once you know what it does. */
export function recordProtocol(s: GameStateData, p: PrepItem, params = p.brewed) {
  const total = p.ingredients.reduce((a, i) => a + i.grams, 0) || 1;
  const pr: Protocol = s.protocols[p.protocol] ?? {
    key: p.protocol,
    name: p.name,
    method: p.method,
    ingredients: p.ingredients.map((i) => ({ productId: i.productId, name: i.name, share: Math.round((i.grams / total) * 100) })),
    waterMl: params?.waterMl ?? p.volumeMl,
    minutes: params?.minutes ?? 0,
    covered: params?.covered ?? true,
    best: {},
    made: 0,
    notes: [],
  };
  if (p.known) {
    for (const [tag, v] of Object.entries(p.effects)) if (v >= 0.2) pr.best[tag] = Math.max(pr.best[tag] ?? 0, v);
  }
  s.protocols[p.protocol] = pr;
}

// ---------------------------------------------------------------- mortar

export function grindItem(s: GameStateData, id: string, strokes: number): Result {
  const found = findItem(s, id);
  if (!found || !isHerb(found.item)) return fail("");
  const why = canGrind(found.item);
  if (why) return fail(why);
  grind(found.item, strokes);
  const g = found.item.ground;
  return { ok: true, message: g > 0.85 ? "A fine powder." : g > 0.5 ? "Coarse powder." : "Crushed and broken." };
}

// ---------------------------------------------------------------- brewing

export const MAX_POTS = 3;
export const REPUTATION_BASE = 20;

export interface BrewRequest {
  method: Method;
  waterMl: number;
  minutes: number;
  covered: boolean;
  picks: { id: string; grams: number }[];
}

export function startBrew(s: GameStateData, req: BrewRequest): Result {
  if (s.jobs.length >= MAX_POTS) return fail("Every pot and jar is in use. Wait for one to finish.");
  if (!req.picks.length) return fail("Put something in the pot first.");
  const [lo, hi] = BREW_LIMITS.minutes[req.method];
  const minutes = Math.max(lo, Math.min(hi, Math.round(req.minutes)));
  const waterMl = Math.max(BREW_LIMITS.waterMl[0], Math.min(BREW_LIMITS.waterMl[1], Math.round(req.waterMl / 50) * 50));
  const ingredients: { lot: HerbLot; grams: number }[] = [];
  for (const pick of req.picks) {
    const found = findItem(s, pick.id);
    if (!found || !isHerb(found.item)) return fail("One of those ingredients is gone.");
    const lot = found.item;
    if (lot.state === "spoiled") return fail(`${itemName(s, lot)} is spoiled.`);
    const g = Math.min(lot.grams, Math.max(1, Math.round(pick.grams)));
    ingredients.push({ lot: { ...lot }, grams: g });
  }
  // Take the herbs out of storage.
  for (const pick of req.picks) {
    const found = findItem(s, pick.id)!;
    const lot = found.item as HerbLot;
    lot.grams -= Math.min(lot.grams, Math.max(1, Math.round(pick.grams)));
    if (lot.grams <= 0) {
      const list = listOf(s, found.place);
      list.splice(list.indexOf(lot), 1);
    }
  }
  const now = absMinute(s.clock);
  const { prep } = brew({ method: req.method, waterMl, minutes, covered: req.covered, ingredients }, absDay(s.clock));
  s.jobs.push({ id: newId("job"), prep, startedAt: now, readyAt: now + minutes });
  s.stats.brews++;
  const what = req.method === "decoction" ? "simmering on the stove" : req.method === "cold" ? "steeping in a jar" : "steeping";
  return { ok: true, message: `${prep.name} ${what} — ready in ${minutes} minutes.` };
}

/** Hand over finished brews (to the jar shelf, or the basket if the shelf's full). */
export function finishJobs(s: GameStateData): Result[] {
  const now = absMinute(s.clock);
  const out: Result[] = [];
  for (const job of [...s.jobs]) {
    if (job.readyAt > now) continue;
    s.jobs.splice(s.jobs.indexOf(job), 1);
    const shelf = s.storage.shelf;
    if (shelf.length < PLACES.shelf.slots) shelf.push(job.prep);
    else s.basket.push(job.prep);
    recordProtocol(s, job.prep);
    out.push({ ok: true, message: `${job.prep.name} is ready (${servings(job.prep)} cup${servings(job.prep) > 1 ? "s" : ""}).`, detail: `${capital(job.prep.description)}. It's on the jar shelf.` });
  }
  return out;
}

// ---------------------------------------------------------------- stand & orders

export function collectCash(s: GameStateData): Result {
  if (!s.cashBox) return fail("The cash box is empty.");
  const c = s.cashBox;
  s.money += c;
  s.cashBox = 0;
  return { ok: true, message: `You collect ${money(c)} from the cash box.` };
}

export function deliver(s: GameStateData, orderId: string, itemId: string): Result {
  const order = s.orders.find((o) => o.id === orderId);
  const found = findItem(s, itemId);
  if (!order || !found) return fail("");
  const d = deliverOrder(order, found.item);
  if (d.outcome === "wrong") return fail(d.feedback);
  const list = listOf(s, found.place);
  if (d.consumed) {
    if (isPrep(found.item) && order.kind === "remedy") {
      found.item.volumeMl = Math.max(0, found.item.volumeMl - order.cups * CUP_ML);
      if (found.item.volumeMl < FULL_CUP_ML) list.splice(list.indexOf(found.item), 1);
    } else if (isHerb(found.item)) {
      found.item.grams -= order.grams;
      if (found.item.grams <= 0) list.splice(list.indexOf(found.item), 1);
    }
  }
  s.orders.splice(s.orders.indexOf(order), 1);
  s.money += d.cents;
  s.reputation = clamp(s.reputation + d.reputation, 0, 100);
  s.stats.ordersDone++;
  const day = absDay(s.clock);
  for (const l of d.learned) {
    const info = productById(l.productId);
    if (info) learnEffect(s.journal, plantOf(info.latin), l.productId, l.tag, day, l.works ? "confirmed" : "doesnt");
  }
  if (isPrep(found.item)) {
    found.item.known = true;
    recordProtocol(s, found.item);
    const pr = s.protocols[found.item.protocol];
    if (pr) pr.notes.unshift(`${order.customer}: ${d.outcome}`), (pr.notes.length = Math.min(pr.notes.length, 5));
  }
  log(s, `${order.customer}: ${d.outcome}${d.cents ? `, paid ${money(d.cents)}` : ""}.`);
  return { ok: d.outcome === "success" || d.outcome === "partial", message: d.feedback, detail: d.cents ? `Paid ${money(d.cents)}.` : undefined };
}

// ---------------------------------------------------------------- daily

export interface WeatherLookup {
  (absDay: number): { w: DayWeather; doy: number };
}

/**
 * Catch the homestead up to today: drying and spoilage everywhere, finished
 * brews, the stand's sales for each day that passed, orders expiring and
 * new ones posted. Returns notes for the morning.
 */
export function catchUp(s: GameStateData, weather: WeatherLookup): string[] {
  const today = absDay(s.clock);
  const notes: string[] = [];
  for (const place of ["loft", "cellar", "tack", "shelf", "stand"] as StoragePlace[]) {
    notes.push(...stepItems(s.storage[place], place, weather, today, { ventOpen: s.ventOpen, slots: PLACES[place].slots }));
    // Ruined lots stay until you toss them (so you notice), but finished brews that turned are poured out at the stand.
  }
  notes.push(...stepItems(s.basket, "basket", weather, today, { ventOpen: s.ventOpen, slots: 0 }));
  // Storage gets rid of anything used up (stock packets sown to nothing).
  for (const place of ["basket", "loft", "cellar", "tack", "shelf", "stand"] as PlaceId[]) {
    const list = listOf(s, place);
    for (let i = list.length - 1; i >= 0; i--) {
      const it = list[i];
      if (isStock(it) && (it.count <= 0 || (it.form === "division" && it.viability <= 0))) list.splice(i, 1);
    }
  }

  // The garden lives through each day.
  for (let d = s.garden.updatedDay + 1; d <= today; d++) {
    const { w, doy } = weather(d);
    const year = Math.floor((d - 1) / 365) + 1;
    for (const n of stepGarden(s.garden, d, year, doy, w)) {
      notes.push(n.text);
      if (n.learn) note(s.journal, plantOf(n.learn.latin), d, n.learn.note);
    }
  }

  // Each day since we last looked: stand sales, orders.
  for (let d = s.lastSimDay; d < today; d++) {
    const { w, doy } = weather(d);
    const stand = s.storage.stand;
    stand.splice(0, stand.length, ...stand.filter((i) => !(isPrep(i) && i.spoiled)));
    const sales = simulateStandDay(stand, d, doy, w, s.reputation, WORLD_SEED);
    if (sales.sold.length) {
      s.cashBox += sales.cents;
      s.stats.sales += sales.sold.length;
      const line = `Stand: ${sales.visitors} stopped by, sold ${sales.sold.length} (${money(sales.cents)}).`;
      notes.push(line);
      log(s, line + " " + sales.sold.slice(0, 4).map((x) => `${x.name} ${x.why}`).join("; "));
    }
    notes.push(...sales.notes);
    // Neighbors slowly forget, good and bad: reputation drifts back toward where a newcomer starts.
    s.reputation += (REPUTATION_BASE - s.reputation) * 0.02;
    s.reputation = clamp(s.reputation + sales.reputation, 0, 100);

    // Orders: expire, then maybe post a new one.
    for (const o of [...s.orders]) {
      if (o.dueDay < d) {
        s.orders.splice(s.orders.indexOf(o), 1);
        // A small mark against you: you saw the note and didn't come through.
        s.reputation = clamp(s.reputation - 0.3, 0, 100);
        notes.push(`${o.customer} gave up waiting.`);
      }
    }
    const winter = doy < 70 || doy > 320;
    const cap = winter ? 2 : 3;
    const chance = (d * 2654435761) % 100 < (winter ? 40 : 60);
    if (s.orders.length < cap && (chance || s.orders.length === 0)) {
      const o = makeOrder(d, doy, s.reputation, WORLD_SEED);
      s.orders.push(o);
      notes.push(`New order on the clipboard: ${o.customer}.`);
    }
  }
  s.lastSimDay = today;
  return notes;
}

// ---------------------------------------------------------------- readouts

/** How a preparation reads to the player: effects only once known. */
export function prepSummary(p: PrepItem): string {
  if (p.spoiled) return "turned sour";
  if (!p.known) return "untested — taste it or sell it to find out";
  const eff = (Object.entries(p.effects) as [EffectTag, number][])
    .filter(([t, v]) => v >= 0.2 && t !== "toxic").sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([t, v]) => `${strengthWord(v)} ${EFFECT_WORDS[t]}`);
  const warn = p.toxicity >= 0.3 ? " · HARMFUL" : p.toxicity >= 0.12 ? " · upsets the stomach" : "";
  return (eff.length ? eff.join(", ") : "no noticeable effect") + warn;
}

export { value, money };
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const capital = (t: string) => t[0].toUpperCase() + t.slice(1);

// ---------------------------------------------------------------- garden

export function sow(s: GameStateData, slot: number, itemId: string): Result {
  const found = findItem(s, itemId);
  if (!found) return fail("");
  const r = plantSlot(s.garden, slot, found.item, absDay(s.clock), s.clock.year);
  if (r.ok) {
    s.stats.planted = (s.stats.planted ?? 0) + 1;
    if (usedUp(found.item)) {
      const list = listOf(s, found.place);
      list.splice(list.indexOf(found.item), 1);
    }
  }
  return r;
}

export function waterBeds(s: GameStateData, bed: number | "all"): Result {
  if (bed !== "all") return water(s.garden, bed);
  let minutes = 0;
  for (let b = 0; b < BED_COUNT; b++) minutes += water(s.garden, b).minutes ?? 0;
  return { ok: true, message: "You water all four beds from the rain barrel.", minutes };
}

export function weedBeds(s: GameStateData, bed: number | "all"): Result {
  if (bed !== "all") return weed(s.garden, bed);
  let minutes = 0;
  for (let b = 0; b < BED_COUNT; b++) minutes += weed(s.garden, b).minutes ?? 0;
  return { ok: true, message: "You weed the whole garden.", minutes };
}

export function pullPlant(s: GameStateData, slot: number): Result {
  return pull(s.garden, slot);
}
