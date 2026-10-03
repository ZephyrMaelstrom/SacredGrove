import { describe, it, expect } from "vitest";
import { plantByLatin } from "../src/data/plants";
import { appearance, dayOfYear, inWindow, START_DOY } from "../src/sim/phenology";

const look = (latin: string, m: number, d: number, cohort: 0 | 1 = 1) => appearance(plantByLatin(latin), dayOfYear(m, d), cohort);

describe("phenology", () => {
  it("handles windows that wrap the new year", () => {
    expect(inWindow(10, 290, 160)).toBe(true);
    expect(inWindow(200, 290, 160)).toBe(false);
    expect(inWindow(300, 290, 160)).toBe(true);
  });
  it("opens on March 10", () => expect(START_DOY).toBe(69));

  it("has henbit in bloom on March 10 and gone by July", () => {
    expect(look("Lamium amplexicaule", 3, 10).stage).toBe("flowering");
    expect(look("Lamium amplexicaule", 7, 1).stage).toBe("absent");
  });
  it("keeps chickweed green through December (winter annual)", () => {
    expect(look("Stellaria media", 12, 15).visual).toBe("vegetative");
  });
  it("shows goldenrod as dead standing stalks in March", () => {
    expect(look("Solidago canadensis", 3, 10).visual).toBe("standing");
    expect(look("Solidago canadensis", 9, 15).stage).toBe("flowering");
  });
  it("shows little bluestem as a dormant rusty clump in winter", () => {
    expect(look("Schizachyrium scoparium", 3, 10).visual).toBe("dormantClump");
  });
  it("blooms spicebush on bare twigs in March", () => {
    const a = look("Lindera benzoin", 3, 10);
    expect(a.stage).toBe("flowering");
    expect(a.leafy).toBe(false);
  });
  it("splits biennials into rosettes and bolting plants", () => {
    expect(look("Daucus carota", 7, 15, 0).visual).toBe("basal");
    expect(look("Daucus carota", 7, 15, 1).stage).toBe("flowering");
    expect(look("Daucus carota", 1, 15, 0).visual).toBe("basal");
    // Last year's bolters are the dead "bird's nest" heads standing in the winter field.
    expect(look("Daucus carota", 1, 15, 1).visual).toBe("standing");
  });
  it("leaves dead teasel heads standing all winter", () => {
    expect(look("Dipsacus fullonum", 1, 15, 1).visual).toBe("standing");
  });
  it("runs mayapple's short spring season", () => {
    expect(look("Podophyllum peltatum", 3, 10).stage).toBe("absent");
    expect(look("Podophyllum peltatum", 4, 25).stage).toBe("flowering");
    expect(look("Podophyllum peltatum", 8, 15).stage).toBe("absent");
  });
  it("keeps garden sage evergreen", () => {
    expect(look("Salvia officinalis", 1, 15).visual).toBe("vegetative");
  });
  it("grows plants from small to full size", () => {
    const early = look("Asclepias syriaca", 5, 5).growth;
    const late = look("Asclepias syriaca", 6, 20).growth;
    expect(early).toBeLessThan(late);
    expect(late).toBe(1);
  });
});
