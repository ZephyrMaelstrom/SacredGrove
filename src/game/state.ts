/**
 * Everything that belongs to a save: the clock, what you carry, what you know,
 * what you've done to the land, and how you're feeling.
 *
 * Saved to the browser (localStorage) when you sleep. Firebase sync comes
 * later; the format is plain JSON so it can move there unchanged.
 */
import { NEW_GAME_CLOCK, absDay, sleep, advance, MINUTES_PER_DAY, type ClockState, type ClockEvents } from "../time/clock";
import { emptyHarvestState, type HarvestStateData } from "./harvestState";
import type { Basket } from "./basket";
import type { Journal } from "./journal";
import type { Tool } from "./harvest";
import { hashString } from "../sim/random";
import plantsRaw from "../data/plants.gen.json";

export const SAVE_KEY = "rootwake.save.v1";
export const SAVE_VERSION = 1;

export interface Status {
  id: string;
  label: string;
  /** Absolute minute it wears off. */
  until: number;
}

export interface GameStateData {
  version: number;
  /** Identifies the generated world; harvest records only apply to the same world. */
  world: { hash: number; herbs: number; woody: number };
  clock: ClockState;
  tool: Tool;
  gloves: boolean;
  basket: Basket;
  /** Raw harvest unloaded at the barn (the storage rooms arrive in M6). */
  stores: Basket;
  journal: Journal;
  harvest: HarvestStateData;
  statuses: Status[];
  stats: { harvests: number; daysPlayed: number };
}

/** Changes whenever the plant data changes (placement depends on it). */
export const DATA_HASH = hashString(JSON.stringify(plantsRaw));

export const absMinute = (c: ClockState) => absDay(c) * MINUTES_PER_DAY + c.minutes;

export function newGame(world: GameStateData["world"]): GameStateData {
  return {
    version: SAVE_VERSION,
    world,
    clock: { ...NEW_GAME_CLOCK },
    tool: "hand",
    gloves: false,
    basket: [],
    stores: [],
    journal: {},
    harvest: emptyHarvestState(),
    statuses: [],
    stats: { harvests: 0, daysPlayed: 0 },
  };
}

export interface LoadResult {
  state: GameStateData;
  note: string | null;
}

/**
 * Restore a save. If the world has changed since it was written (new plant
 * data or placement code), the record of picked and dug plants no longer
 * points at the same plants, so it's cleared; everything else is kept.
 */
export function restore(json: string | null, world: GameStateData["world"]): LoadResult {
  if (!json) return { state: newGame(world), note: null };
  try {
    const s = JSON.parse(json) as GameStateData;
    if (s.version !== SAVE_VERSION) return { state: newGame(world), note: "Old save format; starting fresh." };
    const same = s.world?.hash === world.hash && s.world.herbs === world.herbs && s.world.woody === world.woody;
    if (!same) {
      s.harvest = emptyHarvestState();
      s.world = world;
      return { state: s, note: "The land was regrown since your last save (plant data changed), so picked and dug plants are back." };
    }
    s.statuses ??= [];
    s.stores ??= [];
    s.stats ??= { harvests: 0, daysPlayed: 0 };
    return { state: s, note: null };
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
