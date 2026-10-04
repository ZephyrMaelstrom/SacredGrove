/**
 * The weather generator must reproduce Southern Illinois climate over many
 * years, and the clock and seasons must behave.
 */
import { describe, it, expect } from "vitest";
import { NORMALS, weatherForYear, temperatureAt, monthOf, normalAt, snowDepths } from "../src/time/climate";
import { seasonFromWeather, NEUTRAL_SEASON } from "../src/time/season";
import { advance, sleep, NEW_GAME_CLOCK, absDay, type ClockState, WAKE_MINUTES } from "../src/time/clock";
import { appearance, dayOfYear } from "../src/sim/phenology";
import { plantByLatin } from "../src/data/plants";
import { WORLD_SEED } from "../src/sim/placement";

// 60 years: wet days cluster, so 30 years still leaves a day or two of sampling noise per month.
const YEARS = Array.from({ length: 60 }, (_, i) => weatherForYear(i + 1, WORLD_SEED));
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

describe("climate over 60 years", () => {
  it("matches monthly mean highs and lows within 2.5 °F", () => {
    for (let m = 0; m < 12; m++) {
      let hi = 0, lo = 0, n = 0;
      for (const y of YEARS) for (const d of y.days) if (monthOf(d.doy) === m) { hi += d.highF; lo += d.lowF; n++; }
      expect(Math.abs(hi / n - NORMALS[m].highF), `month ${m + 1} high`).toBeLessThan(2.5);
      expect(Math.abs(lo / n - NORMALS[m].lowF), `month ${m + 1} low`).toBeLessThan(2.5);
    }
  });
  it("matches wet-day counts within 1.5 days a month and precipitation within 25%", () => {
    for (let m = 0; m < 12; m++) {
      let wet = 0, mm = 0;
      for (const y of YEARS) for (const d of y.days) if (monthOf(d.doy) === m && d.precipMm > 0) { wet++; mm += d.precipMm; }
      expect(Math.abs(wet / YEARS.length - NORMALS[m].wetDays), `month ${m + 1} wet days`).toBeLessThan(1.5);
      const inches = mm / 25.4 / YEARS.length;
      expect(Math.abs(inches - NORMALS[m].precipIn) / NORMALS[m].precipIn, `month ${m + 1} precip`).toBeLessThan(0.25);
    }
    expect(MONTH_DAYS.reduce((a, b) => a + b)).toBe(365);
  });
  it("snows only in the cold months and storms only in the warm ones", () => {
    for (const y of YEARS) for (const d of y.days) {
      if (d.condition === "snow") expect([0, 1, 2, 3, 10, 11]).toContain(monthOf(d.doy)); // April snow is rare but real
      if (d.condition === "storm") expect(monthOf(d.doy)).toBeGreaterThanOrEqual(3);
    }
  });
  it("puts the average last spring frost in early-mid April and first fall frost in mid-late October", () => {
    const seasons = YEARS.map(seasonFromWeather);
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const lastSpring = avg(seasons.map((s) => s.lastSpringFrost ?? 60));
    const firstFall = avg(seasons.map((s) => s.firstFrost ?? 330));
    expect(lastSpring).toBeGreaterThan(dayOfYear(3, 25));
    expect(lastSpring).toBeLessThan(dayOfYear(4, 25));
    expect(firstFall).toBeGreaterThan(dayOfYear(10, 5));
    expect(firstFall).toBeLessThan(dayOfYear(11, 5));
  });
  it("gives each year its own spring (early and late years both happen)", () => {
    const shifts = YEARS.map((y) => seasonFromWeather(y).springShift);
    expect(Math.min(...shifts)).toBeLessThan(-3);
    expect(Math.max(...shifts)).toBeGreaterThan(3);
  });
  it("snows about 8–16 inches a year, with snow on the ground 4–18 days", () => {
    let fall = 0, cover = 0;
    YEARS.forEach((y) => {
      for (const d of y.days) if (d.condition === "snow") fall += d.precipMm;
      cover += Array.from(snowDepths(y.year, WORLD_SEED)).filter((cm) => cm >= 2.5).length;
    });
    const inches = fall / YEARS.length / 2.54, days = cover / YEARS.length;
    expect(inches).toBeGreaterThan(8);
    expect(inches).toBeLessThan(16);
    expect(days).toBeGreaterThan(4);
    expect(days).toBeLessThan(18);
  });
  it("is deterministic and keeps daily highs above lows", () => {
    expect(weatherForYear(3, WORLD_SEED).days[100]).toEqual(YEARS[2].days[100]);
    for (const y of YEARS) for (const d of y.days) expect(d.highF).toBeGreaterThan(d.lowF);
  });
  it("runs coldest at dawn and warmest mid-afternoon", () => {
    const d = YEARS[0].days[150];
    expect(temperatureAt(d, 6 * 60)).toBeCloseTo(d.lowF, 1);
    expect(temperatureAt(d, 15 * 60)).toBeCloseTo(d.highF, 1);
    expect(temperatureAt(d, 11 * 60)).toBeLessThan(d.highF);
  });
  it("interpolates normals smoothly through the new year", () => {
    expect(Math.abs(normalAt(365).highF - normalAt(1).highF)).toBeLessThan(0.5);
  });
});

describe("season effects on plants", () => {
  const base = NEUTRAL_SEASON;
  it("brings spring early in a warm year", () => {
    const warm = { ...base, springShift: -10 };
    const henbit = plantByLatin("Podophyllum peltatum");
    // Mayapple normally blooms from DOY 110; in a warm spring it's already blooming at 103.
    expect(appearance(henbit, 103, 1, base).stage).not.toBe("flowering");
    expect(appearance(henbit, 103, 1, warm).stage).toBe("flowering");
  });
  it("kills summer annuals at the first frost", () => {
    const frost = { ...base, firstFrost: dayOfYear(10, 10) };
    const lq = plantByLatin("Chenopodium album");
    expect(appearance(lq, dayOfYear(10, 5), 1, frost).stage).not.toBe("absent");
    expect(appearance(lq, dayOfYear(10, 11), 1, frost).frostKilled).toBe(true);
    expect(appearance(lq, dayOfYear(10, 20), 1, frost).stage).toBe("absent");
  });
  it("leaves frost-hardy winter annuals alone", () => {
    const frost = { ...base, firstFrost: dayOfYear(10, 10), hardFreeze: dayOfYear(10, 20) };
    expect(appearance(plantByLatin("Stellaria media"), dayOfYear(11, 15), 1, frost).visual).toBe("vegetative");
  });
  it("loses the persimmon crop to a frost on the blossoms", () => {
    const p = plantByLatin("Diospyros virginiana");
    const frosty = { ...base, springFrosts: [p.phenology.flowerStart + 3] };
    expect(appearance(p, 270, 1, base).stage).toBe("fruiting");
    const a = appearance(p, 270, 1, frosty);
    expect(a.fruitFailed).toBe(true);
    expect(a.stage).not.toBe("fruiting");
  });
});

describe("clock", () => {
  it("turns the date at midnight and the year after Dec 31", () => {
    const c: ClockState = { year: 1, doy: 365, minutes: 23 * 60 + 50 };
    const ev = advance(c, 20);
    expect(ev.newDay && ev.newYear).toBe(true);
    expect(c).toEqual({ year: 2, doy: 1, minutes: 10 });
  });
  it("passes out at 2 AM", () => {
    const c: ClockState = { year: 1, doy: 100, minutes: 23 * 60 };
    expect(advance(c, 120).passedOut).toBe(false);
    expect(advance(c, 70).passedOut).toBe(true);
  });
  it("wakes at 6 AM the next morning, whether you sleep before or after midnight", () => {
    const early: ClockState = { year: 1, doy: 100, minutes: 21 * 60 };
    sleep(early);
    expect(early).toEqual({ year: 1, doy: 101, minutes: WAKE_MINUTES });
    const late: ClockState = { year: 1, doy: 101, minutes: 60 };
    sleep(late);
    expect(late).toEqual({ year: 1, doy: 101, minutes: WAKE_MINUTES });
  });
  it("counts absolute days across years", () => {
    expect(absDay({ year: 2, doy: 1 }) - absDay({ year: 1, doy: 365 })).toBe(1);
    expect(NEW_GAME_CLOCK.doy).toBe(dayOfYear(3, 10));
  });
});

import { sunTimes, sunElevation } from "../src/time/sun";
describe("sun over Mount Vernon", () => {
  it("rises around 5:30–5:50 AM and sets around 8:15–8:35 PM at the summer solstice (CDT)", () => {
    const { rise, set } = sunTimes(dayOfYear(6, 21));
    expect(rise).toBeGreaterThan(5 * 60 + 20);
    expect(rise).toBeLessThan(5 * 60 + 55);
    expect(set).toBeGreaterThan(20 * 60 + 5);
    expect(set).toBeLessThan(20 * 60 + 40);
  });
  it("climbs to about 75° at solstice noon and 28° at winter solstice noon", () => {
    expect(sunElevation(dayOfYear(6, 21), 13 * 60)).toBeGreaterThan(72);
    expect(sunElevation(dayOfYear(12, 21), 12 * 60)).toBeLessThan(31);
    expect(sunElevation(dayOfYear(12, 21), 12 * 60)).toBeGreaterThan(25);
  });
});

import { groundHit, heightAt } from "../src/world/map";
describe("ground ray", () => {
  it("finds the ground where the terrain mesh would", () => {
    const h = groundHit(0, heightAt(0, 200) + 1.7, 200, 0, -0.6, 0.8, 10)!;
    expect(h).not.toBeNull();
    expect(Math.abs(h.y - heightAt(h.x, h.z))).toBeLessThan(0.01);
    expect(h.distance).toBeGreaterThan(1.5);
    expect(h.distance).toBeLessThan(3.5);
    expect(groundHit(0, 5, 200, 0, 0.5, 0.8, 10)).toBeNull();
  });
});
