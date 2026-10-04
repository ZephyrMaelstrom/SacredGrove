/**
 * VR smooth locomotion: stick → walking direction and speed, smooth and snap turning.
 */
import { describe, it, expect } from "vitest";
import { locomote, stick, DEFAULT_COMFORT, type TurnState } from "../src/xr/comfort";

const still = { moveX: 0, moveY: 0, turnX: 0, hurry: false };

describe("smooth locomotion", () => {
  it("ignores stick drift inside the dead zone", () => {
    expect(stick(0.1)).toBe(0);
    expect(stick(1)).toBeCloseTo(1);
    expect(locomote({ ...still, moveX: 0.08, moveY: -0.1, turnX: 0.12 }, 0, 1 / 72, DEFAULT_COMFORT, { armed: true })).toEqual({ dx: 0, dz: 0, dYaw: 0 });
  });
  it("walks forward the way you face, at walking speed", () => {
    const m = locomote({ ...still, moveY: -1 }, 0, 1, DEFAULT_COMFORT, { armed: true });
    expect(m.dz).toBeCloseTo(DEFAULT_COMFORT.moveSpeed);
    expect(Math.abs(m.dx)).toBeLessThan(1e-9);
    const east = locomote({ ...still, moveY: -1 }, Math.PI / 2, 1, DEFAULT_COMFORT, { armed: true });
    expect(east.dx).toBeCloseTo(DEFAULT_COMFORT.moveSpeed);
  });
  it("strafes right with the stick right, and diagonals aren't faster", () => {
    const r = locomote({ ...still, moveX: 1 }, 0, 1, DEFAULT_COMFORT, { armed: true });
    expect(r.dx).toBeCloseTo(DEFAULT_COMFORT.moveSpeed);
    const d = locomote({ ...still, moveX: 1, moveY: -1 }, 0, 1, DEFAULT_COMFORT, { armed: true });
    expect(Math.hypot(d.dx, d.dz)).toBeCloseTo(DEFAULT_COMFORT.moveSpeed, 5);
  });
  it("hurries when asked", () => {
    const m = locomote({ ...still, moveY: -1, hurry: true }, 0, 1, DEFAULT_COMFORT, { armed: true });
    expect(m.dz).toBeGreaterThan(DEFAULT_COMFORT.moveSpeed * 1.5);
  });
  it("turns smoothly at the set speed", () => {
    const m = locomote({ ...still, turnX: 1 }, 0, 0.5, DEFAULT_COMFORT, { armed: true });
    expect(m.dYaw * 180 / Math.PI).toBeCloseTo(DEFAULT_COMFORT.turnSpeed * 0.5, 0);
  });
  it("snap turns once per flick", () => {
    const c = { ...DEFAULT_COMFORT, turn: "snap" as const };
    const t: TurnState = { armed: true };
    const first = locomote({ ...still, turnX: 0.9 }, 0, 0.016, c, t).dYaw;
    const held = locomote({ ...still, turnX: 0.9 }, 0, 0.016, c, t).dYaw;
    locomote(still, 0, 0.016, c, t);
    const again = locomote({ ...still, turnX: -0.9 }, 0, 0.016, c, t).dYaw;
    expect(first * 180 / Math.PI).toBeCloseTo(30);
    expect(held).toBe(0);
    expect(again * 180 / Math.PI).toBeCloseTo(-30);
  });
});
