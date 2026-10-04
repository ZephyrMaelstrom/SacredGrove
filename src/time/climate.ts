/**
 * Southern Illinois weather, generated one year at a time.
 *
 * Monthly normals are approximate 1991–2020 values for the Mount Vernon, IL
 * area (rounded; good enough to make seasons feel right, not a forecast).
 * From them each day gets:
 *
 *   temperature  — the seasonal normal, plus a persistent day-to-day anomaly
 *                  (AR(1), so warm and cold spells last several days), plus a
 *                  per-year spring anomaly so some springs come early and
 *                  some late
 *   rain         — a two-state Markov chain (wet days cluster) tuned so the
 *                  long-run wet-day count matches each month's normal;
 *                  amounts exponential around the month's mean
 *   condition    — clear / partly cloudy / overcast / fog / rain / storm / snow
 *   wind         — calm to gusty; fronts and storms are windier
 *
 * Fully deterministic from (world seed, year): every save sees the same weather.
 */
import { rng, mixSeed } from "../sim/random";
import { DAYS_IN_YEAR } from "../sim/phenology";

interface MonthNormal {
  highF: number;
  lowF: number;
  precipIn: number;
  wetDays: number; // days with ≥ 0.01 in
}

/** Approximate climate normals, Mount Vernon, Illinois (38.3° N). */
export const NORMALS: MonthNormal[] = [
  { highF: 40, lowF: 23, precipIn: 3.0, wetDays: 9 },  // Jan
  { highF: 45, lowF: 27, precipIn: 2.9, wetDays: 9 },  // Feb
  { highF: 56, lowF: 35, precipIn: 4.1, wetDays: 11 }, // Mar
  { highF: 67, lowF: 45, precipIn: 4.6, wetDays: 11 }, // Apr
  { highF: 76, lowF: 55, precipIn: 5.0, wetDays: 12 }, // May
  { highF: 85, lowF: 64, precipIn: 4.0, wetDays: 9 },  // Jun
  { highF: 88, lowF: 68, precipIn: 3.8, wetDays: 8 },  // Jul
  { highF: 87, lowF: 66, precipIn: 3.3, wetDays: 7 },  // Aug
  { highF: 80, lowF: 57, precipIn: 3.2, wetDays: 7 },  // Sep
  { highF: 69, lowF: 46, precipIn: 3.4, wetDays: 8 },  // Oct
  { highF: 56, lowF: 36, precipIn: 4.2, wetDays: 9 },  // Nov
  { highF: 44, lowF: 27, precipIn: 3.6, wetDays: 9 },  // Dec
];
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MONTH_START = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
const MONTH_MID = MONTH_START.map((s, i) => s + MONTH_DAYS[i] / 2 - 0.5);

export type Condition = "clear" | "partly" | "overcast" | "fog" | "rain" | "storm" | "snow";

export interface DayWeather {
  doy: number;
  highF: number;
  lowF: number;
  /** Precipitation (mm, liquid equivalent). */
  precipMm: number;
  condition: Condition;
  /** 0 clear – 1 full overcast. */
  cloud: number;
  /** 0 calm – 2 gusty. */
  wind: number;
  /** Hours when precipitation falls (start inclusive, end exclusive), or null. */
  precipHours: [number, number] | null;
  /** Morning fog burns off at this hour (0 = no fog). */
  fogUntil: number;
  /** Temperature anomaly from normal (°F), kept for season calculations. */
  anomalyF: number;
}

export const monthOf = (doy: number) => {
  let m = 11;
  while (m > 0 && doy < MONTH_START[m]) m--;
  return m;
};

/** Smooth daily normal by interpolating between month midpoints (wraps the year). */
export function normalAt(doy: number): { highF: number; lowF: number } {
  for (let k = -1; k < 12; k++) {
    const a = (k + 12) % 12, b = (k + 1) % 12;
    const ma = MONTH_MID[a] - (k < 0 ? DAYS_IN_YEAR : 0);
    const mb = MONTH_MID[b] + (k === 11 ? DAYS_IN_YEAR : 0);
    if (doy < ma || doy > mb) continue;
    const t = (doy - ma) / (mb - ma);
    const s = t * t * (3 - 2 * t);
    return {
      highF: NORMALS[a].highF + (NORMALS[b].highF - NORMALS[a].highF) * s,
      lowF: NORMALS[a].lowF + (NORMALS[b].lowF - NORMALS[a].lowF) * s,
    };
  }
  return { highF: NORMALS[0].highF, lowF: NORMALS[0].lowF };
}

/** Standard normal from two uniforms (Box–Muller). */
function gaussian(r: () => number) {
  const u = Math.max(1e-9, r()), v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface YearWeather {
  year: number;
  days: DayWeather[]; // index doy-1
  /** How warm this spring ran vs. normal (°F, Mar–Apr mean anomaly). */
  springAnomalyF: number;
}

const yearCache = new Map<string, YearWeather>();

export function weatherForYear(year: number, seed: number): YearWeather {
  const key = `${seed}:${year}`;
  const hit = yearCache.get(key);
  if (hit) return hit;

  const r = rng(mixSeed(seed ^ 0x77ea7, year));
  // Each year carries its own spring personality: early, normal or late.
  const springBias = gaussian(r) * 3.5;
  const yearBias = gaussian(r) * 1.2;
  const days: DayWeather[] = [];
  let anomaly = gaussian(r) * 5;
  let wet: boolean = false;

  for (let doy = 1; doy <= DAYS_IN_YEAR; doy++) {
    const m = monthOf(doy);
    const N = NORMALS[m];
    const norm = normalAt(doy);

    // Temperature: persistent anomaly, stronger swings in winter.
    const sd = doy < 90 || doy > 300 ? 8 : doy < 130 || doy > 260 ? 6.5 : 5;
    anomaly = 0.72 * anomaly + gaussian(r) * sd * Math.sqrt(1 - 0.72 * 0.72);
    const springWeight = Math.exp(-(((doy - 95) / 32) ** 2)); // peaks early April
    const a = anomaly + yearBias + springBias * springWeight;

    // Rain: Markov chain whose stationary wet fraction equals the month's normal.
    const f = N.wetDays / MONTH_DAYS[m];
    const pWW = Math.min(0.85, f + 0.3);
    const pDW = (f * (1 - pWW)) / (1 - f);
    const wasWet: boolean = wet;
    wet = r() < (wasWet ? pWW : pDW);

    let highF = norm.highF + a, lowF = norm.lowF + a * 0.85;
    let precipMm = 0, condition: Condition, cloud: number, wind = 0.5 + 0.6 * r();
    let precipHours: [number, number] | null = null;
    let fogUntil = 0;

    if (wet) {
      const meanMm = (N.precipIn * 25.4) / N.wetDays;
      precipMm = Math.max(0.3, -Math.log(Math.max(1e-6, r())) * meanMm);
      highF -= 4 + 3 * r(); // clouds and rain hold the high down
      lowF += 2;
      cloud = 0.85 + 0.15 * r();
      const mean = (highF + lowF) / 2;
      // Southern Illinois winter storms often bring rain or a mix: it only
      // snows outright when the whole day stays near freezing.
      if (highF <= 32 || (mean < 29 && r() < 0.3)) {
        condition = "snow";
        precipMm *= 0.6; // cold air holds less water: snow events are lighter
      } else if (m >= 3 && m <= 8 && highF >= 75 && r() < 0.5) {
        condition = "storm"; // same total, just falls hard and fast
        wind = 1.5 + 0.5 * r();
      } else {
        condition = "rain";
      }
      if (!wasWet) wind += 0.35; // fronts arrive on a breeze
      // When it falls: storms in the afternoon, other systems any time.
      if (condition === "storm") {
        const start = 13 + Math.floor(r() * 5);
        precipHours = [start, start + 1 + Math.floor(r() * 2)];
      } else {
        const len = Math.min(16, 2 + Math.round(precipMm / 2.5 + r() * 4));
        const start = Math.floor(r() * (24 - len));
        precipHours = [start, start + len];
      }
    } else {
      cloud = Math.min(1, r() * (wasWet ? 1.2 : 0.95));
      condition = cloud < 0.3 ? "clear" : cloud < 0.7 ? "partly" : "overcast";
      // Radiation fog: still, damp morning after rain.
      if (wasWet && wind < 0.8 && r() < 0.55) {
        condition = "fog";
        fogUntil = 8 + Math.floor(r() * 3);
      }
      // Clear nights get colder, cloudy nights stay mild.
      lowF -= (1 - cloud) * 3;
      highF += (1 - cloud) * 2;
    }
    if (m === 11 || m <= 2) wind += 0.2; // winter is breezier
    days.push({
      doy, highF, lowF: Math.min(lowF, highF - 4), precipMm, condition, cloud,
      wind: Math.min(2, wind), precipHours, fogUntil, anomalyF: a,
    });
  }

  let spring = 0;
  for (let d = 60; d < 121; d++) spring += days[d - 1].anomalyF;
  const yw = { year, days, springAnomalyF: spring / 61 };
  yearCache.set(key, yw);
  return yw;
}

/**
 * Snow on the ground (cm) each morning: snowfall piles up (≈10:1 snow to
 * water), and melts on warm days, faster in rain. Carries over from the
 * previous December, so a January snowpack can be left from Christmas.
 */
const snowCache = new Map<string, Float32Array>();
export function snowDepths(year: number, seed: number): Float32Array {
  const key = `${seed}:${year}`;
  const hit = snowCache.get(key);
  if (hit) return hit;
  const out = new Float32Array(DAYS_IN_YEAR);
  let depth = 0;
  const step = (d: DayWeather) => {
    if (d.condition === "snow") depth += d.precipMm; // mm water → cm snow
    const melt = Math.max(0, d.highF - 33) * 0.55 + (d.condition === "rain" ? d.precipMm * 0.4 : 0) + (1 - d.cloud) * 0.4;
    depth = Math.max(0, depth * 0.92 - melt); // settles ~8% a day, then melts
  };
  if (year > 1) for (const d of weatherForYear(year - 1, seed).days.slice(304)) step(d);
  for (const d of weatherForYear(year, seed).days) {
    out[d.doy - 1] = depth; // morning depth, before today's weather
    step(d);
  }
  snowCache.set(key, out);
  return out;
}

/** 0–1 how much of the ground snow covers (patchy below ~5 cm). */
export const snowCover = (depthCm: number) => Math.min(1, depthCm / 5);

export function weatherOn(year: number, doy: number, seed: number): DayWeather {
  return weatherForYear(year, seed).days[doy - 1];
}

/** Temperature (°F) at a time of day: low near dawn, high mid-afternoon. */
export function temperatureAt(w: DayWeather, minutes: number): number {
  const h = minutes / 60;
  // Cosine from the 6 AM low to the 3 PM high and back.
  const t = h >= 6 && h <= 15 ? (h - 6) / 9 : h > 15 ? 1 - (h - 15) / 15 : 1 - (h + 9) / 15;
  const s = 0.5 - 0.5 * Math.cos(Math.PI * Math.max(0, Math.min(1, t)));
  return w.lowF + (w.highF - w.lowF) * s;
}

export function isPrecipitating(w: DayWeather, minutes: number): boolean {
  if (!w.precipHours) return false;
  const h = minutes / 60;
  return h >= w.precipHours[0] && h < w.precipHours[1];
}

export function isFoggy(w: DayWeather, minutes: number): boolean {
  return w.fogUntil > 0 && minutes / 60 < w.fogUntil;
}

/** Short forecast-style words for the HUD and wrist display. */
export function describe(w: DayWeather, minutes: number): string {
  const now = isPrecipitating(w, minutes);
  switch (w.condition) {
    case "snow": return now ? "Snowing" : "Snow today";
    case "storm": return now ? "Thunderstorm" : "Storms this afternoon";
    case "rain": return now ? "Raining" : "Showers today";
    case "fog": return isFoggy(w, minutes) ? "Foggy" : "Clearing";
    case "clear": return "Clear";
    case "partly": return "Partly cloudy";
    case "overcast": return "Overcast";
  }
}

export const fToC = (f: number) => ((f - 32) * 5) / 9;
