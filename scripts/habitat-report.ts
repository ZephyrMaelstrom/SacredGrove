/** Prints mean habitat values per zone — a quick realism check. `npm run report:habitat` */
import { computeHabitat, ZONE_ORDER, LAYER_KEYS } from "../src/sim/habitat";
import { NODE_COUNT } from "../src/sim/grid";

const t0 = performance.now();
const L = computeHabitat();
const ms = performance.now() - t0;
const rows: Record<string, { n: number; sums: number[]; plowed: number; mowed: number }> = {};
for (let n = 0; n < NODE_COUNT; n++) {
  const z = ZONE_ORDER[L.zone[n]];
  const r = (rows[z] ??= { n: 0, sums: LAYER_KEYS.map(() => 0), plowed: 0, mowed: 0 });
  r.n++;
  LAYER_KEYS.forEach((k, i) => (r.sums[i] += L[k][n]));
  r.plowed += L.plowed[n];
  r.mowed += L.mow[n] > 0 ? 1 : 0;
}
console.log(`computeHabitat: ${ms.toFixed(0)} ms for ${NODE_COUNT} nodes\n`);
console.log(["zone".padEnd(10), "nodes", ...LAYER_KEYS.map((k) => k.slice(0, 7).padStart(8)), " plowed", " mowed"].join(" "));
for (const [z, r] of Object.entries(rows)) {
  console.log([z.padEnd(10), String(r.n).padStart(5), ...r.sums.map((s) => (s / r.n).toFixed(2).padStart(8)),
    (r.plowed / r.n).toFixed(2).padStart(7), (r.mowed / r.n).toFixed(2).padStart(6)].join(" "));
}
