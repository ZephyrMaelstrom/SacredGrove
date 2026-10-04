/**
 * M7 — The roadside stand and its clipboard of orders.
 *
 * Passers-by stop at the stand every day: more in good weather, on weekends,
 * in the growing season, and as your reputation grows. Some want a remedy
 * for something (which needs change with the seasons: coughs and colds in
 * winter, rashes and stomachs in summer), some want kitchen herbs or a nice
 * tea, some just browse. They pay about 60% of an item's value: quick
 * money, not full price (full price waits for the town market).
 *
 * Neighbors also post orders with a real need and real constraints
 * ("something for my grandson's cough, nothing too bitter, two cups by
 * Thursday"). How it went comes back as feedback in plain words, which is
 * how you learn what actually works.
 */
import { EFFECT_WORDS, type EffectTag } from "../data/plants";
import { rng, mixSeed } from "../sim/random";
import type { DayWeather } from "../time/climate";
import { isHerb, isPrep, servings, newId, FULL_CUP_ML, CUP_ML, type HerbLot, type Item, type PrepItem } from "./items";
import { perceivedBitter, productById } from "./apothecary";

export const STAND_RATE = 0.6;

const MEDICINAL: EffectTag[] = ["sleep", "calm", "digestion", "cough", "fever", "wound", "skin", "pain", "immunity", "stamina", "kidney"];

// ---------------------------------------------------------------- value

/** What an item is worth at full price, in cents. */
export function value(i: Item): number {
  if (isPrep(i)) {
    if (i.spoiled) return 0;
    const best = Math.max(0, ...MEDICINAL.map((t) => i.effects[t] ?? 0));
    const taste = Math.max(0.4, 1 - 0.5 * perceivedBitter(i.flavor));
    const flavor = (i.effects.flavor ?? 0) * 120;
    const per = (30 + 450 * best + flavor) * taste * (i.toxicity >= 0.3 ? 0.05 : 1);
    return Math.round(per * servings(i));
  }
  if (i.state === "moldy" || i.state === "spoiled") return 0;
  const base = productById(i.productId)?.product.basePrice ?? 5;
  const stateMult = i.state === "dried" ? (i.ground > 0 ? 1.1 : 1) : 0.6;
  return Math.max(1, Math.round(base * (i.grams / 100) * (i.potency / 100) * stateMult * 4));
}

export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

// ---------------------------------------------------------------- visitors

/** What people come looking for, by season. */
function needWeights(doy: number): [EffectTag, number][] {
  const winter = doy < 80 || doy > 320, summer = doy > 150 && doy < 260;
  return [
    ["cough", winter ? 4 : 1.5], ["immunity", winter ? 4 : 1.2], ["fever", winter ? 3 : 1],
    ["skin", summer ? 3.5 : 1], ["wound", summer ? 2 : 1], ["digestion", 2], ["sleep", 2], ["calm", 1.5],
    ["pain", 2], ["stamina", 1], ["kidney", 0.5], ["repellent", summer ? 2 : 0.2],
  ];
}

function pickWeighted<T>(items: [T, number][], r: () => number): T {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [it, w] of items) if ((x -= w) <= 0) return it;
  return items[items.length - 1][0];
}

export interface DaySales {
  visitors: number;
  sold: { name: string; cents: number; why: string }[];
  cents: number;
  notes: string[];
  reputation: number;
}

/** A herb lot sold as a remedy only counts if it actually has that effect (customers can tell, eventually). */
const herbEffect = (l: HerbLot, tag: EffectTag) => (productById(l.productId)?.product.effects[tag] ?? 0) * (l.potency / 100) * (l.state === "dried" ? 1 : 0.6);

export function simulateStandDay(stand: Item[], absDay: number, doy: number, w: DayWeather, reputation: number, seed: number): DaySales {
  const r = rng(mixSeed(seed ^ 0x57a9d, absDay));
  const season = doy > 90 && doy < 300 ? 1.2 : 0.6;
  const weather = w.condition === "storm" || w.condition === "snow" ? 0.3 : w.condition === "rain" ? 0.5 : 1;
  const weekend = absDay % 7 >= 5 ? 1.5 : 1;
  const visitors = Math.round(8 * season * weather * weekend * (0.6 + reputation / 100) * (0.8 + 0.4 * r()));
  const out: DaySales = { visitors, sold: [], cents: 0, notes: [], reputation: 0 };

  const sell = (it: Item, why: string) => {
    let cents: number;
    let name: string;
    if (isPrep(it)) {
      const per = value(it) / servings(it);
      cents = Math.round(per * STAND_RATE);
      name = `a cup of ${it.name}`;
      it.volumeMl -= CUP_ML;
      if (it.volumeMl < FULL_CUP_ML) stand.splice(stand.indexOf(it), 1);
      if (it.toxicity >= 0.3) {
        out.reputation -= 15;
        out.notes.push(`Someone who bought ${it.name} came back sick. Word gets around.`);
      }
    } else {
      const g = Math.min(it.grams, 100);
      const portion: HerbLot = { ...it, grams: g };
      cents = Math.round(value(portion) * STAND_RATE);
      name = `${g} g of ${it.productName}`;
      it.grams -= g;
      if (it.grams <= 0) stand.splice(stand.indexOf(it), 1);
    }
    out.sold.push({ name, cents, why });
    out.cents += cents;
  };

  for (let v = 0; v < visitors && stand.length; v++) {
    const kind = r();
    const sellable = stand.filter((i) => value(i) > 0);
    if (!sellable.length) break;
    if (kind < 0.45) {
      const need = pickWeighted(needWeights(doy), r);
      // Best thing on the stand for the need: brews first, then herbs that really do it.
      const options: [Item, number][] = sellable.map((i) => [i, isPrep(i) ? i.effects[need] ?? 0 : herbEffect(i as HerbLot, need) * 0.6]);
      options.sort((a, b) => b[1] - a[1]);
      if (options[0] && options[0][1] >= 0.25) sell(options[0][0], `for ${EFFECT_WORDS[need]}`);
    } else if (kind < 0.8) {
      // Kitchen herbs and nice teas.
      const options = sellable.filter((i) => isPrep(i) ? (i.effects.flavor ?? 0) > 0.3 || perceivedBitter(i.flavor) < 0.2 : herbEffect(i as HerbLot, "flavor") + herbEffect(i as HerbLot, "food") > 0.25);
      if (options.length) sell(options[Math.floor(r() * options.length)], "for the kitchen");
    } else if (r() < 0.5) {
      const cheap = sellable.slice().sort((a, b) => value(a) - value(b))[0];
      if (cheap) sell(cheap, "on a whim");
    }
  }
  if (out.sold.length >= 4) out.reputation += 1;
  return out;
}

// ---------------------------------------------------------------- orders

export interface Order {
  id: string;
  customer: string;
  need: EffectTag;
  /** Remedy orders want a brew; kitchen orders want dried herb by weight. */
  kind: "remedy" | "kitchen";
  minStrength: number;
  maxBitter: number | null;
  cups: number;
  grams: number;
  /** Must be a hot-water tea (some folks won't drink a decoction). */
  teaOnly: boolean;
  postedDay: number;
  dueDay: number;
  rewardCents: number;
  text: string;
}

const CUSTOMERS = [
  "Mrs. Dillard", "Old Mr. Kell", "Juanita Ruiz", "Pastor Hale", "Tammy from the feed store", "Earl Pruett",
  "the Hutchins boys' mother", "Doris at the post office", "Ray Daniels", "Miss Opal", "the Simms family", "Coach Hagan",
];
const WHO: Record<string, string[]> = {
  cough: ["my grandson's cough", "this cough I can't shake", "the baby's croupy cough"],
  immunity: ["the cold going around church", "keeping the flu off this winter"],
  fever: ["my husband's fever", "a fever that won't break"],
  skin: ["poison ivy all up my arms", "my boy's rash", "a heat rash"],
  wound: ["a cut that keeps bleeding", "scrapes from the fence line"],
  digestion: ["an upset stomach", "heartburn after supper"],
  sleep: ["getting some sleep", "a restless baby"],
  calm: ["my nerves", "a wound-up teenager"],
  pain: ["my bad back", "headaches every afternoon", "sore knees"],
  stamina: ["getting through harvest", "feeling run down"],
  kidney: ["my kidney trouble"],
  repellent: ["chiggers and mosquitoes", "keeping moths out of the closet"],
  flavor: ["a good cup of tea", "something nice for Sunday company"],
  food: ["the kitchen"],
};

/** Post a new order (deterministic per day). */
export function makeOrder(absDay: number, doy: number, reputation: number, seed: number): Order {
  const r = rng(mixSeed(seed ^ 0x0de25, absDay));
  const kitchen = r() < 0.25;
  const need: EffectTag = kitchen ? (r() < 0.7 ? "flavor" : "food") : pickWeighted(needWeights(doy), r);
  const customer = CUSTOMERS[Math.floor(r() * CUSTOMERS.length)];
  const what = WHO[need]?.[Math.floor(r() * (WHO[need]?.length ?? 1))] ?? EFFECT_WORDS[need];
  const minStrength = kitchen ? 0.4 : Math.round((0.3 + r() * 0.3 + reputation / 400) * 100) / 100;
  const picky = !kitchen && r() < 0.45;
  const maxBitter = picky ? Math.round((0.25 + r() * 0.2) * 100) / 100 : null;
  const cups = kitchen ? 0 : 1 + Math.floor(r() * 3);
  const grams = kitchen ? 50 + Math.floor(r() * 4) * 25 : 0;
  const teaOnly = !kitchen && r() < 0.25;
  const days = 3 + Math.floor(r() * 5);
  const reward = Math.round((kitchen ? 150 + grams * 3 : 200 + cups * 120 + minStrength * 900 + (picky ? 250 : 0) + (teaOnly ? 100 : 0)) * (0.9 + reputation / 200));
  const due = absDay + days;
  const constraints = [
    kitchen ? `${grams} g, dried` : `${cups} cup${cups > 1 ? "s" : ""}`,
    picky ? "nothing too bitter" : "",
    teaOnly ? "a hot tea, not a strong boiled brew" : "",
  ].filter(Boolean).join(", ");
  const text = kitchen
    ? `${customer}: Some dried herbs for ${what}. (${constraints})`
    : `${customer}: Something for ${what}. (${constraints})`;
  return { id: newId("order"), customer, need, kind: kitchen ? "kitchen" : "remedy", minStrength, maxBitter, cups, grams, teaOnly, postedDay: absDay, dueDay: due, rewardCents: reward, text };
}

export interface Delivery {
  outcome: "success" | "partial" | "fail" | "harm" | "wrong";
  cents: number;
  reputation: number;
  feedback: string;
  /** Effects confirmed for single-ingredient deliveries (productId → tags). */
  learned: { productId: string; tag: EffectTag; works: boolean }[];
  /** The item is used up. */
  consumed: boolean;
}

export function deliver(o: Order, item: Item): Delivery {
  const no = (feedback: string): Delivery => ({ outcome: "wrong", cents: 0, reputation: 0, feedback, learned: [], consumed: false });
  if (o.kind === "kitchen") {
    if (!isHerb(item)) return no(`${o.customer} wanted dried herbs, not a brew.`);
    if (item.state !== "dried") return no(`${o.customer} wants it dried, so it keeps.`);
    if (item.grams < o.grams) return no(`That's not enough — ${o.customer} asked for ${o.grams} g.`);
    const s = herbEffect(item, o.need);
    const learned = [{ productId: item.productId, tag: o.need, works: s >= o.minStrength * 0.6 }];
    if (s >= o.minStrength) return { outcome: "success", cents: o.rewardCents, reputation: 4, feedback: `${o.customer} smells the jar and smiles. "That's the real thing."`, learned, consumed: true };
    if (s >= o.minStrength * 0.5) return { outcome: "partial", cents: Math.round(o.rewardCents / 2), reputation: 1, feedback: `${o.customer} takes it, but says it's a little flat.`, learned, consumed: true };
    return { outcome: "fail", cents: 0, reputation: -2, feedback: `${o.customer} frowns. "This isn't what I use for ${EFFECT_WORDS[o.need]}."`, learned, consumed: true };
  }
  if (!isPrep(item)) return no(`${o.customer} needs it made up, not raw.`);
  if (item.spoiled) return no("That brew has turned. Make it fresh.");
  if (item.volumeMl < o.cups * CUP_ML - (CUP_ML - FULL_CUP_ML)) return no(`${o.customer} asked for ${o.cups} cup${o.cups > 1 ? "s" : ""}; that's not enough.`);
  if (o.teaOnly && item.method !== "hot") return no(`${o.customer} specifically asked for a hot tea, not a ${item.method === "cold" ? "cold infusion" : "decoction"}.`);

  const strength = item.effects[o.need] ?? 0;
  const single = item.ingredients.length === 1 ? item.ingredients[0].productId : null;
  const learned = single ? [{ productId: single, tag: o.need, works: strength >= 0.25 }] : [];
  if (item.toxicity >= 0.3) {
    return { outcome: "harm", cents: 0, reputation: -20, feedback: `${o.customer} came back furious: it made them sick. Whatever was in that ${item.name}, it isn't safe.`, learned, consumed: true };
  }
  const tooBitter = o.maxBitter !== null && perceivedBitter(item.flavor) > o.maxBitter;
  if (strength >= o.minStrength && !tooBitter) {
    return { outcome: "success", cents: o.rewardCents, reputation: 5, feedback: `${o.customer} stops by to say it worked. "${capital(EFFECT_WORDS[o.need])} — better in a day. I'll tell people."`, learned, consumed: true };
  }
  if (strength >= o.minStrength && tooBitter) {
    return { outcome: "partial", cents: Math.round(o.rewardCents / 2), reputation: 0, feedback: `${o.customer}: "It worked when they'd drink it, but it was too bitter." Something sweet or aromatic might cover that.`, learned, consumed: true };
  }
  if (strength >= o.minStrength * 0.5) {
    return { outcome: "partial", cents: Math.round(o.rewardCents / 3), reputation: 1, feedback: `${o.customer}: "Helped a little. Needed to be stronger."`, learned, consumed: true };
  }
  return { outcome: "fail", cents: 0, reputation: -3, feedback: `${o.customer}: "Didn't do a thing for ${EFFECT_WORDS[o.need]}."`, learned, consumed: true };
}

const capital = (s: string) => s[0].toUpperCase() + s.slice(1);

/** Orders past their date: the customer gives up. */
export function expire(orders: Order[], absDay: number): Order[] {
  return orders.filter((o) => o.dueDay < absDay);
}

export type { PrepItem };
