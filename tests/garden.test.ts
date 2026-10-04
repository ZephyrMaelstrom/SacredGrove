/**
 * M8: the garden. Germination (soil warmth, moisture, stratification),
 * growth and care, life cycles, frost, divisions, seed saving, and
 * harvesting from the beds.
 */
import { describe, it, expect } from "vitest";
import { plantByLatin } from "../src/data/plants";
import type { DayWeather } from "../src/time/climate";
import { dayOfYear } from "../src/sim/phenology";
import {
  emptyGarden, plant, stepGarden, water, weed, chillNeeded, plantingLook, makeStock, sowable, stepStock,
  setsSeed, divisible, applyGardenHarvest, type GardenState,
} from "../src/game/garden";
import { harvest, collectSeed, type Target, type World } from "../src/game/forage";
import { HarvestState, emptyHarvestState } from "../src/game/harvestState";
import { newGame, restore } from "../src/game/state";
import { NEUTRAL_SEASON } from "../src/time/season";
import { appearance } from "../src/sim/phenology";
import type { HerbLot, StockItem } from "../src/game/items";

/** A Southern Illinois-like year: ~31 °F mean in January, ~79 °F in July, rain every fourth day. */
function wx(doy: number, opts: { dry?: boolean; frostOn?: number[] } = {}): DayWeather {
  const mean = 55 - 24 * Math.cos((2 * Math.PI * (doy - 20)) / 365);
  const rain = !opts.dry && doy % 4 === 0;
  const low = opts.frostOn?.includes(doy) ? 28 : mean - 10;
  return { doy, highF: mean + 10, lowF: low, precipMm: rain ? 9 : 0, condition: rain ? "rain" : "clear", cloud: rain ? 1 : 0.2, wind: 0.4, precipHours: null, fogUntil: 0, anomalyF: 0 };
}

/** Run the garden day by day; `care` runs each morning (watering etc.). */
function run(g: GardenState, fromAbs: number, days: number, opts: Parameters<typeof wx>[1] = {}, care?: (g: GardenState, doy: number) => void) {
  for (let d = fromAbs + 1; d <= fromAbs + days; d++) {
    const doy = ((d - 1) % 365) + 1, year = Math.floor((d - 1) / 365) + 1;
    care?.(g, doy);
    stepGarden(g, d, year, doy, wx(doy, opts));
  }
  return fromAbs + days;
}
const seed = (latin: string, count = 12, viability = 85) => makeStock("seed", plantByLatin(latin), count, viability, 1);
const keepWatered = (g: GardenState) => { for (let b = 0; b < g.beds.length; b++) { if (g.beds[b].moisture < 0.4) water(g, b); weed(g, b); } };

describe("germination", () => {
  it("chamomile sown in early April comes up within a few weeks", () => {
    const g = emptyGarden(0);
    const day0 = dayOfYear(4, 5);
    expect(plant(g, 0, seed("Matricaria chamomilla"), day0, 1).ok).toBe(true);
    run(g, day0, 35, {}, keepWatered);
    expect(g.slots[0]!.upDay).not.toBeNull();
    expect(g.slots[0]!.upDay! - day0).toBeLessThan(30);
  });
  it("warm-season calendula waits for warm soil", () => {
    const g = emptyGarden(0);
    const day0 = dayOfYear(3, 15);
    plant(g, 0, seed("Calendula officinalis"), day0, 1);
    run(g, day0, 20, {}, keepWatered);
    expect(g.slots[0]!.upDay).toBeNull();
  });
  it("native coneflower sown in spring without a winter never comes up, and the journal hint says why", () => {
    expect(chillNeeded(plantByLatin("Echinacea purpurea"))).toBeGreaterThan(0);
    const g = emptyGarden(0);
    const day0 = dayOfYear(4, 15);
    plant(g, 0, seed("Echinacea purpurea"), day0, 1);
    const notes: string[] = [];
    for (let d = day0 + 1; d < day0 + 300; d++) {
      const doy = ((d - 1) % 365) + 1;
      keepWatered(g);
      for (const n of stepGarden(g, d, 1, doy, wx(doy))) if (n.learn) notes.push(n.learn.note);
      if (g.slots[0]!.dead) break;
    }
    expect(g.slots[0]!.dead).toBe("never came up");
    expect(notes.join(" ")).toMatch(/cold/);
  });
  it("…but sown in fall it comes up the next spring", () => {
    const g = emptyGarden(0);
    const day0 = dayOfYear(11, 1);
    plant(g, 0, seed("Echinacea purpurea"), day0, 1);
    run(g, day0, 200, {}, (gg, doy) => { if (doy > 90) keepWatered(gg); });
    const pl = g.slots[0]!;
    expect(pl.upDay).not.toBeNull();
    const upDoy = ((pl.upDay! - 1) % 365) + 1;
    expect(upDoy).toBeGreaterThan(60);
    expect(upDoy).toBeLessThan(150);
  });
  it("seed kept in the root cellar over winter banks the chill", () => {
    const st = seed("Echinacea purpurea", 40);
    for (let doy = 320; doy < 365 + 75; doy++) {
      const d = ((doy - 1) % 365) + 1;
      const cellar = 53 + 9 * Math.sin(((d - 130) / 365) * 2 * Math.PI);
      stepStock(st, "cellar", cellar, 30);
    }
    expect(st.chill).toBeGreaterThanOrEqual(60);
    expect(st.viability).toBeGreaterThan(75);
    const g = emptyGarden(0);
    const day0 = 365 + dayOfYear(4, 10);
    plant(g, 0, st, day0, 2);
    run(g, day0, 60, {}, keepWatered);
    expect(g.slots[0]!.upDay).not.toBeNull();
  });
  it("dry storage keeps seed for years; out of soil, divisions wilt within days", () => {
    const s = seed("Matricaria chamomilla", 40, 90);
    for (let d = 0; d < 730; d++) stepStock(s, "tack", 50, 50);
    expect(s.viability).toBeGreaterThan(80);
    const div = makeStock("division", plantByLatin("Mentha × piperita"), 1, 80, 1);
    for (let d = 0; d < 10; d++) stepStock(div, "basket", 50, 70);
    expect(div.viability).toBeLessThan(40);
  });
});

describe("growing", () => {
  it("chamomile flowers about two months after it comes up", () => {
    const g = emptyGarden(0);
    const day0 = dayOfYear(4, 5);
    plant(g, 0, seed("Matricaria chamomilla"), day0, 1);
    let flowered = -1;
    for (let d = day0 + 1; d < day0 + 160 && flowered < 0; d++) {
      const doy = ((d - 1) % 365) + 1;
      keepWatered(g);
      stepGarden(g, d, 1, doy, wx(doy));
      const pl = g.slots[0]!;
      if (plantingLook(pl, plantByLatin(pl.latin), doy, 1, NEUTRAL_SEASON, d)?.stage === "flowering") flowered = d - pl.upDay!;
    }
    expect(flowered).toBeGreaterThan(40);
    expect(flowered).toBeLessThan(110);
  });
  it("a hot dry July kills an unwatered bed; watering saves it", () => {
    const grow = (care: boolean) => {
      const g = emptyGarden(0);
      const day0 = dayOfYear(4, 20);
      plant(g, 0, seed("Calendula officinalis"), day0, 1);
      run(g, day0, 60, {}, keepWatered);
      run(g, day0 + 60, 50, { dry: true }, care ? keepWatered : undefined);
      return g.slots[0]!;
    };
    expect(grow(false).dead).toBe("dried out");
    expect(grow(true).dead).toBeUndefined();
  });
  it("weeds slow growth", () => {
    const grow = (weeding: boolean) => {
      const g = emptyGarden(0);
      const day0 = dayOfYear(4, 20);
      plant(g, 0, seed("Calendula officinalis"), day0, 1);
      run(g, day0, 70, {}, (gg) => { water(gg, 0); if (weeding) weed(gg, 0); });
      return g.slots[0]!.size;
    };
    expect(grow(true)).toBeGreaterThan(grow(false) + 0.05);
  });
  it("frost kills tender calendula seedlings", () => {
    const g = emptyGarden(0);
    const day0 = dayOfYear(4, 10);
    plant(g, 0, seed("Calendula officinalis"), day0, 1);
    run(g, day0, 30, {}, keepWatered);
    const up = g.slots[0]!.upDay;
    expect(up).not.toBeNull();
    run(g, day0 + 30, 5, { frostOn: [day0 + 32] }, keepWatered);
    expect(g.slots[0]!.dead).toBe("killed by frost");
  });
  it("perennials from seed don't flower their first year, but do the next", () => {
    const p = plantByLatin("Tanacetum parthenium");
    const g = emptyGarden(0);
    const day0 = dayOfYear(4, 1);
    plant(g, 0, seed(p.latin), day0, 1);
    run(g, day0, 120, {}, keepWatered);
    const pl = g.slots[0]!;
    const midBloom = Math.round((p.phenology.flowerStart + p.phenology.flowerEnd) / 2);
    expect(plantingLook(pl, p, midBloom, 1)?.stage).not.toBe("flowering");
    run(g, day0 + 120, 365, {}, keepWatered);
    expect(plantingLook(pl, p, midBloom, 2)?.stage).toBe("flowering");
  });
  it("annuals finish and leave seed heads", () => {
    const g = emptyGarden(0);
    const day0 = dayOfYear(4, 5);
    plant(g, 0, seed("Matricaria chamomilla"), day0, 1);
    run(g, day0, 220, {}, keepWatered);
    expect(g.slots[0]!.dead).toMatch(/went to seed/);
  });
});

describe("planting stock", () => {
  it("only gardenable plants from seed, divisions or fresh roots", () => {
    expect(setsSeed(plantByLatin("Mentha × piperita"))).toBe(false);
    expect(divisible(plantByLatin("Mentha × piperita"))).toBe(true);
    expect(setsSeed(plantByLatin("Echinacea purpurea"))).toBe(true);
    const fresh: HerbLot = { kind: "herb", id: "r", latin: "Armoracia rusticana", productId: "SP141", productName: "Horseradish", part: "Root", grams: 80, potency: 70, harvestedDay: 1, moisture: 0.7, state: "fresh", mold: 0, ground: 0, updatedDay: 1 };
    expect(sowable(fresh)?.form).toBe("division");
    expect(sowable({ ...fresh, state: "dried", moisture: 0.08 })).toBeNull();
    const g = emptyGarden(0);
    expect(plant(g, 0, makeStock("seed", plantByLatin("Quercus alba"), 3, 80, 1), 100, 1).ok).toBe(false);
  });
  it("a division is up at once and establishes when watered", () => {
    const g = emptyGarden(0);
    const day0 = dayOfYear(4, 10);
    const div = makeStock("division", plantByLatin("Melissa officinalis"), 1, 80, day0);
    expect(plant(g, 0, div, day0, 1).ok).toBe(true);
    expect(div.count).toBe(0);
    run(g, day0, 60, {}, keepWatered);
    expect(g.slots[0]!.size).toBeGreaterThan(0.8);
  });
  it("cutting back a perennial regrows from the crown; digging takes it", () => {
    const g = emptyGarden(0);
    plant(g, 0, makeStock("division", plantByLatin("Melissa officinalis"), 1, 80, 100), 100, 1);
    g.slots[0]!.size = 1;
    const p = plantByLatin("Melissa officinalis");
    expect(applyGardenHarvest(g, 0, { ...p.products[0], part: "Whole" }, p, 150, 1)).toBe(false);
    expect(g.slots[0]!.size).toBeLessThan(0.5);
    expect(applyGardenHarvest(g, 0, { ...p.products[0], part: "Root" }, p, 151, 1)).toBe(true);
    expect(g.slots[0]).toBeNull();
  });
});

describe("in the field", () => {
  const world = { hash: 1, herbs: 10, woody: 2 };
  const target = (latin: string, layer: "h" | "g" = "h", index = 0): Target =>
    ({ layer, index, plant: plantByLatin(latin), cohort: 1, x: 0, z: 0, scale: 1, zone: "Light prairie", suitability: 0.8 });
  const at = (latin: string, doy: number): World => ({
    look: appearance(plantByLatin(latin), doy, 1), season: NEUTRAL_SEASON,
    weather: { ...wx(doy), condition: "clear", precipMm: 0 },
  });

  it("the seed envelope collects ripe seed, and tells you when it isn't ready", () => {
    const s = newGame(world);
    s.tool = "envelope";
    const hs = new HarvestState(emptyHarvestState(), () => 10);
    const p = plantByLatin("Echinacea purpurea");
    s.clock.doy = 120;
    const early = harvest(s, hs, target(p.latin), at(p.latin, 120));
    expect(early.ok).toBe(false);
    expect(early.detail).toMatch(/September/);
    s.clock.doy = 245;
    const r = collectSeed(s, hs, target(p.latin), at(p.latin, 245));
    expect(r.ok).toBe(true);
    const packet = s.basket.find((i) => i.kind === "stock") as StockItem;
    expect(packet.form).toBe("seed");
    expect(packet.count).toBeGreaterThan(5);
    expect(collectSeed(s, hs, target(p.latin), at(p.latin, 245)).ok).toBe(false); // already taken
  });
  it("the trowel lifts a peppermint division (it sets no seed)", () => {
    const s = newGame(world);
    const hs = new HarvestState(emptyHarvestState(), () => 10);
    s.tool = "envelope";
    expect(collectSeed(s, hs, target("Mentha × piperita"), at("Mentha × piperita", 220)).detail).toMatch(/division/);
    s.tool = "trowel";
    s.clock.doy = 120;
    const r = harvest(s, hs, target("Mentha × piperita"), at("Mentha × piperita", 120));
    expect(r.ok).toBe(true);
    expect((s.basket[0] as StockItem).form).toBe("division");
  });
  it("harvesting a garden plant gives garden-sized yields", () => {
    const s = newGame(world);
    const hs = new HarvestState(emptyHarvestState(), () => 10);
    const p = plantByLatin("Melissa officinalis");
    plant(s.garden, 3, makeStock("division", p, 1, 90, 100), 100, 1);
    Object.assign(s.garden.slots[3]!, { size: 1, health: 1 });
    s.clock.doy = 190;
    s.tool = "hand";
    const r = harvest(s, hs, target(p.latin, "g", 3), at(p.latin, 190));
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/garden/);
    expect(harvest(s, hs, target(p.latin, "g", 3), at(p.latin, 190)).message).toMatch(/picked over/);
  });
});

describe("saves", () => {
  const world = { hash: 1, herbs: 10, woody: 2 };
  it("a new game has the old owner's seed packets in the seed catalog", () => {
    const s = newGame(world);
    expect(s.storage.tack.filter((i) => i.kind === "stock").length).toBe(4);
    expect(s.garden.slots.length).toBe(24);
  });
  it("an M6/M7 save gains the garden and the packets", () => {
    const s = newGame(world) as unknown as Record<string, unknown>;
    s.version = 2;
    delete s.garden;
    (s.storage as { tack: unknown[] }).tack = [];
    const back = restore(JSON.stringify(s), world);
    expect(back.state.garden.slots.length).toBe(24);
    expect(back.state.storage.tack.length).toBe(4);
    expect(back.note).toMatch(/seed packets/);
  });
});

describe("field notes", () => {
  it("complete themselves from the save, in order shown", async () => {
    const { checkGoals, nextGoal, GOALS } = await import("../src/game/goals");
    const s = newGame({ hash: 1, herbs: 10, woody: 2 });
    expect(checkGoals(s)).toHaveLength(0);
    expect(nextGoal(s)?.id).toBe("identify");
    s.stats.harvests = 1;
    s.stats.planted = 1;
    expect(checkGoals(s).map((g) => g.id)).toEqual(["harvest", "sow"]);
    expect(checkGoals(s)).toHaveLength(0);
    expect(GOALS.length).toBeGreaterThanOrEqual(10);
  });
});
