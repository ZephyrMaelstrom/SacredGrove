/**
 * Ecology tests: the world has to stay botanically believable as the code
 * changes. Each test states a real field pattern the simulation must keep.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { PLANTS, plantByLatin, PLANT_INDEX } from "../src/data/plants";
import { computeHabitat, ZONE_ORDER, SUBSTRATE, LAYER_KEYS, type HabitatLayers } from "../src/sim/habitat";
import { populate, plantsForMap, type Population } from "../src/sim/placement";
import { NODE_COUNT, nodeAt } from "../src/sim/grid";
import { SITE } from "../src/world/map";

let L: HabitatLayers;
let pop: Population;
beforeAll(() => {
  L = computeHabitat();
  pop = populate(L);
});

const zoneOf = (n: number) => ZONE_ORDER[L.zone[n]];
const meanOver = (layer: Float32Array, zone: string) => {
  let s = 0, c = 0;
  for (let n = 0; n < NODE_COUNT; n++) if (zoneOf(n) === zone) { s += layer[n]; c++; }
  return s / c;
};
function countsByZone(latin: string) {
  const idx = PLANT_INDEX.get(latin)!;
  const out = new Map<string, number>();
  for (const set of [pop.herbs, pop.woody]) {
    for (let k = 0; k < set.count; k++) {
      if (set.plant[k] !== idx) continue;
      const z = zoneOf(set.node[k]);
      out.set(z, (out.get(z) ?? 0) + 1);
    }
  }
  return out;
}
const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
function topInZone(zone: string, n: number) {
  const tally = new Map<number, number>();
  for (let k = 0; k < pop.herbs.count; k++) {
    if (zoneOf(pop.herbs.node[k]) !== zone) continue;
    tally.set(pop.herbs.plant[k], (tally.get(pop.herbs.plant[k]) ?? 0) + 1);
  }
  return [...tally].sort((a, b) => b[1] - a[1]).slice(0, n).map(([p]) => PLANTS[p].latin);
}

describe("habitat (M2)", () => {
  it("keeps every continuous layer in 0–1", () => {
    for (const k of LAYER_KEYS) {
      for (let n = 0; n < NODE_COUNT; n++) {
        expect(L[k][n]).toBeGreaterThanOrEqual(0);
        expect(L[k][n]).toBeLessThanOrEqual(1);
      }
    }
  });
  it("is deterministic", () => {
    const again = computeHabitat();
    for (const k of LAYER_KEYS) expect(again[k]).toEqual(L[k]);
  });
  it("puts buildings on built ground with no light", () => {
    const n = nodeAt(SITE.barn.x, SITE.barn.z);
    expect(L.substrate[n]).toBe(SUBSTRATE.built);
    expect(L.light[n]).toBe(0);
  });
  it("shades the woods and the ground north of the barn", () => {
    expect(meanOver(L.light, "treeline")).toBeLessThan(0.3);
    const north = nodeAt(SITE.barn.x, SITE.barn.z + SITE.barn.d / 2 + 2);
    expect(L.light[north]).toBeLessThan(0.7);
  });
  it("makes the ditch wetter than the yard and the remnant knoll the driest ground", () => {
    expect(meanOver(L.moisture, "ditch")).toBeGreaterThan(meanOver(L.moisture, "yard"));
    expect(meanOver(L.moisture, "remnant")).toBeLessThan(meanOver(L.moisture, "prairie"));
  });
  it("concentrates fertility and disturbance in the barnyard", () => {
    for (const z of ["prairie", "yard", "remnant"]) {
      expect(meanOver(L.fertility, "barnyard")).toBeGreaterThan(meanOver(L.fertility, z));
      expect(meanOver(L.disturbance, "barnyard")).toBeGreaterThan(meanOver(L.disturbance, z));
    }
  });
  it("marks only the remnant, fencerows and woods as never plowed", () => {
    for (let n = 0; n < NODE_COUNT; n++) {
      const z = zoneOf(n);
      if (["remnant", "fencerow", "edge", "treeline"].includes(z)) expect(L.plowed[n]).toBe(0);
      if (["prairie", "yard", "barnyard"].includes(z)) expect(L.plowed[n]).toBe(1);
    }
  });
});

describe("plant placement (M3)", () => {
  it("is deterministic from the world seed", () => {
    const again = populate(L);
    expect(again.herbs.count).toBe(pop.herbs.count);
    expect(again.herbs.plant).toEqual(pop.herbs.plant);
    expect(again.woody.x).toEqual(pop.woody.x);
  });
  it("places every Map 1 plant somewhere", () => {
    const { herbs, woody, logFungi } = plantsForMap(1);
    for (const i of [...herbs, ...woody, ...logFungi]) {
      expect(total(countsByZone(PLANTS[i].latin)), PLANTS[i].name).toBeGreaterThan(0);
    }
  });
  it("never puts a plant inside a building", () => {
    for (const set of [pop.herbs, pop.woody]) {
      for (let k = 0; k < set.count; k++) {
        const n = set.node[k];
        if (PLANTS[set.plant[k]].host === "wood") continue;
        expect(L.substrate[n]).not.toBe(SUBSTRATE.built);
      }
    }
  });
  it("keeps conservative prairie plants (C ≥ 6) on never-plowed ground", () => {
    for (let k = 0; k < pop.herbs.count; k++) {
      if (PLANTS[pop.herbs.plant[k]].cValue >= 6) expect(L.plowed[pop.herbs.node[k]]).toBe(0);
    }
    expect(total(countsByZone("Eryngium yuccifolium"))).toBeGreaterThan(50);
  });
  it("keeps garden escapes close to the old garden and house", () => {
    for (let k = 0; k < pop.herbs.count; k++) {
      if (PLANTS[pop.herbs.plant[k]].dispersal !== "escape") continue;
      expect(L.homestead[pop.herbs.node[k]]).toBeGreaterThan(0.02);
    }
    expect(topInZone("garden", 5).every((l) => plantByLatin(l).dispersal === "escape" || l === "Taraxacum officinale")).toBe(true);
  });
  it("grows wood-rotting fungi only on the fallen logs", () => {
    const idx = PLANT_INDEX.get("Trametes versicolor")!;
    for (let k = 0; k < pop.herbs.count; k++) {
      if (pop.herbs.plant[k] !== idx) continue;
      const near = SITE.logs.some((g) => Math.hypot(g.x - pop.herbs.x[k], g.z - pop.herbs.z[k]) < g.len);
      expect(near).toBe(true);
    }
  });
  it("makes the yard a lawn", () => {
    const top = topInZone("yard", 6);
    for (const l of ["Taraxacum officinale", "Poa pratensis", "Trifolium repens"]) expect(top).toContain(l);
  });
  it("keeps jimsonweed and lamb's quarters in the barnyard", () => {
    const j = countsByZone("Datura stramonium");
    expect((j.get("barnyard") ?? 0) / total(j)).toBeGreaterThan(0.6);
    expect(topInZone("barnyard", 2)).toContain("Chenopodium album");
  });
  it("puts garlic mustard in the shade, not the open field", () => {
    const g = countsByZone("Alliaria petiolata");
    const shaded = (g.get("treeline") ?? 0) + (g.get("edge") ?? 0) + (g.get("fencerow") ?? 0);
    expect(shaded / total(g)).toBeGreaterThan(0.8);
  });
  it("makes the remnant a bluestem prairie", () => {
    expect(topInZone("remnant", 2)).toContain("Schizachyrium scoparium");
  });
  it("lets goldenrod take over the unmowed old field", () => {
    expect(topInZone("prairie", 1)).toEqual(["Solidago canadensis"]);
  });
  it("lines the fencerows with bird-planted trees, not squirrel-planted oaks", () => {
    const birds = ["Prunus serotina", "Sassafras albidum", "Juniperus virginiana"].map((l) => countsByZone(l).get("fencerow") ?? 0);
    const oaks = countsByZone("Quercus alba").get("fencerow") ?? 0;
    expect(birds.reduce((a, b) => a + b, 0)).toBeGreaterThan(oaks * 5);
  });
});
