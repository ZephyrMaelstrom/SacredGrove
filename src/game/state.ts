/**
 * Everything that belongs to a save: the clock, what you carry and store,
 * what you know, what you've done to the land, your money and reputation,
 * and how you're feeling.
 *
 * Saved to the browser (localStorage) when you sleep. The format is plain
 * JSON so it can move to Firebase unchanged.
 */
import { NEW_GAME_CLOCK, absDay, sleep, advance, MINUTES_PER_DAY, type ClockState, type ClockEvents } from "../time/clock";
import { emptyHarvestState, type HarvestStateData } from "./harvestState";
import type { Basket } from "./basket";
import type { Journal, Protocol } from "./journal";
import type { Tool } from "./harvest";
import type { Item, PrepItem } from "./items";
import { upgradeLot } from "./items";
import type { Order } from "./market";
import type { PlaceId } from "./storage";
import { hashString } from "../sim/random";
import { PLANTS } from "../data/plants";

export const SAVE_KEY = "rootwake.save.v1";
export const SAVE_VERSION = 2;

export interface Status {
  id: string;
  label: string;
  /** Absolute minute it wears off. */
  until: number;
}

export type StoragePlace = Exclude<PlaceId, "basket">;

export interface BrewJob {
  id: string;
  /** The finished preparation (made when started, handed over when done). */
  prep: PrepItem;
  startedAt: number;
  /** Absolute minute it's ready. */
  readyAt: number;
}

export interface GameStateData {
  version: number;
  /** Identifies the generated world; harvest records only apply to the same world. */
  world: { hash: number; herbs: number; woody: number };
  clock: ClockState;
  tool: Tool;
  gloves: boolean;
  basket: Basket;
  storage: Record<StoragePlace, Item[]>;
  /** Hayloft vent door. */
  ventOpen: boolean;
  journal: Journal;
  protocols: Record<string, Protocol>;
  harvest: HarvestStateData;
  statuses: Status[];
  /** Cents in your pocket. */
  money: number;
  /** Cents waiting in the stand's cash box. */
  cashBox: number;
  /** 0–100: how the neighbors talk about you. */
  reputation: number;
  orders: Order[];
  jobs: BrewJob[];
  /** Recent happenings, newest first. */
  ledger: { day: number; text: string }[];
  lastSimDay: number;
  stats: { harvests: number; daysPlayed: number; brews: number; sales: number; ordersDone: number };
}

/**
 * Changes whenever the plant ecology changes (placement depends on it).
 * Products, effects and prices are left out, so editing those in the
 * workbook doesn't regrow the land under an existing save.
 */
export const DATA_HASH = hashString(JSON.stringify(PLANTS.map(({ products: _p, notes: _n, ...eco }) => eco)));

export const absMinute = (c: ClockState) => absDay(c) * MINUTES_PER_DAY + c.minutes;

const emptyStorage = (): Record<StoragePlace, Item[]> => ({ loft: [], cellar: [], tack: [], shelf: [], stand: [] });

export function newGame(world: GameStateData["world"]): GameStateData {
  return {
    version: SAVE_VERSION,
    world,
    clock: { ...NEW_GAME_CLOCK },
    tool: "hand",
    gloves: false,
    basket: [],
    storage: emptyStorage(),
    ventOpen: true,
    journal: {},
    protocols: {},
    harvest: emptyHarvestState(),
    statuses: [],
    money: 500,
    cashBox: 0,
    reputation: 20,
    orders: [],
    jobs: [],
    ledger: [],
    lastSimDay: absDay(NEW_GAME_CLOCK),
    stats: { harvests: 0, daysPlayed: 0, brews: 0, sales: 0, ordersDone: 0 },
  };
}

export interface LoadResult {
  state: GameStateData;
  note: string | null;
}

/** Bring a version-1 save (M4–M5) up to the current format. */
function migrate(s: Record<string, unknown>): GameStateData {
  const old = s as unknown as GameStateData & { stores?: Item[] };
  const day = absDay(old.clock);
  const fresh = newGame(old.world);
  const out: GameStateData = { ...fresh, ...old, version: SAVE_VERSION };
  out.basket = (old.basket ?? []).map((l) => (l.kind === "prep" ? l : upgradeLot(l, day)));
  out.storage = emptyStorage();
  // What was unloaded "at the barn" in M5 was hung in the loft.
  out.storage.loft = (old.stores ?? []).map((l) => upgradeLot(l as never, day)).slice(0, 24);
  delete (out as unknown as { stores?: unknown }).stores;
  out.stats = { ...fresh.stats, ...(old.stats ?? {}) };
  out.lastSimDay = day;
  return out;
}

/**
 * Restore a save. If the world has changed since it was written (new plant
 * ecology or placement code), the record of picked and dug plants no longer
 * points at the same plants, so it's cleared; everything else is kept.
 */
export function restore(json: string | null, world: GameStateData["world"]): LoadResult {
  if (!json) return { state: newGame(world), note: null };
  try {
    let s = JSON.parse(json) as GameStateData;
    let note: string | null = null;
    if (s.version === 1) {
      s = migrate(s as unknown as Record<string, unknown>);
      note = "The barn's been fixed up: what you unloaded is hanging in the drying loft.";
    } else if (s.version !== SAVE_VERSION) {
      return { state: newGame(world), note: "Old save format; starting fresh." };
    }
    const same = s.world?.hash === world.hash && s.world.herbs === world.herbs && s.world.woody === world.woody;
    if (!same) {
      s.harvest = emptyHarvestState();
      s.world = world;
      note = "The land was regrown since your last save (plant data changed), so picked and dug plants are back.";
    }
    const fresh = newGame(world);
    for (const k of Object.keys(fresh) as (keyof GameStateData)[]) if (s[k] === undefined) (s as unknown as Record<string, unknown>)[k] = fresh[k];
    s.storage = { ...emptyStorage(), ...s.storage };
    return { state: s, note };
  } catch {
    return { state: newGame(world), note: "Couldn't read the save; starting fresh." };
  }
}

export function saveToStorage(s: GameStateData): boolean {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(s));
    return true;
  } catch {
    return false; // private mode, quota, blocked storage: play on without saving
  }
}

export function loadFromStorage(): string | null {
  try {
    return localStorage.getItem(SAVE_KEY);
  } catch {
    return null;
  }
}

export function clearStorage() {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    /* nothing to clear */
  }
}

export function log(s: GameStateData, text: string) {
  s.ledger.unshift({ day: absDay(s.clock), text });
  if (s.ledger.length > 40) s.ledger.length = 40;
}

// ---------------------------------------------------------------- statuses

export function addStatus(s: GameStateData, id: string, label: string, minutes: number) {
  const until = absMinute(s.clock) + minutes;
  const existing = s.statuses.find((x) => x.id === id);
  if (existing) existing.until = Math.max(existing.until, until);
  else s.statuses.push({ id, label, until });
}
export const hasStatus = (s: GameStateData, id: string) => s.statuses.some((x) => x.id === id && x.until > absMinute(s.clock));
export function pruneStatuses(s: GameStateData) {
  const now = absMinute(s.clock);
  s.statuses = s.statuses.filter((x) => x.until > now);
}

// ---------------------------------------------------------------- time

export function tick(s: GameStateData, gameMinutes: number): ClockEvents {
  const ev = advance(s.clock, gameMinutes);
  pruneStatuses(s);
  return ev;
}

export function goToSleep(s: GameStateData): ClockEvents {
  const ev = sleep(s.clock);
  s.stats.daysPlayed++;
  pruneStatuses(s);
  return ev;
}
