/**
 * How this year's weather bends the plant calendar.
 *
 *   warm spring  → green-up and spring bloom come early (up to ~12 days);
 *                  cold spring → late. The effect fades for summer events.
 *   first fall frost (≤ 32 °F) kills frost-tender annuals overnight.
 *   first hard freeze (≤ 28 °F) ends the season for herbaceous perennials and
 *                  strips the leaves from trees a few days later.
 *   a late frost (≤ 30 °F) after a tree or shrub starts blooming kills the
 *                  blossoms: no fruit that year (persimmon, mulberry, cherry…).
 */
import type { YearWeather } from "./climate";

export interface SeasonAdjust {
  /** Days to shift spring events (negative = early). */
  springShift: number;
  /** First fall frost (DOY ≥ 182, low ≤ 32 °F), or null. */
  firstFrost: number | null;
  /** First hard freeze (DOY ≥ 182, low ≤ 28 °F), or null. */
  hardFreeze: number | null;
  /** Spring nights (DOY 60–181) at or below 30 °F. */
  springFrosts: number[];
  /** Last spring night at or below 32 °F. */
  lastSpringFrost: number | null;
}

export const NEUTRAL_SEASON: SeasonAdjust = {
  springShift: 0, firstFrost: null, hardFreeze: null, springFrosts: [], lastSpringFrost: null,
};

export function seasonFromWeather(w: YearWeather): SeasonAdjust {
  const springShift = Math.round(Math.max(-12, Math.min(12, -1.6 * w.springAnomalyF)));
  let firstFrost: number | null = null, hardFreeze: number | null = null, lastSpringFrost: number | null = null;
  const springFrosts: number[] = [];
  for (const d of w.days) {
    if (d.doy < 182) {
      if (d.lowF <= 32) lastSpringFrost = d.doy;
      if (d.doy >= 60 && d.lowF <= 30) springFrosts.push(d.doy);
    } else {
      if (firstFrost === null && d.lowF <= 32) firstFrost = d.doy;
      if (hardFreeze === null && d.lowF <= 28) hardFreeze = d.doy;
    }
  }
  return { springShift, firstFrost, hardFreeze, springFrosts, lastSpringFrost };
}

/** How far a spring event at `doy` moves this year. */
export function shiftFor(s: SeasonAdjust, doy: number): number {
  if (doy < 32 || doy > 182 || !s.springShift) return 0;
  const fade = Math.min(1, Math.max(0, (182 - doy) / 100));
  return Math.round(s.springShift * fade);
}
