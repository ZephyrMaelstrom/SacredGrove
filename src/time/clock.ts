/**
 * The game clock.
 *
 * Time runs while you play: one game minute every SECONDS_PER_GAME_MINUTE real
 * seconds, so a 6 AM–midnight day lasts about a quarter hour. The calendar
 * date turns over at midnight. Stay up past 2 AM and you pass out and wake
 * at home.
 *
 * Pure TypeScript: no Babylon, safe in tests and the worker.
 */
import { DAYS_IN_YEAR, START_DOY, formatDoy } from "../sim/phenology";

export const MINUTES_PER_DAY = 1440;
export const WAKE_MINUTES = 6 * 60;
/** You pass out at 2 AM if you haven't gone to bed. */
export const PASS_OUT_MINUTES = 2 * 60;
/** Real seconds per game minute (override with ?minute=0.2 for testing). */
export const SECONDS_PER_GAME_MINUTE = 0.7;

export interface ClockState {
  year: number;
  doy: number;
  /** Minutes since midnight, 0–1439. */
  minutes: number;
}

export const NEW_GAME_CLOCK: ClockState = { year: 1, doy: START_DOY, minutes: 7 * 60 };

/** Days since the game began (year 1, day 1 = 1). Used for regrowth and freshness. */
export const absDay = (c: { year: number; doy: number }) => (c.year - 1) * DAYS_IN_YEAR + c.doy;

export interface ClockEvents {
  newDay: boolean;
  newYear: boolean;
  passedOut: boolean;
}

/** Advance by game minutes; reports what changed. */
export function advance(c: ClockState, gameMinutes: number): ClockEvents {
  const ev: ClockEvents = { newDay: false, newYear: false, passedOut: false };
  const before = c.minutes;
  c.minutes += gameMinutes;
  while (c.minutes >= MINUTES_PER_DAY) {
    c.minutes -= MINUTES_PER_DAY;
    nextDate(c, ev);
  }
  if (before < PASS_OUT_MINUTES && c.minutes >= PASS_OUT_MINUTES) ev.passedOut = true;
  else if (before > c.minutes && c.minutes >= PASS_OUT_MINUTES && c.minutes < WAKE_MINUTES) ev.passedOut = true;
  return ev;
}

function nextDate(c: ClockState, ev: ClockEvents) {
  ev.newDay = true;
  c.doy++;
  if (c.doy > DAYS_IN_YEAR) {
    c.doy = 1;
    c.year++;
    ev.newYear = true;
  }
}

/** Go to sleep now; wake at 6 AM on the right morning. */
export function sleep(c: ClockState): ClockEvents {
  const ev: ClockEvents = { newDay: false, newYear: false, passedOut: false };
  // Before midnight you wake tomorrow; after midnight you're already on tomorrow's date.
  if (c.minutes >= WAKE_MINUTES) nextDate(c, ev);
  else ev.newDay = true; // date already turned at midnight, but it's a new waking day
  c.minutes = WAKE_MINUTES;
  return ev;
}

export function formatTime(minutes: number): string {
  const h24 = Math.floor(minutes / 60) % 24, m = Math.floor(minutes % 60);
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h}:${String(m).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
}

const SEASONS = ["Winter", "Spring", "Summer", "Fall"];
export function seasonName(doy: number): string {
  // Meteorological seasons: Dec–Feb winter, Mar–May spring, …
  if (doy >= 335 || doy < 60) return SEASONS[0];
  if (doy < 152) return SEASONS[1];
  if (doy < 244) return SEASONS[2];
  return SEASONS[3];
}

export function formatDate(c: ClockState): string {
  return `${formatDoy(c.doy)}, Year ${c.year}`;
}
