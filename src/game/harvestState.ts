/**
 * What the player has done to the land: which individual plants are picked
 * over, stripped, cut or dug, and which patches have been overharvested.
 *
 *   picked (leaves, twigs)  → the plant looks picked over and can't give more
 *                              until it regrows (days)
 *   stripped (flowers,      → that part is gone until next season
 *     fruit, seed)
 *   cut (whole plant)       → gone until next year
 *   dug (roots)             → gone for 1–6 years depending on the plant
 *                              (slow, conservative perennials take longest)
 *   wounded (bark)          → that tree can't be barked again for a year
 *   tapped (sap)            → once per tree per year
 *
 * Patch pressure: every plant species in every 8 m patch keeps a count of how
 * many individuals were removed this year. Take more than a third and, at the
 * new year, the patch is depleted: untouched plants thin out too, and dug
 * plants take twice as long to return. Depletion lasts 1–5 years.
 *
 * Individuals are keyed by their index in the deterministic population, so the
 * save stays valid as long as the world (plant data + placement) is unchanged;
 * GameState checks that and resets this record if it isn't.
 */
import type { Plant } from "../data/plants";
import { effectOf, recoveryYears, type Effect } from "./harvest";
import type { Product } from "../data/plants";
import { hashString } from "../sim/random";

export const PATCH_SIZE = 8;
export const OVERHARVEST = 1 / 3;

export interface IndividualState {
  /** Leaves/twigs picked over until this absolute day. */
  pickedUntil?: number;
  /** Parts stripped for the season, with the year they were taken. */
  stripped?: { part: string; year: number }[];
  /** Removed (cut or dug) in this year; back in returnYear. */
  removedYear?: number;
  returnYear?: number;
  /** Patch the plant was removed from (so depletion can delay its return). */
  patch?: string;
  /** Bark wounded until this absolute day. */
  woundedUntil?: number;
  /** Sap tapped in this year. */
  tappedYear?: number;
}

export interface PatchState {
  /** Individuals removed this calendar year. */
  removed: number;
  /** Depleted through this year (inclusive): fewer plants come up. */
  depletedThrough?: number;
  /** Fraction of untouched plants missing while depleted. */
  thin?: number;
}

export interface HarvestStateData {
  individuals: Record<string, IndividualState>;
  patches: Record<string, PatchState>;
}

export const emptyHarvestState = (): HarvestStateData => ({ individuals: {}, patches: {} });

export type Layer = "h" | "w"; // herb or woody population

export interface Visibility {
  hidden: boolean;
  /** Picked over: drawn smaller, without flowers or fruit. */
  reduced: boolean;
  /** Flowers / fruit / seed taken this season: draw the plant without them. */
  bare: boolean;
}

const VISIBLE: Visibility = { hidden: false, reduced: false, bare: false };

export const patchKey = (latin: string, x: number, z: number) =>
  `${latin}|${Math.floor(x / PATCH_SIZE)},${Math.floor(z / PATCH_SIZE)}`;

export class HarvestState {
  constructor(
    public data: HarvestStateData,
    /** How many individuals of a species stand in a patch (from the population). */
    private patchTotal: (key: string) => number,
  ) {}

  private key(layer: Layer, index: number) {
    return `${layer}${index}`;
  }
  get(layer: Layer, index: number): IndividualState | undefined {
    return this.data.individuals[this.key(layer, index)];
  }
  private ensure(layer: Layer, index: number): IndividualState {
    return (this.data.individuals[this.key(layer, index)] ??= {});
  }

  /** Can this part be taken from this individual today? Returns a reason if not. */
  blocked(layer: Layer, index: number, product: Product, plant: Plant, year: number, day: number): string | null {
    const s = this.get(layer, index);
    if (!s) return null;
    if (s.removedYear !== undefined && year < (s.returnYear ?? Infinity)) return "That plant is gone.";
    const eff = effectOf(product, plant);
    if (eff.kind === "regrow" && s.pickedUntil !== undefined && day < s.pickedUntil) {
      return `Already picked over; it needs about ${s.pickedUntil - day} more days to regrow.`;
    }
    if (eff.kind === "strip" && s.stripped?.some((p) => p.part === product.part && p.year === year)) {
      return `You already took the ${product.part.toLowerCase()} from this one this season.`;
    }
    if (eff.kind === "wound" && s.woundedUntil !== undefined && day < s.woundedUntil) {
      return "This tree is still healing from the last time you took bark.";
    }
    if (eff.kind === "tap" && s.tappedYear === year) return "You've already tapped this tree this year.";
    return null;
  }

  /** Record a harvest. `x, z` locate the individual's patch. */
  apply(layer: Layer, index: number, product: Product, plant: Plant, x: number, z: number, year: number, day: number): Effect {
    const eff = effectOf(product, plant);
    const s = this.ensure(layer, index);
    switch (eff.kind) {
      case "regrow":
        s.pickedUntil = day + eff.days;
        break;
      case "strip":
        s.stripped = (s.stripped ?? []).filter((p) => p.year === year);
        s.stripped.push({ part: product.part, year });
        break;
      case "cut":
      case "dig": {
        s.removedYear = year;
        s.returnYear = year + (eff.kind === "dig" ? recoveryYears(plant) : 1);
        const pk = patchKey(plant.latin, x, z);
        s.patch = pk;
        const p = (this.data.patches[pk] ??= { removed: 0 });
        p.removed++;
        break;
      }
      case "wound":
        s.woundedUntil = day + 365;
        break;
      case "tap":
        s.tappedYear = year;
        break;
    }
    return eff;
  }

  /** Fraction of this patch removed so far this year. */
  pressure(latin: string, x: number, z: number): number {
    const pk = patchKey(latin, x, z);
    const total = this.patchTotal(pk);
    return total > 0 ? (this.data.patches[pk]?.removed ?? 0) / total : 0;
  }

  /** How an individual should be drawn in `year` on absolute `day`. */
  visibility(layer: Layer, index: number, latin: string, x: number, z: number, year: number, day: number): Visibility {
    const s = this.get(layer, index);
    if (s?.removedYear !== undefined && year < (s.returnYear ?? Infinity)) return { hidden: true, reduced: false, bare: false };
    const pk = patchKey(latin, x, z);
    const patch = this.data.patches[pk];
    if (patch?.depletedThrough !== undefined && year <= patch.depletedThrough && patch.thin) {
      // Deterministic: the same plants are missing every time you look.
      if ((hashString(`${layer}${index}`) % 1000) / 1000 < patch.thin) return { hidden: true, reduced: false, bare: false };
    }
    if (!s) return VISIBLE;
    const reduced = s.pickedUntil !== undefined && day < s.pickedUntil;
    const bare = !!s.stripped?.some((p) => p.year === year);
    return reduced || bare ? { hidden: false, reduced, bare } : VISIBLE;
  }

  /**
   * New year: overharvested patches become depleted, plants whose time is up
   * come back, and this year's tallies reset.
   */
  rollover(newYear: number) {
    const lastYear = newYear - 1;
    for (const [pk, p] of Object.entries(this.data.patches)) {
      const total = this.patchTotal(pk);
      const frac = total > 0 ? p.removed / total : 0;
      if (frac > OVERHARVEST) {
        const years = Math.ceil(1 + 4 * Math.min(1, (frac - OVERHARVEST) / (1 - OVERHARVEST)));
        p.depletedThrough = lastYear + years;
        p.thin = Math.min(0.6, frac);
        // Plants taken from a depleted patch are slower to come back.
        for (const ind of Object.values(this.data.individuals)) {
          if (ind.patch === pk && ind.returnYear !== undefined && ind.removedYear === lastYear) ind.returnYear += years;
        }
      }
      p.removed = 0;
      if ((p.depletedThrough ?? 0) < newYear) delete this.data.patches[pk];
    }
    for (const [k, s] of Object.entries(this.data.individuals)) {
      if (s.returnYear !== undefined && s.returnYear <= newYear) {
        delete s.removedYear;
        delete s.returnYear;
        delete s.patch;
      }
      if (s.stripped) s.stripped = s.stripped.filter((p) => p.year >= newYear);
      if (!s.stripped?.length) delete s.stripped;
      if (Object.keys(s).length === 0) delete this.data.individuals[k];
    }
  }
}
