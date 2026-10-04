/**
 * M6 + M7: storage (drying, mold, spoilage), the apothecary (grinding,
 * extraction, tasting, learning), the stand and orders, and the full loop.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { PLANTS } from "../src/data/plants";
import { weatherOn, type DayWeather } from "../src/time/climate";
import { WORLD_SEED } from "../src/sim/placement";
import { DAYS_IN_YEAR } from "../src/sim/phenology";
import { absDay } from "../src/time/clock";
import { servings, type HerbLot, type PrepItem } from "../src/game/items";
import { stepHerb, stepItems, conditions, canStore, PLACES } from "../src/game/storage";
import { brew, extraction, grind, canGrind, tastePrep, perceivedBitter, protocolKey } from "../src/game/apothecary";
import { value, simulateStandDay, makeOrder, deliver as deliverOrder, STAND_RATE, type Order } from "../src/game/market";
import { move, startBrew, finishJobs, catchUp, taste, deliver, collectCash, grindItem, MAX_POTS } from "../src/game/homestead";
import { newGame, restore, SAVE_VERSION, type GameStateData } from "../src/game/state";
import { addToBasket } from "../src/game/basket";
import { actStation, viewStation, newDraft } from "../src/game/stations";

const world = { hash: 1, herbs: 10, woody: 2 };
const calm: DayWeather = { doy: 200, highF: 82, lowF: 62, precipMm: 0, condition: "clear", cloud: 0.1, wind: 0.4, precipHours: null, fogUntil: 0, anomalyF: 0 };
const rain: DayWeather = { ...calm, condition: "rain", cloud: 1, precipMm: 14, precipHours: [6, 20] };
const lookup = (d: number) => {
  const year = Math.floor((d - 1) / DAYS_IN_YEAR) + 1, doy = ((d - 1) % DAYS_IN_YEAR) + 1;
  return { w: weatherOn(year, doy, WORLD_SEED), doy };
};

function lot(name: string, state: "fresh" | "dried" = "dried", opts: Partial<HerbLot> = {}): HerbLot {
  for (const p of PLANTS) for (const pr of p.products) if (pr.name === name) {
    return {
      kind: "herb", id: `${pr.id}-${Math.random()}`, latin: p.latin, productId: pr.id, productName: pr.name, part: pr.part,
      grams: 200, potency: 80, harvestedDay: 100, moisture: state === "fresh" ? 0.8 : 0.08, state, mold: 0, ground: 0, updatedDay: 100, ...opts,
    };
  }
  throw new Error(`no product ${name}`);
}
const tea = (ings: [HerbLot, number][], method: "hot" | "cold" | "decoction", ml: number, min: number, covered = true) =>
  brew({ method, waterMl: ml, minutes: min, covered, ingredients: ings.map(([l, grams]) => ({ lot: l, grams })) }, 100).prep;

// ================================================================ storage

describe("drying loft", () => {
  it("dries leaves in a few dry, airy days and keeps most of their potency", () => {
    const l = lot("German Chamomile", "fresh");
    let days = 0;
    while (l.state === "fresh" && days < 20) {
      stepHerb(l, "loft", conditions("loft", calm, { ventOpen: true, crowding: 0.2, doy: 200 }));
      days++;
    }
    expect(l.state).toBe("dried");
    expect(days).toBeGreaterThanOrEqual(3);
    expect(days).toBeLessThanOrEqual(7);
    expect(l.potency).toBeGreaterThan(60);
  });
  it("molds bundles hung in a crowded loft with the vent open through a wet spell", () => {
    const l = lot("Common Mullein", "fresh");
    for (let d = 0; d < 6 && l.state === "fresh"; d++) stepHerb(l, "loft", conditions("loft", rain, { ventOpen: true, crowding: 1, doy: 200 }));
    expect(l.state).toBe("moldy");
    expect(l.potency).toBe(0);
  });
  it("shutting the vent in the rain saves them", () => {
    const l = lot("Common Mullein", "fresh");
    for (let d = 0; d < 4; d++) stepHerb(l, "loft", conditions("loft", rain, { ventOpen: false, crowding: 0.3, doy: 200 }));
    expect(l.state).not.toBe("moldy");
  });
  it("roots take much longer to dry than leaves", () => {
    const leaf = lot("German Chamomile", "fresh"), root = lot("Burdock", "fresh");
    const c = conditions("loft", calm, { ventOpen: true, crowding: 0, doy: 200 });
    for (let d = 0; d < 8; d++) { stepHerb(leaf, "loft", c); stepHerb(root, "loft", c); }
    expect(leaf.state).toBe("dried");
    expect(root.state).toBe("fresh");
  });
});

describe("root cellar and other storage", () => {
  it("keeps roots fresh for weeks but rots leaves", () => {
    const root = lot("Burdock", "fresh"), leaf = lot("Common Mullein", "fresh");
    const c = conditions("cellar", calm, { ventOpen: true, crowding: 0.3, doy: 300 });
    for (let d = 0; d < 21; d++) { stepHerb(root, "cellar", c); stepHerb(leaf, "cellar", c); }
    expect(root.state).toBe("fresh");
    expect(root.potency).toBeGreaterThan(60);
    expect(leaf.state === "moldy" || leaf.state === "spoiled").toBe(true);
  });
  it("sealed jars keep dried herbs better than the loft", () => {
    const jar = lot("German Chamomile"), loft = lot("German Chamomile");
    for (let d = 0; d < 60; d++) {
      stepHerb(jar, "shelf", conditions("shelf", calm, { ventOpen: true, crowding: 0, doy: 200 }));
      stepHerb(loft, "loft", conditions("loft", calm, { ventOpen: true, crowding: 0, doy: 200 }));
    }
    expect(jar.potency).toBeGreaterThan(loft.potency);
    expect(jar.potency).toBeGreaterThan(55);
  });
  it("brews go sour in a couple of days, a few more in the cellar", () => {
    const p = tea([[lot("German Chamomile"), 4]], "hot", 500, 7);
    const shelf = [{ ...p }], cellar = [{ ...p }];
    stepItems(shelf, "shelf", () => ({ w: calm, doy: 200 }), p.madeDay + 3, { ventOpen: true, slots: 30 });
    stepItems(cellar, "cellar", () => ({ w: calm, doy: 200 }), p.madeDay + 3, { ventOpen: true, slots: 16 });
    expect((shelf[0] as PrepItem).spoiled).toBe(true);
    expect((cellar[0] as PrepItem).spoiled).toBeFalsy();
  });
  it("loft and seed catalog take plant material only, and places fill up", () => {
    const p = tea([[lot("German Chamomile"), 4]], "hot", 500, 7);
    expect(canStore([], "loft", p)).toMatch(/plant material/);
    expect(canStore([], "shelf", p)).toBeNull();
    const full = Array.from({ length: PLACES.stand.slots }, () => lot("Henbit"));
    expect(canStore(full, "stand", lot("Henbit"))).toMatch(/full/);
  });
  it("catches up every day since the last update", () => {
    const l = lot("German Chamomile", "fresh", { updatedDay: 100 });
    stepItems([l], "loft", () => ({ w: calm, doy: 200 }), 110, { ventOpen: true, slots: 24 });
    expect(l.updatedDay).toBe(110);
    expect(l.state).toBe("dried");
  });
});

// ================================================================ apothecary

describe("grinding", () => {
  it("only grinds dried material, and gets finer with work", () => {
    expect(canGrind(lot("Burdock", "fresh"))).toMatch(/Dry it first/);
    const l = lot("Burdock");
    grind(l, 14);
    expect(l.ground).toBeCloseTo(1 - Math.exp(-1), 2);
    grind(l, 40);
    expect(l.ground).toBeGreaterThan(0.9);
  });
  it("over-grinding an aromatic costs potency", () => {
    const l = lot("Virginia Mountain Mint");
    grind(l, 20);
    const before = l.potency;
    grind(l, 60);
    expect(l.potency).toBeLessThan(before);
  });
});

describe("extraction", () => {
  it("a lid keeps aromatics in a hot infusion", () => {
    const lid = extraction("hot", 7, true, "Flower", 0, false), open = extraction("hot", 7, false, "Flower", 0, false);
    expect(lid.VOL).toBeGreaterThan(open.VOL);
  });
  it("only a cold infusion keeps mucilage", () => {
    expect(extraction("cold", 240, true, "Leaf", 0, false).MUC).toBeGreaterThan(0.7);
    expect(extraction("decoction", 30, true, "Leaf", 0, false).MUC).toBeLessThan(0.15);
  });
  it("roots give little to a quick hot infusion unless ground or decocted", () => {
    const whole = extraction("hot", 10, true, "Root", 0, false).BIT;
    const ground = extraction("hot", 10, true, "Root", 0.9, false).BIT;
    const decoct = extraction("decoction", 30, true, "Root", 0, false).BIT;
    expect(ground).toBeGreaterThan(whole * 1.4);
    expect(decoct).toBeGreaterThan(whole * 1.4);
  });
});

describe("brewing", () => {
  it("chamomile tea is a gentle sleep and stomach remedy, better with the lid on", () => {
    const lid = tea([[lot("German Chamomile"), 4]], "hot", 250, 7, true);
    const open = tea([[lot("German Chamomile"), 4]], "hot", 250, 7, false);
    expect(lid.effects.sleep).toBeGreaterThan(0.3);
    expect(lid.effects.digestion).toBeGreaterThan(0.3);
    expect(lid.effects.sleep).toBeGreaterThan(open.effects.sleep);
    expect(lid.toxicity).toBeLessThan(0.05);
  });
  it("burdock root needs grinding and a decoction", () => {
    const quick = tea([[lot("Burdock"), 10]], "hot", 500, 10);
    const proper = tea([[lot("Burdock", "dried", { ground: 0.8 }), 10]], "decoction", 500, 30);
    expect(proper.effects.skin).toBeGreaterThan(quick.effects.skin + 0.15);
  });
  it("raw elderberries are harmful unless decocted", () => {
    const raw = tea([[lot("Elderberry", "fresh"), 40]], "hot", 500, 10);
    const cooked = tea([[lot("Elderberry", "fresh"), 40]], "decoction", 500, 30);
    expect(raw.toxicity).toBeGreaterThanOrEqual(0.3);
    expect(cooked.toxicity).toBeLessThan(0.12);
    expect(cooked.effects.immunity).toBeGreaterThan(0.5);
    expect(value(cooked)).toBeGreaterThan(value(raw) * 3);
  });
  it("jimsonweed and pokeweed are dangerous in small amounts", () => {
    expect(tea([[lot("Jimsonweed"), 2]], "hot", 250, 10).toxicity).toBeGreaterThanOrEqual(0.3);
    expect(tea([[lot("Pokeweed Root"), 5]], "decoction", 500, 30).toxicity).toBeGreaterThanOrEqual(0.6);
  });
  it("moldy material brings nothing good", () => {
    const p = tea([[lot("German Chamomile", "dried", { state: "moldy" }), 4]], "hot", 250, 7);
    expect(p.effects.sleep ?? 0).toBe(0);
    expect(p.toxicity).toBeGreaterThan(0);
  });
  it("mint softens a bitter herb", () => {
    const alone = tea([[lot("Motherwort"), 4]], "hot", 250, 10);
    const blend = tea([[lot("Motherwort"), 4], [lot("Virginia Mountain Mint"), 3]], "hot", 250, 10);
    expect(perceivedBitter(blend.flavor)).toBeLessThan(perceivedBitter(alone.flavor));
    expect(blend.effects.calm).toBeCloseTo(alone.effects.calm, 1);
  });
  it("decoctions boil down; more water dilutes", () => {
    const d = tea([[lot("Dandelion"), 8]], "decoction", 1000, 60);
    expect(d.volumeMl).toBeLessThan(700);
    const strong = tea([[lot("German Chamomile"), 4]], "hot", 250, 7), weak = tea([[lot("German Chamomile"), 4]], "hot", 1000, 7);
    expect(strong.effects.sleep).toBeGreaterThan(weak.effects.sleep);
  });
  it("names recipes by ingredients and proportions, not exact grams", () => {
    const a = { method: "hot" as const, waterMl: 250, minutes: 7, covered: true, ingredients: [{ lot: lot("German Chamomile"), grams: 4 }] };
    const b = { ...a, ingredients: [{ lot: lot("German Chamomile"), grams: 6 }] };
    expect(protocolKey(a)).toBe(protocolKey(b));
  });
});

describe("tasting a brew", () => {
  it("you feel the stronger effects", () => {
    const t = tastePrep(tea([[lot("German Chamomile"), 4]], "hot", 250, 7));
    expect(t.severity).toBe("none");
    expect(t.felt).toContain("sleep");
    expect(t.message).toMatch(/eyelids|stomach/);
  });
  it("harmful brews make you sick or worse", () => {
    expect(tastePrep(tea([[lot("Elderberry", "fresh"), 40]], "hot", 500, 10)).severity).toBe("sick");
    expect(tastePrep(tea([[lot("Pokeweed Root"), 5]], "decoction", 500, 30)).severity).toBe("collapse");
  });
});

// ================================================================ market

describe("the stand", () => {
  it("values good brews well above weak ones and harmful ones near nothing", () => {
    const good = tea([[lot("German Chamomile"), 4]], "hot", 250, 7);
    const weak = tea([[lot("Henbit"), 5]], "hot", 250, 8);
    const bad = tea([[lot("Jimsonweed"), 2]], "hot", 250, 10);
    expect(value(good)).toBeGreaterThan(value(weak) * 3);
    expect(value(bad)).toBeLessThan(20);
  });
  it("sells to passers-by, more on a fair weekend than a stormy weekday", () => {
    const stock = () => [tea([[lot("German Chamomile"), 8]], "hot", 1000, 7), lot("Virginia Mountain Mint"), lot("Common Mullein"), tea([[lot("Common Yarrow"), 10]], "hot", 1000, 10)];
    let fair = 0, storm = 0;
    for (let d = 0; d < 20; d++) {
      fair += simulateStandDay(stock(), 7 * d + 5, 180, calm, 50, WORLD_SEED).visitors;
      storm += simulateStandDay(stock(), 7 * d + 1, 180, { ...rain, condition: "storm" }, 50, WORLD_SEED).visitors;
    }
    expect(fair).toBeGreaterThan(storm * 2);
  });
  it("pays about 60% and removes what sold", () => {
    const stand = [tea([[lot("German Chamomile"), 8]], "hot", 1000, 7)];
    const full = value(stand[0]) / servings(stand[0]);
    let sales = simulateStandDay(stand, 5, 180, calm, 80, WORLD_SEED);
    for (let d = 6; !sales.sold.length && d < 40; d++) sales = simulateStandDay(stand, d, 180, calm, 80, WORLD_SEED);
    expect(sales.sold.length).toBeGreaterThan(0);
    expect(sales.sold[0].cents).toBeCloseTo(full * STAND_RATE, -1);
  });
  it("selling something harmful costs reputation", () => {
    const stand = Array.from({ length: 8 }, () => tea([[lot("Elderberry", "fresh"), 40]], "hot", 500, 10));
    let rep = 0;
    for (let d = 1; d < 10; d++) rep += simulateStandDay(stand, d, 320, calm, 50, WORLD_SEED).reputation;
    expect(rep).toBeLessThan(0);
  });
});

describe("orders", () => {
  const remedy = (need: Order["need"], minStrength = 0.35, extra: Partial<Order> = {}): Order => ({
    id: "o1", customer: "Mrs. Dillard", need, kind: "remedy", minStrength, maxBitter: null, cups: 1, grams: 0, teaOnly: false,
    postedDay: 1, dueDay: 5, rewardCents: 600, text: "", ...extra,
  });
  it("posts orders with sensible needs and rewards", () => {
    for (let d = 1; d < 60; d++) {
      const o = makeOrder(d, 20 + d, 30, WORLD_SEED);
      expect(o.dueDay - o.postedDay).toBeGreaterThanOrEqual(3);
      expect(o.rewardCents).toBeGreaterThan(100);
      expect(o.kind === "kitchen" ? o.grams : o.cups).toBeGreaterThan(0);
    }
  });
  it("a strong enough remedy succeeds and teaches what the herb does", () => {
    const d = deliverOrder(remedy("sleep"), tea([[lot("German Chamomile"), 4]], "hot", 250, 7));
    expect(d.outcome).toBe("success");
    expect(d.learned[0]).toMatchObject({ tag: "sleep", works: true });
  });
  it("the wrong herb fails and says so", () => {
    const d = deliverOrder(remedy("cough"), tea([[lot("German Chamomile"), 4]], "hot", 250, 7));
    expect(d.outcome).toBe("fail");
    expect(d.learned[0].works).toBe(false);
  });
  it("too bitter is only half a success", () => {
    const d = deliverOrder(remedy("calm", 0.4, { maxBitter: 0.3 }), tea([[lot("Motherwort"), 4]], "hot", 250, 10));
    expect(d.outcome).toBe("partial");
    expect(d.feedback).toMatch(/bitter/);
  });
  it("refuses the wrong kind of thing without using it up", () => {
    expect(deliverOrder(remedy("sleep"), lot("German Chamomile")).outcome).toBe("wrong");
    expect(deliverOrder(remedy("sleep", 0.3, { teaOnly: true }), tea([[lot("German Chamomile"), 4]], "decoction", 250, 10)).outcome).toBe("wrong");
  });
  it("harmful remedies are a disaster", () => {
    const d = deliverOrder(remedy("immunity"), tea([[lot("Elderberry", "fresh"), 40]], "hot", 500, 10));
    expect(d.outcome).toBe("harm");
    expect(d.reputation).toBeLessThan(-10);
  });
});

// ================================================================ the loop

describe("the full loop", () => {
  let s: GameStateData;
  const harvestInto = (name: string, grams = 150) => {
    const l = lot(name, "fresh");
    addToBasket(s.basket, { latin: l.latin, productId: l.productId, productName: l.productName, part: l.part, grams, potency: 85, harvestedDay: absDay(s.clock) });
    return s.basket[s.basket.length - 1].id;
  };
  const sleepDays = (n: number) => {
    for (let i = 0; i < n; i++) {
      s.clock.doy++;
      catchUp(s, lookup);
    }
  };
  beforeEach(() => {
    s = newGame(world);
    s.clock.doy = 160; // early June
    s.lastSimDay = absDay(s.clock);
    s.journal["Matricaria chamomilla"] = undefined as never;
    delete s.journal["Matricaria chamomilla"];
  });

  it("forage → dry in the loft → jar → brew → taste → sell at the stand → fill an order", () => {
    const id = harvestInto("German Chamomile", 200);
    expect(move(s, id, "loft").ok).toBe(true);
    s.ventOpen = true;
    sleepDays(8);
    const dried = s.storage.loft[0] as HerbLot;
    expect(["dried", "moldy"]).toContain(dried.state);
    if (dried.state === "moldy") dried.state = "dried"; // weather luck isn't what this test is about
    expect(move(s, dried.id, "shelf").ok).toBe(true);

    // Brew a big pot.
    const r = startBrew(s, { method: "hot", waterMl: 1000, minutes: 7, covered: true, picks: [{ id: dried.id, grams: 16 }] });
    expect(r.ok).toBe(true);
    expect(s.jobs).toHaveLength(1);
    expect(finishJobs(s)).toHaveLength(0); // not yet
    s.clock.minutes += 8;
    expect(finishJobs(s)).toHaveLength(1);
    const prep = s.storage.shelf.find((i) => i.kind === "prep") as PrepItem;
    expect(prep).toBeTruthy();

    // Taste it: the journal learns chamomile helps sleep (single-herb brew).
    const t = taste(s, prep.id);
    expect(t.ok).toBe(true);
    expect(s.journal[dried.latin].effects?.[dried.productId]).toContain("sleep");
    expect(Object.values(s.protocols)[0].best.sleep).toBeGreaterThan(0.2);

    // Fill an order with part of it…
    s.orders.push({ id: "o1", customer: "Miss Opal", need: "sleep", kind: "remedy", minStrength: 0.3, maxBitter: null, cups: 1, grams: 0, teaOnly: false, postedDay: 1, dueDay: absDay(s.clock) + 3, rewardCents: 700, text: "" });
    move(s, prep.id, "basket");
    const before = s.money, cups = prep.volumeMl;
    const d = deliver(s, "o1", prep.id);
    expect(d.ok).toBe(true);
    expect(s.money).toBe(before + 700);
    expect(s.orders.find((o) => o.id === "o1")).toBeUndefined();
    expect(prep.volumeMl).toBe(cups - 250);

    // …and put the rest out at the stand; by morning there's money in the cash box.
    expect(move(s, prep.id, "stand").ok).toBe(true);
    s.storage.stand.push(s.basket.length ? s.basket[0] : dried);
    for (let i = 0; i < 6 && !s.cashBox; i++) sleepDays(1);
    expect(s.cashBox).toBeGreaterThan(0);
    const c = collectCash(s);
    expect(c.ok).toBe(true);
    expect(s.cashBox).toBe(0);
  });

  it("limits pots and takes only what's used from a lot", () => {
    const id = harvestInto("Common Mullein", 100);
    for (let i = 0; i < MAX_POTS; i++) expect(startBrew(s, { method: "hot", waterMl: 250, minutes: 5, covered: true, picks: [{ id, grams: 10 }] }).ok).toBe(true);
    expect(startBrew(s, { method: "hot", waterMl: 250, minutes: 5, covered: true, picks: [{ id, grams: 10 }] }).ok).toBe(false);
    expect((s.basket[0] as HerbLot).grams).toBe(70);
  });

  it("posts and expires orders as days pass", () => {
    sleepDays(1);
    expect(s.orders.length).toBeGreaterThan(0);
    const first = s.orders[0];
    sleepDays(10);
    expect(s.orders.find((o) => o.id === first.id)).toBeUndefined();
    expect(s.orders.length).toBeLessThanOrEqual(3);
  });

  it("grinds only what's dry", () => {
    const id = harvestInto("Burdock", 100);
    expect(grindItem(s, id, 10).ok).toBe(false);
    (s.basket[0] as HerbLot).state = "dried";
    expect(grindItem(s, id, 10).ok).toBe(true);
  });
});

describe("stations", () => {
  it("bench: build a pot from buttons and brew it", () => {
    const s = newGame(world);
    s.storage.shelf.push(lot("German Chamomile"));
    const id = s.storage.shelf[0].id;
    const d = newDraft();
    actStation(s, "bench", d, "method:hot");
    actStation(s, "bench", d, `pick:${id}:5`);
    actStation(s, "bench", d, "water:-250");
    expect(d).toMatchObject({ waterMl: 250, picks: { [id]: 5 } });
    const v = viewStation(s, "bench", d, { weather: calm });
    expect(v.sections.some((sec) => sec.title?.startsWith("In the pot · 5 g"))).toBe(true);
    const r = actStation(s, "bench", d, "brew");
    expect(r?.ok).toBe(true);
    expect(s.jobs).toHaveLength(1);
    expect(d.picks).toEqual({});
  });
  it("storage: hang from the basket, take back, vent toggles", () => {
    const s = newGame(world);
    s.basket.push(lot("Common Mullein", "fresh"));
    const id = s.basket[0].id;
    expect(actStation(s, "loft", newDraft(), `store:${id}`)?.ok).toBe(true);
    expect(s.storage.loft).toHaveLength(1);
    const v = viewStation(s, "loft", newDraft(), { weather: rain });
    expect(v.subtitle).toMatch(/mold|raining/);
    actStation(s, "loft", newDraft(), "vent");
    expect(s.ventOpen).toBe(false);
    expect(actStation(s, "loft", newDraft(), `take:${id}`)?.ok).toBe(true);
    expect(s.basket).toHaveLength(1);
  });
  it("stand: offers basket brews to orders", () => {
    const s = newGame(world);
    s.orders.push(makeOrder(absDay(s.clock), 100, 20, WORLD_SEED));
    s.orders[0].kind = "remedy";
    s.basket.push(tea([[lot("German Chamomile"), 4]], "hot", 500, 7));
    const v = viewStation(s, "stand", newDraft(), { weather: calm });
    const orderRow = v.sections.find((x) => x.title === "Order clipboard")!.rows[0];
    expect(orderRow.buttons?.[0].act).toMatch(/^give:/);
  });
});

describe("saves", () => {
  it("round-trips the whole homestead", () => {
    const s = newGame(world);
    s.storage.loft.push(lot("German Chamomile", "fresh"));
    s.storage.shelf.push(tea([[lot("German Chamomile"), 4]], "hot", 250, 7));
    s.money = 1234;
    const back = restore(JSON.stringify(s), world);
    expect(back.state).toEqual(s);
  });
  it("migrates an M5 save: unloaded stores go to the loft", () => {
    const v1 = { ...newGame(world), version: 1, stores: [{ id: "a", latin: "Matricaria chamomilla", productId: "x", productName: "x", part: "Flower", grams: 50, potency: 70, harvestedDay: 70 }] } as Record<string, unknown>;
    delete v1.storage;
    delete v1.money;
    const back = restore(JSON.stringify(v1), world);
    expect(back.state.version).toBe(SAVE_VERSION);
    expect(back.state.storage.loft).toHaveLength(1);
    expect((back.state.storage.loft[0] as HerbLot).state).toBe("fresh");
    expect(back.state.money).toBe(500);
    expect(back.note).toMatch(/loft/);
  });
});
