/**
 * Field notes: a short guide through the whole loop for a new player — find
 * plants, gather, dry, brew, learn, sell, fill an order, grow your own. Each
 * note checks the save, so it completes however you get there. The HUD shows
 * the next one; the satchel lists them all.
 */
import { isHerb, type HerbLot } from "./items";
import type { GameStateData } from "./state";

export interface Goal {
  id: string;
  title: string;
  hint: string;
  done: (s: GameStateData) => boolean;
}

const everywhere = (s: GameStateData) => [...s.basket, ...Object.values(s.storage).flat()];

export const GOALS: Goal[] = [
  { id: "identify", title: "Learn three plants", hint: "Look steadily at a plant until its name appears.", done: (s) => Object.values(s.journal).filter((e) => e.identified).length >= 3 },
  { id: "harvest", title: "Gather something", hint: "Hold the button on a plant within reach. Each tool takes different parts.", done: (s) => s.stats.harvests >= 1 },
  { id: "hang", title: "Hang a bundle in the hayloft", hint: "Barn, up the east stairs: use the drying racks. Open the vent on dry days.", done: (s) => s.storage.loft.some(isHerb) || everywhere(s).some((i) => isHerb(i) && (i as HerbLot).state === "dried") },
  { id: "dry", title: "Dry it well", hint: "A few dry days for leaves and flowers, weeks for roots. Shut the vent in the rain or it molds.", done: (s) => everywhere(s).some((i) => isHerb(i) && (i as HerbLot).state === "dried") },
  { id: "brew", title: "Brew at the apothecary bench", hint: "Barn, west wall. Pick a method, add herbs, brew. Dried herbs keep best on the jar shelf.", done: (s) => s.stats.brews >= 1 },
  { id: "learn", title: "Find out what a brew does", hint: "Taste it (single-herb brews teach the most) or let a customer tell you.", done: (s) => Object.values(s.protocols).some((p) => Object.keys(p.best).length > 0) },
  { id: "sell", title: "Sell something at the stand", hint: "Put things out at the roadside stand; passers-by buy during the day. Collect the cash box.", done: (s) => s.stats.sales >= 1 },
  { id: "order", title: "Fill a neighbor's order", hint: "Orders are on the stand's clipboard. Bring what they asked for in your basket.", done: (s) => s.stats.ordersDone >= 1 },
  { id: "sow", title: "Plant the garden", hint: "The old owner's seed is in the tack room's seed catalog. Raised beds are east of the house.", done: (s) => (s.stats.planted ?? 0) >= 1 },
  { id: "seed", title: "Save wild seed", hint: "Press 4 for the seed envelope; ripe seed heads come in late summer and fall.", done: (s) => (s.stats.seedsSaved ?? 0) >= 1 },
  { id: "grow", title: "Harvest from your own garden", hint: "Water in dry spells, pull weeds. Annuals flower in a couple of months.", done: (s) => (s.stats.gardenHarvests ?? 0) >= 1 },
  { id: "earn", title: "Save up $30", hint: "Good brews sell for more than raw herbs; orders pay best.", done: (s) => s.money + s.cashBox >= 3000 },
];

/** Mark newly finished notes; returns them (for a toast). */
export function checkGoals(s: GameStateData): Goal[] {
  const fresh: Goal[] = [];
  for (const g of GOALS) {
    if (s.goals.includes(g.id)) continue;
    if (g.done(s)) {
      s.goals.push(g.id);
      fresh.push(g);
    }
  }
  return fresh;
}

/** The next note to work on. */
export const nextGoal = (s: GameStateData): Goal | null => GOALS.find((g) => !s.goals.includes(g.id)) ?? null;
