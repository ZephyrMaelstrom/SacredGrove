/**
 * Foraging rules, harvest pressure, the journal and saves.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { plantByLatin, type Plant } from "../src/data/plants";
import { appearance, dayOfYear } from "../src/sim/phenology";
import { NEUTRAL_SEASON } from "../src/time/season";
import { weatherOn, type DayWeather } from "../src/time/climate";
import { choose, toolFor, potency, recoveryYears, contactHazard, stageFit, type PlantContext, type Tool } from "../src/game/harvest";
import { HarvestState, emptyHarvestState, patchKey } from "../src/game/harvestState";
import { harvest, taste, smell, examine, type Target } from "../src/game/forage";
import { newGame, restore, hasStatus, DATA_HASH, type GameStateData } from "../src/game/state";
import { addToBasket, BASKET_CAPACITY_G } from "../src/game/basket";
import { WORLD_SEED } from "../src/sim/placement";

const ctx = (latin: string, m: number, d: number, cohort = 1): PlantContext => {
  const plant = plantByLatin(latin);
  const doy = dayOfYear(m, d);
  return { plant, look: appearance(plant, doy, cohort as 0 | 1), doy, season: NEUTRAL_SEASON, cohort };
};
const pickWith = (tool: Tool, latin: string, m: number, d: number, cohort = 1) => choose(tool, ctx(latin, m, d, cohort));
const calm: DayWeather = { doy: 150, highF: 80, lowF: 60, precipMm: 0, condition: "clear", cloud: 0.2, wind: 0.5, precipHours: null, fogUntil: 0, anomalyF: 0 };
const rainy: DayWeather = { ...calm, condition: "rain", cloud: 1, precipMm: 10, precipHours: [8, 16] };

describe("tools and parts", () => {
  it("digs roots with the trowel and cuts bark with the knife", () => {
    expect(toolFor("Root", plantByLatin("Taraxacum officinale"))).toBe("trowel");
    expect(toolFor("Bark", plantByLatin("Prunus serotina"))).toBe("knife");
    expect(toolFor("Flower", plantByLatin("Achillea millefolium"))).toBe("hand");
  });
  it("can dig a dandelion root any time the plant is visible", () => {
    for (const [m, d] of [[3, 10], [6, 1], [11, 1]]) {
      const p = pickWith("trowel", "Taraxacum officinale", m, d);
      expect(p.ok && p.product.part).toBe("Root");
    }
  });
  it("tells you which tool to use", () => {
    const p = pickWith("hand", "Arctium minus", 10, 1, 0);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toMatch(/trowel/i);
  });
  it("has no goldenrod flowers in March, plenty in September", () => {
    expect(pickWith("hand", "Solidago canadensis", 3, 10).ok).toBe(false);
    const fall = pickWith("hand", "Solidago canadensis", 9, 15);
    expect(fall.ok && fall.product.part).toBe("Flower");
  });
  it("prefers flowers over leaves when picking a flowering mullein", () => {
    const p = pickWith("hand", "Verbascum thapsus", 7, 10);
    expect(p.ok && p.product.part).toBe("Flower");
    const spring = pickWith("hand", "Verbascum thapsus", 4, 20);
    expect(spring.ok && spring.product.part).toBe("Leaf");
  });
  it("lets you gather rose hips into winter", () => {
    const p = pickWith("hand", "Rosa carolina", 11, 20);
    expect(p.ok && p.product.part).toBe("Fruit");
  });
  it("taps maple sap only in late winter", () => {
    const feb = pickWith("knife", "Acer saccharum", 2, 20);
    expect(feb.ok && feb.product.part).toBe("Sap");
    const jul = pickWith("knife", "Acer saccharum", 7, 1);
    expect(jul.ok && jul.product.part === "Sap").toBe(false);
  });
});

describe("quality", () => {
  const cond = { weather: calm, minutes: 13 * 60, suitability: 0.6, tool: "hand" as Tool, seed: 1, scale: 1 };
  it("peaks flowers mid-bloom", () => {
    const yarrow = plantByLatin("Achillea millefolium");
    const product = yarrow.products[0];
    const start = stageFit(product, ctx("Achillea millefolium", 5, 21));
    const mid = stageFit(product, ctx("Achillea millefolium", 7, 6));
    expect(mid).toBeGreaterThan(start);
  });
  it("prefers first-year burdock roots dug in fall over bolting ones", () => {
    const b = plantByLatin("Arctium minus").products[0];
    expect(potency(b, ctx("Arctium minus", 10, 20, 0), cond)).toBeGreaterThan(potency(b, ctx("Arctium minus", 7, 20, 1), cond));
  });
  it("marks down herbs picked wet in the rain", () => {
    const c = ctx("Monarda fistulosa", 7, 15);
    const pr = plantByLatin("Monarda fistulosa").products[0];
    expect(potency(pr, c, { ...cond, weather: rainy, minutes: 12 * 60 })).toBeLessThan(potency(pr, c, cond));
  });
  it("rewards plants growing where they thrive", () => {
    const c = ctx("Monarda fistulosa", 7, 15);
    const pr = plantByLatin("Monarda fistulosa").products[0];
    expect(potency(pr, c, { ...cond, suitability: 0.05 })).toBeLessThan(potency(pr, c, cond));
  });
  it("makes conservative plants slow to recover from digging", () => {
    expect(recoveryYears(plantByLatin("Eryngium yuccifolium"))).toBeGreaterThanOrEqual(4);
    expect(recoveryYears(plantByLatin("Taraxacum officinale"))).toBe(1);
    expect(recoveryYears(plantByLatin("Chenopodium album"))).toBe(1);
  });
});

describe("hazards", () => {
  it("gives a poison ivy rash bare-handed, nothing with gloves", () => {
    const pi = plantByLatin("Toxicodendron radicans");
    expect(contactHazard(pi, "hand", false, calm, 600)?.status).toBe("rash");
    expect(contactHazard(pi, "hand", true, calm, 600)).toBeNull();
  });
  it("burns with wild parsnip sap only in the sun", () => {
    const wp = plantByLatin("Pastinaca sativa");
    expect(contactHazard(wp, "knife", false, calm, 13 * 60)?.status).toBe("burn");
    expect(contactHazard(wp, "knife", false, rainy, 13 * 60)).toBeNull();
  });
});

const world = { hash: DATA_HASH ^ WORLD_SEED, herbs: 1000, woody: 10 };
function target(latin: string, index: number, x = 10, z = 200): Target {
  return { layer: "h", index, plant: plantByLatin(latin), cohort: 1, x, z, scale: 1, zone: "prairie", suitability: 0.5 };
}

describe("harvesting and the land", () => {
  let s: GameStateData;
  let hs: HarvestState;
  const at = (m: number, d: number) => { s.clock.doy = dayOfYear(m, d); s.clock.minutes = 12 * 60; };
  const worldOn = (p: Plant) => ({ look: appearance(p, s.clock.doy, 1), season: NEUTRAL_SEASON, weather: calm });
  beforeEach(() => {
    s = newGame(world);
    hs = new HarvestState(s.harvest, () => 9);
  });

  it("puts a harvest in the basket and identifies the plant", () => {
    at(7, 15);
    const t = target("Monarda fistulosa", 1);
    const r = harvest(s, hs, t, worldOn(t.plant));
    expect(r.ok).toBe(true);
    expect(s.basket.length).toBe(1);
    expect(s.journal["Monarda fistulosa"].identified).toBe(true);
    expect(r.detail).toMatch(/New journal entry/);
  });
  it("won't let you pick the same flowers twice in a season", () => {
    at(7, 15);
    const t = target("Monarda fistulosa", 1);
    expect(harvest(s, hs, t, worldOn(t.plant)).ok).toBe(true);
    const again = harvest(s, hs, t, worldOn(t.plant));
    expect(again.ok).toBe(false);
    expect(again.message).toMatch(/already/i);
  });
  it("hides a dug plant until it recovers, longer if you strip the patch", () => {
    s.tool = "trowel";
    at(10, 1);
    const plant = plantByLatin("Taraxacum officinale");
    // Patch of 9 dandelions; dig 5 (over a third).
    for (let i = 0; i < 5; i++) expect(harvest(s, hs, target("Taraxacum officinale", i, 10, 200), worldOn(plant)).ok).toBe(true);
    expect(hs.visibility("h", 0, plant.latin, 10, 200, 1, 300).hidden).toBe(true);
    expect(hs.pressure(plant.latin, 10, 200)).toBeCloseTo(5 / 9);
    hs.rollover(2);
    const patch = s.harvest.patches[patchKey(plant.latin, 10, 200)];
    expect(patch.depletedThrough).toBeGreaterThanOrEqual(2);
    // Dug dandelions normally return in a year; from a depleted patch it takes longer.
    expect(hs.visibility("h", 0, plant.latin, 10, 200, 2, 400).hidden).toBe(true);
  });
  it("lets a lightly harvested patch come back next year", () => {
    s.tool = "trowel";
    at(10, 1);
    const plant = plantByLatin("Taraxacum officinale");
    harvest(s, hs, target("Taraxacum officinale", 0, 10, 200), worldOn(plant));
    hs.rollover(2);
    expect(hs.visibility("h", 0, plant.latin, 10, 200, 2, 400).hidden).toBe(false);
    expect(Object.keys(s.harvest.patches)).toHaveLength(0);
  });
  it("gives poison ivy rash and remembers it in the journal", () => {
    at(9, 20);
    const t = target("Toxicodendron radicans", 3);
    const r = harvest(s, hs, t, worldOn(t.plant));
    expect(r.ok).toBe(true);
    expect(hasStatus(s, "rash")).toBe(true);
    expect(s.journal[t.plant.latin].notes.length).toBe(1);
  });
  it("respects basket capacity", () => {
    addToBasket(s.basket, { latin: "x", productId: "x", productName: "x", part: "Leaf", grams: BASKET_CAPACITY_G, potency: 50, harvestedDay: 1 });
    at(7, 15);
    const t = target("Monarda fistulosa", 1);
    expect(harvest(s, hs, t, worldOn(t.plant)).message).toMatch(/full/);
  });
  it("identifies on examination", () => {
    const t = target("Asclepias syriaca", 9);
    expect(examine(s, t).ok).toBe(true);
    expect(examine(s, t).ok).toBe(false);
  });
});

describe("smell and taste", () => {
  let s: GameStateData;
  const add = (latin: string, part?: string) => {
    const p = plantByLatin(latin);
    const product = part ? p.products.find((x) => x.part === part)! : p.products[0];
    addToBasket(s.basket, { latin, productId: product.id, productName: product.name, part: product.part, grams: 50, potency: 80, harvestedDay: 70 });
    return s.basket[s.basket.length - 1].id;
  };
  beforeEach(() => (s = newGame(world)));

  it("records smell notes", () => {
    const id = add("Monarda fistulosa");
    expect(smell(s, id).message).toMatch(/thyme|mint/i);
    expect(s.journal["Monarda fistulosa"].smelled.length).toBe(1);
  });
  it("makes you sick from pokeweed root and blocks further tasting", () => {
    const id = add("Phytolacca americana", "Root");
    const r = taste(s, id);
    expect(hasStatus(s, "nauseous")).toBe(true);
    expect(r.message).toMatch(/sick/);
    const id2 = add("Monarda fistulosa");
    expect(taste(s, id2).ok).toBe(false);
  });
  it("collapses you for a lethal plant and empties the basket", () => {
    const id = add("Datura stramonium");
    const r = taste(s, id);
    expect(r.collapse).toBe(true);
    expect(s.basket).toHaveLength(0);
    expect(s.journal["Datura stramonium"].notes.join(" ")).toMatch(/deadly/i);
  });
});

describe("saves", () => {
  it("round-trips through JSON", () => {
    const s = newGame(world);
    s.basket.push({ id: "a", latin: "x", productId: "SP001", productName: "x", part: "Leaf", grams: 10, potency: 50, harvestedDay: 70 });
    const back = restore(JSON.stringify(s), world);
    expect(back.state).toEqual(s);
    expect(back.note).toBeNull();
  });
  it("clears harvest records but keeps the rest when the world changed", () => {
    const s = newGame(world);
    s.harvest.individuals["h1"] = { pickedUntil: 99 };
    s.basket.push({ id: "a", latin: "x", productId: "SP001", productName: "x", part: "Leaf", grams: 10, potency: 50, harvestedDay: 70 });
    const back = restore(JSON.stringify(s), { ...world, herbs: 999 });
    expect(back.state.harvest).toEqual(emptyHarvestState());
    expect(back.state.basket).toHaveLength(1);
    expect(back.note).toMatch(/regrown/);
  });
  it("starts fresh from garbage", () => {
    expect(restore("{nope", world).state.clock.doy).toBe(dayOfYear(3, 10));
  });
});

describe("weather on a given day", () => {
  it("is available for any day of a year", () => {
    expect(weatherOn(1, 1, WORLD_SEED).doy).toBe(1);
    expect(weatherOn(5, 365, WORLD_SEED).doy).toBe(365);
  });
});
