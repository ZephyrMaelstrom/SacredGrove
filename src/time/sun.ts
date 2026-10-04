/**
 * Where the sun is over Mount Vernon, Illinois (38.3° N) for a day of the year
 * and a clock time. Daylight saving time is applied from early March to early
 * November, so the clock reads like a real Illinois clock.
 */
export const LATITUDE_DEG = 38.3;
const RAD = Math.PI / 180;

/** Unit vector toward the sun in world space: x east, y up, z north. */
export function sunVector(doy: number, minutes: number): [number, number, number] {
  const phi = LATITUDE_DEG * RAD;
  const decl = 23.44 * RAD * Math.sin((2 * Math.PI * (284 + doy)) / 365);
  // DST: second Sunday in March to first Sunday in November (≈ Mar 8 – Nov 1).
  const dst = doy >= 67 && doy < 305 ? 1 : 0;
  // Mount Vernon sits ~1° west of its time-zone meridian, so solar noon ≈ 12:00 standard time.
  const solarHour = minutes / 60 - dst;
  const H = (solarHour - 12) * 15 * RAD;
  const east = -Math.cos(decl) * Math.sin(H);
  const north = Math.sin(decl) * Math.cos(phi) - Math.cos(decl) * Math.cos(H) * Math.sin(phi);
  const up = Math.sin(decl) * Math.sin(phi) + Math.cos(decl) * Math.cos(H) * Math.cos(phi);
  return [east, up, north];
}

/** Sun elevation in degrees. */
export const sunElevation = (doy: number, minutes: number) => Math.asin(sunVector(doy, minutes)[1]) / RAD;

/** Approximate sunrise and sunset clock minutes (elevation crosses 0). */
export function sunTimes(doy: number): { rise: number; set: number } {
  let rise = 0, set = 0;
  for (let m = 0; m < 1440; m += 2) {
    const a = sunVector(doy, m)[1], b = sunVector(doy, m + 2)[1];
    if (a <= 0 && b > 0) rise = m;
    if (a > 0 && b <= 0) set = m;
  }
  return { rise, set };
}
