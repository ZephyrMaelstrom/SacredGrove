/**
 * Plant census for Map 1 — the realism check.  `npm run census`
 *
 * Prints, for each zone, the share of individuals per plant (like a field
 * survey), then every Map 1 plant with its total count and the zones it
 * occurs in. Read it the way a botanist would: does the barnyard look like a
 * barnyard? Is the remnant the only place the conservative prairie plants live?
 *
 *   npm run census -- --zone prairie      one zone in full
 *   npm run census -- --plant "Allium"    where a plant grows and why it stops
 */
import { PLANTS } from "../src/data/plants";
import { computeHabitat, ZONE_ORDER } from "../src/sim/habitat";
import { populate, plantsForMap } from "../src/sim/placement";
import { explain, limitingFactor } from "../src/sim/suitability";
import { NODE_COUNT } from "../src/sim/grid";
import { appearance, START_DOY, formatDoy } from "../src/sim/phenology";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const t0 = performance.now();
const L = computeHabitat();
const t1 = performance.now();
const pop = populate(L);
const t2 = performance.now();
console.log(`habitat ${(t1 - t0).toFixed(0)} ms · placement ${(t2 - t1).toFixed(0)} ms · ${pop.herbs.count} herbs · ${pop.woody.count} woody\n`);

const byZone = new Map<string, Map<number, number>>();
const plantZones = new Map<number, Map<string, number>>();
const tally = (set: typeof pop.herbs) => {
  for (let k = 0; k < set.count; k++) {
    const zone = ZONE_ORDER[L.zone[set.node[k]]] ?? "?";
    const p = set.plant[k];
    const zm = byZone.get(zone) ?? new Map();
    zm.set(p, (zm.get(p) ?? 0) + 1);
    byZone.set(zone, zm);
    const pz = plantZones.get(p) ?? new Map();
    pz.set(zone, (pz.get(zone) ?? 0) + 1);
    plantZones.set(p, pz);
  }
};
tally(pop.herbs);
tally(pop.woody);

const onlyZone = flag("zone");
const plantQuery = flag("plant");

if (plantQuery) {
  const idx = PLANTS.findIndex((p) => (p.name + " " + p.latin).toLowerCase().includes(plantQuery.toLowerCase()));
  if (idx < 0) throw new Error(`No plant matches "${plantQuery}"`);
  const p = PLANTS[idx];
  console.log(`${p.name} (${p.latin}) — ${p.notes}`);
  const zones = plantZones.get(idx);
  console.log("Occurs in:", zones ? [...zones].map(([z, c]) => `${z} ${c}`).join(", ") : "nowhere");
  // Why not elsewhere: the most common limiting factor per zone.
  const why = new Map<string, Map<string, number>>();
  for (let n = 0; n < NODE_COUNT; n++) {
    const f = explain(p, L, n);
    const zone = ZONE_ORDER[L.zone[n]];
    const m = why.get(zone) ?? new Map();
    const key = f.total > 0.05 ? "suitable" : limitingFactor(f);
    m.set(key, (m.get(key) ?? 0) + 1);
    why.set(zone, m);
  }
  for (const [zone, m] of why) {
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    console.log(`  ${zone.padEnd(10)} ${[...m].sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k} ${((100 * c) / total).toFixed(0)}%`).join(" · ")}`);
  }
  const look = appearance(p, START_DOY, 1);
  console.log(`On ${formatDoy(START_DOY)} it looks: ${look.stage} (${look.visual ?? "not visible"})`);
  process.exit(0);
}

for (const [zone, m] of [...byZone].sort()) {
  if (onlyZone && zone !== onlyZone) continue;
  const total = [...m.values()].reduce((a, b) => a + b, 0);
  const rows = [...m].sort((a, b) => b[1] - a[1]);
  const shown = onlyZone ? rows : rows.slice(0, 12);
  console.log(`── ${zone} (${total} individuals, ${m.size} plants)`);
  console.log("   " + shown.map(([p, c]) => `${PLANTS[p].name} ${((100 * c) / total).toFixed(1)}%`).join(" · "));
  if (!onlyZone && rows.length > 12) console.log(`   … +${rows.length - 12} more`);
}

if (!onlyZone) {
  const { herbs, woody, logFungi } = plantsForMap(1);
  const all = [...herbs, ...woody, ...logFungi];
  const missing = all.filter((i) => !plantZones.has(i));
  const rare = all.filter((i) => {
    const t = [...(plantZones.get(i)?.values() ?? [])].reduce((a, b) => a + b, 0);
    return t > 0 && t < 15;
  });
  console.log(`\n${all.length} Map 1 plants · ${all.length - missing.length} present`);
  if (missing.length) console.log("ABSENT:", missing.map((i) => PLANTS[i].name).join(", "));
  if (rare.length) console.log("Rare (<15):", rare.map((i) => `${PLANTS[i].name} ${[...plantZones.get(i)!.values()].reduce((a, b) => a + b, 0)}`).join(", "));
}
