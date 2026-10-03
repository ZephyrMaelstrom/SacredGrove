import { describe, it, expect } from "vitest";
import { PLANTS, isWoody } from "../src/data/plants";
import { herbGeometry, tuftGeometry, TRI_BUDGET, TUFT_TRIS } from "../src/veg/geometry";
import type { Visual } from "../src/sim/phenology";

const VISUALS: Visual[] = ["basal", "vegetative", "flowering", "fruiting", "senescent", "standing", "dormantClump"];

describe("plant geometry", () => {
  for (const p of PLANTS.filter((q) => !isWoody(q))) {
    it(`${p.name} stays within the triangle budget in every state`, () => {
      for (const v of VISUALS) {
        const g = herbGeometry(p, v);
        const tris = g.indices.length / 3;
        expect(tris, `${p.name} ${v}`).toBeGreaterThan(0);
        expect(tris, `${p.name} ${v}`).toBeLessThanOrEqual(TRI_BUDGET);
        expect(g.colors.length / 4).toBe(g.positions.length / 3);
        expect(g.positions.every(Number.isFinite)).toBe(true);
        expect(Math.max(...g.indices)).toBeLessThan(g.positions.length / 3);
      }
    });
  }
  it("keeps the far-field tuft tiny", () => {
    expect(tuftGeometry().indices.length / 3).toBeLessThanOrEqual(TUFT_TRIS);
  });
});
