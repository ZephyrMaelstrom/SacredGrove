/**
 * M6 buildings: the layout is walkable — you can get into every room and up
 * every stair, walls stop you, and every station stands on a floor.
 */
import { describe, it, expect } from "vitest";
import { layout, inTerrainHole, type RoomId } from "../src/world/layout";
import { step, surfaceAt, blocked, type Walker } from "../src/world/walk";
import { heightAt } from "../src/world/map";

const L = layout();

/** Walk a path of waypoints in small steps; returns the walker at the end. */
function walk(start: [number, number], path: [number, number][], feet?: number): Walker {
  let w: Walker = { x: start[0], z: start[1], feet: feet ?? surfaceAt(start[0], start[1], 100)!.y, vy: 0, room: null };
  // Settle onto the right storey from the given height.
  w = step(w, w.x, w.z, 0.016);
  for (const [tx, tz] of path) {
    for (let i = 0; i < 4000; i++) {
      const dx = tx - w.x, dz = tz - w.z, d = Math.hypot(dx, dz);
      if (d < 0.05) break;
      const s = Math.min(0.06, d);
      const next = step(w, w.x + (dx / d) * s, w.z + (dz / d) * s, 0.016);
      if (next.x === w.x && next.z === w.z && Math.abs(next.feet - w.feet) < 1e-6) break; // stuck
      w = next;
    }
    for (let i = 0; i < 120; i++) w = step(w, w.x, w.z, 0.016); // let gravity finish
  }
  return w;
}
const at = (w: Walker, x: number, z: number) => Math.hypot(w.x - x, w.z - z) < 0.2;

describe("layout", () => {
  it("cuts the ground only over the cellar and stairwell", () => {
    expect(inTerrainHole(-42, 68)).toBe(true);
    expect(inTerrainHole(-35, 65)).toBe(true);
    expect(inTerrainHole(8, 62)).toBe(false);
    expect(inTerrainHole(-42, 60)).toBe(false);
  });
  it("every station stands on a floor or the ground at its height", () => {
    for (const st of L.stations) {
      const s = surfaceAt(st.x, st.z, st.y + 0.1);
      expect(s, st.id).not.toBeNull();
      expect(Math.abs(s!.y - st.y), st.id).toBeLessThan(0.25);
      expect(blocked(st.x, st.z, st.y), st.id).toBeNull();
    }
  });
  it("floors aren't buried in walls", () => {
    const rooms = new Set(L.floors.map((f) => f.room).filter(Boolean));
    expect([...rooms].sort()).toEqual(["barn", "cellar", "house", "loft", "tack", "upstairs"]);
  });
});

describe("walking", () => {
  it("into the barn, up the stairs to the loft", () => {
    const w = walk([8, 44], [[8, 50], [8, 53], [13.9, 53], [13.9, 60.9], [8, 66]]);
    expect(at(w, 8, 66)).toBe(true);
    expect(w.room).toBe("loft");
    expect(w.feet).toBeCloseTo(L.anchors.loftFloor, 1);
  });
  it("from the barn floor into the tack room and out its door", () => {
    const w = walk([4, 56], [[1.5, 55.9], [-1, 55.9], [-1, 57]]);
    expect(w.room).toBe("tack");
    const out = walk([-1, 57], [[-1, 53], [-1, 50]], w.feet);
    expect(at(out, -1, 50)).toBe(true);
    expect(out.room).toBeNull();
  });
  it("can't walk through the barn's walls", () => {
    const w = walk([0, 64], [[8, 64]]);
    expect(w.x).toBeLessThan(1);
  });
  it("up the porch, through the front door, up the stairs to bed", () => {
    const bed = L.stations.find((s) => s.id === "bed")!;
    const w = walk([-42, 58], [[-42, 62], [-42, 65], [-46.2, 65.5], [-46.2, 72], [-44, 71.8], [bed.x, bed.z]]);
    expect(w.room).toBe("upstairs");
    expect(at(w, bed.x, bed.z)).toBe(true);
    expect(w.feet).toBeCloseTo(L.anchors.upstairsFloor, 1);
  });
  it("down the bulkhead stairs into the root cellar", () => {
    const w = walk([-35, 58], [[-35, 61.5], [-35, 67.2], [-38, 67.3], [-44, 68]]);
    expect(w.room).toBe("cellar");
    expect(w.feet).toBeCloseTo(L.anchors.cellarFloor, 1);
    expect(at(w, -44, 68)).toBe(true);
  });
  it("can't step off the curb into the stairwell from the side", () => {
    const w = walk([-32.5, 65], [[-35, 65]]);
    expect(w.x).toBeGreaterThan(-34);
    expect(w.feet).toBeGreaterThan(heightAt(-33, 65) - 0.2);
  });
  it("loft railing stops you walking off the edge", () => {
    const w = walk([6, 64], [[6, 58]], L.anchors.loftFloor);
    expect(w.z).toBeGreaterThan(60.5);
    expect(w.room).toBe("loft" as RoomId);
  });
});
