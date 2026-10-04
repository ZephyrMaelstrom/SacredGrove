/**
 * Phenology: what a plant looks like on a given day of the year.
 *
 * Every plant runs through the same cycle, read from its day-of-year columns:
 *
 *   winter form ─▶ emerging ─▶ vegetative ─▶ flowering ─▶ fruiting ─▶ senescent ─▶ winter form
 *   (dormant)      green-up                  flower start  flower end   dieback-20    dieback
 *
 * Windows may wrap the new year: a winter annual that greens up in October
 * (DOY 290) and dies back in June (DOY 160) is active through the winter.
 *
 * Biennials split into two cohorts per patch, as they do in a real field:
 * first-year plants stay a basal rosette all season; second-year plants bolt,
 * flower, and leave a dead stalk standing through the following winter.
 */
import type { Plant } from "../data/plants";
import { NEUTRAL_SEASON, shiftFor, type SeasonAdjust } from "../time/season";

export type Stage = "absent" | "winter" | "emerging" | "vegetative" | "flowering" | "fruiting" | "senescent";

/**
 * How the plant should be drawn. Each (plant, visual) pair is one mesh
 * prototype, so this list is deliberately short.
 */
export type Visual =
  | "basal"         // low rosette of leaves
  | "vegetative"    // full leafy form, no flowers
  | "flowering"     // leafy form with flowers in the flower colour
  | "fruiting"      // leafy form with seed heads / fruit
  | "senescent"     // yellowing, collapsing
  | "standing"      // dead stalks and seed heads (winter)
  | "dormantClump"  // dormant grass/sedge bunch (winter)
  | "bare";         // leafless woody plant (winter)

export interface Appearance {
  stage: Stage;
  visual: Visual | null;
  /** Size multiplier through the season: small when emerging, full size from flowering on. */
  growth: number;
  /** Woody plants: is the plant in leaf? (Spicebush flowers on bare twigs.) */
  leafy: boolean;
  /** A late frost killed this year's blossoms: no fruit. */
  fruitFailed?: boolean;
  /** Blackened by frost (the few days after a killing frost). */
  frostKilled?: boolean;
}

export const DAYS_IN_YEAR = 365;
const NEVER = 999;
const EMERGE_DAYS = 21;
const SENESCE_DAYS = 20;
const FRUIT_HOLD_DAYS = 75;

/** Day count from a to b going forward around the year (0–364). */
export const daysFrom = (a: number, b: number) => (((b - a) % DAYS_IN_YEAR) + DAYS_IN_YEAR) % DAYS_IN_YEAR;

/** Is `d` inside the window [a, b], allowing the window to wrap the new year? */
export function inWindow(d: number, a: number, b: number): boolean {
  return a <= b ? d >= a && d <= b : d >= a || d <= b;
}

/** Biennial cohort: 0 = first-year rosette, 1 = second-year (bolting) plant. */
export type Cohort = 0 | 1;

const winterLook = (p: Plant, cohort: Cohort): Appearance => {
  const absent: Appearance = { stage: "absent", visual: null, growth: 0, leafy: false };
  // Annuals spend their off-season as seed in the soil, whatever the season is.
  if (p.cycle === "winterAnnual" || p.cycle === "summerAnnual") return absent;
  if (p.cycle === "biennial") {
    // First-years wait as rosettes; last year's bolters stand dead.
    if (cohort === 0) return { stage: "winter", visual: "basal", growth: 0.7, leafy: true };
    return p.phenology.winterForm === "none" ? absent : { stage: "winter", visual: "standing", growth: 1, leafy: false };
  }
  switch (p.phenology.winterForm) {
    case "none": return absent;
    case "rosette": return { stage: "winter", visual: "basal", growth: 0.75, leafy: true };
    case "mat": return { stage: "winter", visual: "vegetative", growth: 0.8, leafy: true };
    case "standing": return { stage: "winter", visual: "standing", growth: 1, leafy: false };
    case "clump": return { stage: "winter", visual: "dormantClump", growth: 1, leafy: false };
    case "evergreen": return { stage: "winter", visual: "vegetative", growth: 1, leafy: true };
    case "bare": return { stage: "winter", visual: "bare", growth: 1, leafy: false };
  }
};

const wrapDoy = (d: number) => ((((d - 1) % DAYS_IN_YEAR) + DAYS_IN_YEAR) % DAYS_IN_YEAR) + 1;

/** This year's calendar for a plant: spring shifts, frost kill, failed fruit. */
export function adjustedPhenology(p: Plant, s: SeasonAdjust) {
  const ph = p.phenology;
  const woody = p.form === "tree" || p.form === "shrub";
  const shift = (d: number) => (d === NEVER ? d : wrapDoy(d + shiftFor(s, d)));
  const greenUp = shift(ph.greenUp), flowerStart = shift(ph.flowerStart), flowerEnd = shift(ph.flowerEnd);
  const fruitRipe = shift(ph.fruitRipe);

  // Killing frost ends the season early for plants that can't take it.
  let kill: number | null = null;
  if (ph.dieback !== NEVER && ph.dieback > 182) {
    if (woody) kill = s.hardFreeze !== null ? s.hardFreeze + 5 : null;
    else if (p.cycle === "summerAnnual") kill = s.firstFrost;
    else if ((p.cycle === "perennial" || p.cycle === "biennial") && ph.winterForm !== "evergreen") kill = s.hardFreeze;
    if (kill !== null && (kill >= ph.dieback || kill < 182)) kill = null;
  }

  // A hard frost on open blossoms means no fruit this year.
  const fruitFailed = woody && flowerStart < 182 &&
    s.springFrosts.some((f) => inWindow(f, flowerStart, wrapDoy(flowerEnd + 10)));

  return { greenUp, flowerStart, flowerEnd, fruitRipe, dieback: ph.dieback, kill, fruitFailed };
}

export function appearance(p: Plant, doy: number, cohort: Cohort = 1, s: SeasonAdjust = NEUTRAL_SEASON): Appearance {
  const ph = adjustedPhenology(p, s);
  const woody = p.form === "tree" || p.form === "shrub";
  const alwaysActive = ph.dieback === NEVER;
  let active = alwaysActive || inWindow(doy, ph.greenUp, ph.dieback);
  const inBloom = inWindow(doy, ph.flowerStart, ph.flowerEnd);

  // Frost-killed: a few days blackened, then the plant's winter form.
  if (active && ph.kill !== null && inWindow(doy, ph.kill, ph.dieback)) {
    if (!woody && doy - ph.kill < 4 && !(p.cycle === "biennial" && cohort === 0)) {
      return { stage: "senescent", visual: "senescent", growth: 1, leafy: true, frostKilled: true };
    }
    active = false;
  }

  if (!active) {
    // Woody plants that bloom before leafing out show their flowers on bare wood.
    if (woody && inBloom) return { stage: "flowering", visual: "flowering", growth: 1, leafy: false, fruitFailed: ph.fruitFailed };
    return winterLook(p, cohort);
  }

  // Everything below is measured in days since green-up, so seasons that wrap
  // the new year (winter annuals) work exactly like summer ones.
  const t = daysFrom(ph.greenUp, doy);
  const season = alwaysActive ? DAYS_IN_YEAR : daysFrom(ph.greenUp, ph.dieback);
  const fStart = daysFrom(ph.greenUp, ph.flowerStart);
  const fEnd = daysFrom(ph.greenUp, ph.flowerEnd);
  const bloomInSeason = fStart <= fEnd && fEnd <= season;

  if (p.cycle === "biennial" && cohort === 0) {
    const growth = Math.min(1, 0.35 + t / 90);
    return { stage: t < EMERGE_DAYS ? "emerging" : "vegetative", visual: "basal", growth, leafy: true };
  }
  if (inBloom) return { stage: "flowering", visual: "flowering", growth: 1, leafy: true, fruitFailed: ph.fruitFailed };
  if (!alwaysActive && season - t <= SENESCE_DAYS) {
    return { stage: "senescent", visual: woody ? "vegetative" : "senescent", growth: 1, leafy: true };
  }
  // Seed heads hold until dieback; evergreens drop them after a couple of months.
  const fruitDays = alwaysActive ? FRUIT_HOLD_DAYS : Infinity;
  if (bloomInSeason && t > fEnd && t - fEnd <= fruitDays) {
    if (ph.fruitFailed) return { stage: "vegetative", visual: "vegetative", growth: 1, leafy: true, fruitFailed: true };
    return { stage: "fruiting", visual: "fruiting", growth: 1, leafy: true };
  }
  if (t < EMERGE_DAYS) {
    return { stage: "emerging", visual: "vegetative", growth: 0.25 + 0.35 * (t / EMERGE_DAYS), leafy: true };
  }
  const toFlower = bloomInSeason && fStart > 0 ? fStart : season;
  return { stage: "vegetative", visual: "vegetative", growth: Math.min(1, 0.6 + 0.4 * (t / toFlower)), leafy: true };
}

/** Day of year for a calendar date (non-leap year is close enough for plants). */
export function dayOfYear(month: number, day: number): number {
  const starts = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  return starts[month - 1] + day;
}

export function formatDoy(doy: number): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const starts = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  let m = 11;
  while (m > 0 && doy <= starts[m]) m--;
  return `${months[m]} ${doy - starts[m]}`;
}

/** The game opens on March 10. */
export const START_DOY = dayOfYear(3, 10);
