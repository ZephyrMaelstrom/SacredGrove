/**
 * The homestead's work stations as plain data: what a panel shows and what
 * its buttons do. Desktop (DOM) and VR (Babylon GUI) both render the same
 * PanelView, so the two stay in step and the logic is tested once.
 *
 *   storage  loft racks · root cellar · seed catalog · jar shelf
 *   bench    the pot (method, water, time, lid), what's in it, the mortar,
 *            what's brewing, finished brews to taste
 *   stand    cash box, the order clipboard, what's for sale
 */
import { EFFECT_WORDS, type EffectTag } from "../data/plants";
import { absDay } from "../time/clock";
import type { DayWeather } from "../time/climate";
import type { StationId } from "../world/layout";
import { isHerb, isPrep, METHOD_NAMES, servings, type HerbLot, type Item, type Method } from "./items";
import { PLACES, conditions, herbCondition, canStore, type PlaceId } from "./storage";
import { canGrind, flavorWords, BREW_LIMITS } from "./apothecary";
import {
  collectCash, deliver, discard, findItem, grindItem, itemName, listOf, move, prepSummary, smell, startBrew, taste,
  money, value, MAX_POTS, type Result,
} from "./homestead";
import { STAND_RATE } from "./market";
import { absMinute, type GameStateData, type StoragePlace } from "./state";

// ---------------------------------------------------------------- view model

export interface Btn {
  label: string;
  act: string;
  warn?: boolean;
  on?: boolean;
  disabled?: boolean;
}
export interface Row {
  text: string;
  sub?: string;
  tone?: "dim" | "warn" | "good";
  /** 0–100 bar (potency, fineness). */
  bar?: number;
  buttons?: Btn[];
}
export interface Section {
  title?: string;
  note?: string;
  rows: Row[];
  buttons?: Btn[];
}
export interface PanelView {
  title: string;
  subtitle?: string;
  sections: Section[];
}

export interface BenchDraft {
  method: Method;
  waterMl: number;
  minutes: number;
  covered: boolean;
  /** item id → grams going in the pot. */
  picks: Record<string, number>;
  /** Herb lot in the mortar. */
  mortar: string | null;
}
export const newDraft = (): BenchDraft => ({ method: "hot", waterMl: 500, minutes: 10, covered: true, picks: {}, mortar: null });

export interface StationContext {
  /** Today's weather (for storage conditions). */
  weather: DayWeather;
}

const STORAGE: Partial<Record<StationId, StoragePlace>> = { loft: "loft", cellar: "cellar", tack: "tack", shelf: "shelf" };
export const isPanelStation = (id: StationId) => id in STORAGE || id === "bench" || id === "stand";

// ---------------------------------------------------------------- shared rows

function herbSub(s: GameStateData, l: HerbLot): string {
  const age = absDay(s.clock) - l.harvestedDay;
  const when = age === 0 ? "today" : age === 1 ? "yesterday" : `${age} days ago`;
  return `${l.part} · ${herbCondition(l)} · picked ${when}`;
}

export function itemRow(s: GameStateData, it: Item, buttons: Btn[] = []): Row {
  if (isPrep(it)) {
    const cups = servings(it);
    const left = it.spoilDay ? "" : "";
    return {
      text: `${it.name} · ${cups} cup${cups > 1 ? "s" : ""}`,
      sub: `${prepSummary(it)} · ${it.description}${left}`,
      tone: it.spoiled ? "warn" : it.known ? "good" : undefined,
      buttons,
    };
  }
  const ruined = it.state === "moldy" || it.state === "spoiled";
  return {
    text: `${itemName(s, it)} · ${it.grams} g`,
    sub: herbSub(s, it),
    bar: ruined ? 0 : Math.round(it.potency),
    tone: ruined ? "warn" : undefined,
    buttons,
  };
}

const humidWord = (h: number) => (h > 0.85 ? "very damp" : h > 0.7 ? "damp" : h > 0.55 ? "fair" : "dry");

// ---------------------------------------------------------------- views

export function viewStation(s: GameStateData, id: StationId, draft: BenchDraft, ctx: StationContext): PanelView {
  const place = STORAGE[id];
  if (place) return storageView(s, place, ctx);
  if (id === "bench") return benchView(s, draft);
  if (id === "stand") return standView(s);
  return { title: "", sections: [] };
}

function storageView(s: GameStateData, place: StoragePlace, ctx: StationContext): PanelView {
  const spec = PLACES[place];
  const here = s.storage[place];
  const c = conditions(place, ctx.weather, { ventOpen: s.ventOpen, crowding: here.length / spec.slots, doy: s.clock.doy });
  let subtitle = `${spec.hint} Today: ${humidWord(c.humidity)}, about ${Math.round(c.tempF)} °F.`;
  const sections: Section[] = [];
  if (place === "loft") {
    const wet = ctx.weather.precipMm > 0;
    const risk = c.humidity > 0.75 && here.some((i) => isHerb(i) && i.state === "fresh");
    subtitle += ` Vent ${s.ventOpen ? "open" : "shut"}.${risk ? " Fresh bundles will mold in air this damp." : ""}${wet && s.ventOpen ? " It's raining in through the vent." : ""}`;
    sections.push({ rows: [], buttons: [{ label: s.ventOpen ? "Shut the vent" : "Open the vent", act: "vent" }] });
  }
  sections.push({
    title: `${spec.name} · ${here.length}/${spec.slots}`,
    note: here.length ? undefined : "Empty.",
    rows: here.map((it) => itemRow(s, it, [
      { label: "Take", act: `take:${it.id}` },
      ...(isPrep(it) ? [{ label: "Taste", act: `taste:${it.id}`, warn: true }] : []),
      { label: "Toss", act: `toss:${it.id}`, warn: true },
    ])),
  });
  sections.push({
    title: "In your basket",
    note: s.basket.length ? undefined : "Nothing to put away.",
    rows: s.basket.map((it) => {
      const why = canStore(here, place, it);
      return itemRow(s, it, [{ label: why ? "Can't" : place === "loft" ? "Hang" : "Store", act: `store:${it.id}`, disabled: !!why }]);
    }),
  });
  return { title: spec.name, subtitle, sections };
}

function benchView(s: GameStateData, d: BenchDraft): PanelView {
  pruneDraft(s, d);
  const [lo, hi] = BREW_LIMITS.minutes[d.method];
  const sections: Section[] = [];
  const timeLabel = d.minutes >= 60 ? `${(d.minutes / 60).toFixed(d.minutes % 60 ? 1 : 0)} h` : `${d.minutes} min`;
  sections.push({
    title: "The pot",
    note: methodNote(d.method),
    rows: [
      { text: "Method", buttons: (["hot", "cold", "decoction"] as Method[]).map((m) => ({ label: METHOD_NAMES[m], act: `method:${m}`, on: d.method === m })) },
      { text: `Water ${d.waterMl} ml (${d.waterMl / 250} cup${d.waterMl > 250 ? "s" : ""})`, buttons: [{ label: "−", act: "water:-250", disabled: d.waterMl <= 250 }, { label: "+", act: "water:250", disabled: d.waterMl >= 2000 }] },
      { text: `${d.method === "decoction" ? "Simmer" : "Steep"} ${timeLabel}`, buttons: [{ label: "−", act: "min:-1", disabled: d.minutes <= lo }, { label: "+", act: "min:1", disabled: d.minutes >= hi }] },
      ...(d.method === "cold" ? [] : [{ text: d.covered ? "Lid on (keeps the aromatics in)" : "Lid off", buttons: [{ label: d.covered ? "Take lid off" : "Put lid on", act: "lid" }] }]),
    ],
  });
  const picks = Object.entries(d.picks);
  const total = picks.reduce((a, [, g]) => a + g, 0);
  sections.push({
    title: `In the pot · ${total} g`,
    note: picks.length ? undefined : "Add herbs from below.",
    rows: picks.map(([id, g]) => {
      const it = findItem(s, id)!.item;
      return { text: `${itemName(s, it)} · ${g} g`, sub: isHerb(it) ? herbSub(s, it) : "", buttons: [{ label: "−5 g", act: `pick:${id}:-5` }, { label: "+5 g", act: `pick:${id}:5` }, { label: "Out", act: `unpick:${id}` }] };
    }),
    buttons: [{ label: s.jobs.length >= MAX_POTS ? "All pots busy" : "Brew", act: "brew", disabled: !picks.length || s.jobs.length >= MAX_POTS }],
  });
  const m = d.mortar ? findItem(s, d.mortar)?.item : null;
  sections.push({
    title: "Mortar",
    note: m && isHerb(m) ? undefined : "Put a dried herb in the mortar to grind it. Powders give up their goodness faster; overdo it and the aroma goes.",
    rows: m && isHerb(m) ? [{
      text: `${itemName(s, m)} · ${m.grams} g`, sub: herbCondition(m), bar: Math.round(m.ground * 100),
      buttons: [{ label: "Grind ×10", act: "grind:10" }, { label: "Grind ×30", act: "grind:30" }, { label: "Empty", act: "unmortar" }],
    }] : [],
  });
  const now = absMinute(s.clock);
  if (s.jobs.length) {
    sections.push({
      title: "Brewing",
      rows: s.jobs.map((j) => ({ text: j.prep.name, sub: `${METHOD_NAMES[j.prep.method]} · ready in ${Math.max(1, Math.ceil(j.readyAt - now))} min` })),
    });
  }
  const herbs = [...s.basket, ...s.storage.shelf].filter((i): i is HerbLot => isHerb(i) && i.state !== "moldy" && i.state !== "spoiled");
  sections.push({
    title: "Herbs at hand (basket and jar shelf)",
    note: herbs.length ? undefined : "Nothing here to brew. Dried herbs go on the jar shelf; fresh ones can go straight in the pot.",
    rows: herbs.map((it) => itemRow(s, it, [
      { label: "+5 g", act: `pick:${it.id}:5`, disabled: (d.picks[it.id] ?? 0) >= it.grams },
      { label: "+1 g", act: `pick:${it.id}:1`, disabled: (d.picks[it.id] ?? 0) >= it.grams },
      { label: "Mortar", act: `mortar:${it.id}`, disabled: !!canGrind(it) || d.mortar === it.id },
    ])),
  });
  const preps = [...s.storage.shelf, ...s.basket].filter(isPrep);
  sections.push({
    title: "Finished brews",
    note: preps.length ? "Tasting is how you learn what a brew does. Single-herb brews teach you the most." : "Nothing finished yet.",
    rows: preps.map((p) => itemRow(s, p, [
      { label: "Taste", act: `taste:${p.id}`, warn: true },
      ...(s.basket.includes(p) ? [] : [{ label: "Take", act: `take:${p.id}` }]),
      { label: "Pour out", act: `toss:${p.id}`, warn: true },
    ])).map((r, k) => ({ ...r, sub: `${r.sub} · ${flavorWords(preps[k].flavor)}` })),
  });
  return { title: "Apothecary bench", subtitle: `${s.jobs.length}/${MAX_POTS} pots in use.`, sections };
}

function methodNote(m: Method) {
  if (m === "hot") return "Boiling water poured over, a few minutes. Gentle on leaves and flowers; roots and bark give little unless ground. A lid keeps the aromatics in; long steeps turn harsh.";
  if (m === "cold") return "Room-temperature water, hours. The only way to keep slippery mucilage intact; weak on most else.";
  return "Simmered on the stove. Pulls everything from roots and bark, drives off aromatics, and makes must-cook fruit safe.";
}

function standView(s: GameStateData): PanelView {
  const sections: Section[] = [];
  sections.push({
    title: `Cash box · ${money(s.cashBox)}`,
    rows: s.ledger.filter((l) => l.text.startsWith("Stand:")).slice(0, 2).map((l) => ({ text: l.text, tone: "dim" as const })),
    buttons: [{ label: "Collect", act: "collect", disabled: !s.cashBox }],
  });
  const today = absDay(s.clock);
  sections.push({
    title: "Order clipboard",
    note: s.orders.length ? "Bring what they asked for in your basket." : "No orders right now. Neighbors post new ones most days.",
    rows: s.orders.map((o) => {
      const cands = s.basket.filter((i) => (o.kind === "remedy" ? isPrep(i) && !i.spoiled : isHerb(i) && i.state === "dried"));
      const due = o.dueDay - today;
      return {
        text: o.text,
        sub: `${due <= 0 ? "due today" : `due in ${due} day${due > 1 ? "s" : ""}`} · pays ${money(o.rewardCents)}${cands.length ? "" : o.kind === "remedy" ? " · you have no brew with you" : " · you have no dried herbs with you"}`,
        tone: due <= 1 ? ("warn" as const) : undefined,
        buttons: cands.slice(0, 3).map((i) => ({ label: `Give ${shortName(itemName(s, i))}`, act: `give:${o.id}:${i.id}` })),
      };
    }),
  });
  const stand = s.storage.stand;
  sections.push({
    title: `For sale · ${stand.length}/${PLACES.stand.slots}`,
    note: stand.length ? `Passers-by pay about ${Math.round(STAND_RATE * 100)}% of value. Sales happen through the day; check the cash box in the morning.` : "Nothing out. Put things from your basket on the stand to sell them.",
    rows: stand.map((it) => itemRow(s, it, [{ label: "Take back", act: `take:${it.id}` }])),
  });
  sections.push({
    title: "From your basket",
    rows: s.basket.map((it) => {
      const why = canStore(stand, "stand", it);
      const r = itemRow(s, it, [{ label: why ? "Full" : "Put out", act: `store:${it.id}`, disabled: !!why }]);
      return { ...r, sub: `${r.sub} · worth about ${money(Math.round(value(it) * STAND_RATE))} here` };
    }),
  });
  return { title: "Roadside stand", subtitle: `Reputation ${Math.round(s.reputation)}/100 · ${money(s.money)} in your pocket`, sections };
}

const shortName = (n: string) => (n.length > 18 ? n.slice(0, 17) + "…" : n);

function pruneDraft(s: GameStateData, d: BenchDraft) {
  for (const id of Object.keys(d.picks)) {
    const f = findItem(s, id);
    if (!f || !isHerb(f.item) || f.item.state === "moldy" || f.item.state === "spoiled") delete d.picks[id];
    else d.picks[id] = Math.min(d.picks[id], f.item.grams);
  }
  if (d.mortar && !findItem(s, d.mortar)) d.mortar = null;
}

// ---------------------------------------------------------------- actions

const MIN_STEP: Record<Method, number> = { hot: 1, cold: 30, decoction: 5 };
const DEFAULT_MIN: Record<Method, number> = { hot: 10, cold: 240, decoction: 30 };

/** Carry out a button press. Returns a result to show (or null for silent UI changes). */
export function actStation(s: GameStateData, id: StationId, d: BenchDraft, act: string): Result | null {
  const [verb, a, b] = act.split(":");
  const place: PlaceId | undefined = id === "stand" ? "stand" : STORAGE[id];
  switch (verb) {
    case "take": return move(s, a, "basket");
    case "store": return place ? move(s, a, place) : null;
    case "toss": return discard(s, a);
    case "taste": return taste(s, a);
    case "smell": return smell(s, a);
    case "vent":
      s.ventOpen = !s.ventOpen;
      return { ok: true, message: s.ventOpen ? "You swing the loft vent open." : "You pull the loft vent shut." };
    case "method":
      d.method = a as Method;
      d.minutes = DEFAULT_MIN[d.method];
      return null;
    case "water":
      d.waterMl = Math.max(BREW_LIMITS.waterMl[0], Math.min(BREW_LIMITS.waterMl[1], d.waterMl + Number(a)));
      return null;
    case "min": {
      const [lo, hi] = BREW_LIMITS.minutes[d.method];
      d.minutes = Math.max(lo, Math.min(hi, d.minutes + Number(a) * MIN_STEP[d.method]));
      return null;
    }
    case "lid":
      d.covered = !d.covered;
      return null;
    case "pick": {
      const f = findItem(s, a);
      if (!f || !isHerb(f.item)) return null;
      const g = Math.max(0, Math.min(f.item.grams, (d.picks[a] ?? 0) + Number(b)));
      if (g <= 0) delete d.picks[a];
      else d.picks[a] = g;
      return null;
    }
    case "unpick":
      delete d.picks[a];
      return null;
    case "brew": {
      const r = startBrew(s, { method: d.method, waterMl: d.waterMl, minutes: d.minutes, covered: d.method === "cold" ? true : d.covered, picks: Object.entries(d.picks).map(([pid, grams]) => ({ id: pid, grams })) });
      if (r.ok) d.picks = {};
      return r;
    }
    case "mortar": {
      const f = findItem(s, a);
      if (!f || !isHerb(f.item)) return null;
      const why = canGrind(f.item);
      if (why) return { ok: false, message: why };
      d.mortar = a;
      return { ok: true, message: `${itemName(s, f.item)} in the mortar.` };
    }
    case "grind":
      return d.mortar ? grindItem(s, d.mortar, Number(a)) : null;
    case "unmortar":
      d.mortar = null;
      return null;
    case "collect": return collectCash(s);
    case "give": return deliver(s, a, b);
  }
  return null;
}

/** Words for an effect tag (for journal and panels). */
export const effectWord = (t: string) => EFFECT_WORDS[t as EffectTag] ?? t;
export { listOf };
