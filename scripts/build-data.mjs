#!/usr/bin/env node
/**
 * Workbook → game data.
 *
 * Reads data/Rootwake_Species_Database.xlsx (the single source of truth),
 * validates the Plants and Species tabs, and writes src/data/plants.gen.json.
 *
 *   npm run data
 *
 * Plants tab  = one row per living plant (ecology, phenology, looks).
 * Species tab = one row per harvestable PRODUCT, joined to its plant by Latin name.
 *
 * The script fails loudly (exit 1) on anything the game can't use, so a bad
 * edit in Excel never reaches the build.
 */
import readXlsxFile from "read-excel-file/node";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKBOOK = resolve(root, "data/Rootwake_Species_Database.xlsx");
const OUT = resolve(root, "src/data/plants.gen.json");

const ENUMS = {
  "Growth Form": ["rosette", "mat", "forb", "tallForb", "grass", "sedge", "bulb", "vine", "cane", "horsetail", "fungus", "fungusBracket", "shrub", "tree"],
  "Life Cycle": ["winterAnnual", "summerAnnual", "biennial", "perennial", "woody", "fungus"],
  "Winter Form": ["none", "rosette", "mat", "standing", "clump", "evergreen", "bare"],
  Crown: ["", "spreading", "upright", "conifer", "vase", "multistem", "arching"],
  Origin: ["native", "introduced", "invasive", "escape"],
  Dispersal: ["wind", "bird", "animal", "caching", "gravity", "rhizome", "ballistic", "escape", "spores"],
  Host: ["soil", "soilOrGravel", "wood"],
  "Flower Shape": ["cluster", "umbel", "plume", "spike", "daisy", "globe", "bell"],
};
const UNIT = ["Light Opt", "Light Tol", "Moist Opt", "Moist Tol", "Disturb Opt", "Disturb Tol", "Fert Opt", "Fert Tol", "Abundance"];
const DOY = ["Green-up DOY", "Flower Start DOY", "Flower End DOY", "Fruit Ripe DOY", "Dieback DOY"];
const HEX = ["Leaf Color", "Flower Color", "Dormant Color"];

const errors = [];
const warn = [];
const fail = (msg) => errors.push(msg);

const sheets = await readXlsxFile(WORKBOOK);
const sheet = (name) => {
  const s = sheets.find((x) => x.sheet === name);
  if (!s) throw new Error(`Workbook has no "${name}" tab`);
  const [head, ...rows] = s.data;
  return rows
    .filter((r) => r.some((v) => v !== null && v !== ""))
    .map((r) => Object.fromEntries(head.map((h, i) => [String(h).trim(), r[i]])));
};

// ------------------------------------------------------------------ plants
const plants = [];
const seen = new Set();
for (const r of sheet("Plants")) {
  const latin = String(r["Latin Name"] ?? "").trim();
  const where = `Plants › ${latin || "(blank latin)"}`;
  if (!latin) { fail(`${where}: missing Latin Name`); continue; }
  if (seen.has(latin)) fail(`${where}: duplicate plant`);
  seen.add(latin);

  for (const [col, allowed] of Object.entries(ENUMS)) {
    const v = String(r[col] ?? "").trim();
    if (!allowed.includes(v)) fail(`${where}: ${col} "${v}" is not one of ${allowed.filter(Boolean).join(", ")}`);
  }
  for (const col of UNIT) {
    const v = Number(r[col]);
    if (!(v >= 0 && v <= 1)) fail(`${where}: ${col} must be 0–1 (got ${r[col]})`);
  }
  for (const col of ["Light Tol", "Moist Tol", "Disturb Tol", "Fert Tol"]) {
    if (Number(r[col]) < 0.05) fail(`${where}: ${col} below 0.05 makes the plant almost impossible to place`);
  }
  for (const col of DOY) {
    const v = Number(r[col]);
    if (!(Number.isInteger(v) && ((v >= 1 && v <= 366) || v === 999))) fail(`${where}: ${col} must be a day of year 1–366 (or 999 = never) (got ${r[col]})`);
  }
  for (const col of HEX) {
    if (!/^#[0-9a-fA-F]{6}$/.test(String(r[col] ?? ""))) fail(`${where}: ${col} must be a hex colour like #4f7a35`);
  }
  const form = r["Growth Form"];
  const woody = form === "tree" || form === "shrub";
  if (woody && !r["Crown"]) fail(`${where}: trees and shrubs need a Crown shape`);
  const mow = Number(r["Mow Tolerance"]);
  if (!(Number.isInteger(mow) && mow >= 0 && mow <= 3)) fail(`${where}: Mow Tolerance must be 0–3`);
  const c = Number(r["C-value"]);
  if (!(Number.isInteger(c) && c >= 0 && c <= 10)) fail(`${where}: C-value must be 0–10`);
  const h = Number(r["Height (m)"]);
  if (!(h > 0 && h <= 40)) fail(`${where}: Height must be 0–40 m`);
  const patch = Number(r["Patch Scale (m)"]);
  if (!(patch >= 1 && patch <= 60)) fail(`${where}: Patch Scale must be 1–60 m`);

  plants.push({
    latin,
    name: String(r["Plant Name"]).trim(),
    maps: String(r["Maps"] ?? "").split(/[,\s]+/).filter(Boolean).map(Number),
    form,
    cycle: r["Life Cycle"],
    height: h,
    colors: { leaf: r["Leaf Color"], flower: r["Flower Color"], dormant: r["Dormant Color"] },
    phenology: {
      greenUp: Number(r["Green-up DOY"]),
      flowerStart: Number(r["Flower Start DOY"]),
      flowerEnd: Number(r["Flower End DOY"]),
      fruitRipe: Number(r["Fruit Ripe DOY"]),
      dieback: Number(r["Dieback DOY"]),
      winterForm: r["Winter Form"],
    },
    crown: r["Crown"] || null,
    niche: {
      light: [Number(r["Light Opt"]), Number(r["Light Tol"])],
      moisture: [Number(r["Moist Opt"]), Number(r["Moist Tol"])],
      disturbance: [Number(r["Disturb Opt"]), Number(r["Disturb Tol"])],
      fertility: [Number(r["Fert Opt"]), Number(r["Fert Tol"])],
    },
    mowTolerance: mow,
    cValue: c,
    origin: r["Origin"],
    dispersal: r["Dispersal"],
    patchScale: patch,
    abundance: Number(r["Abundance"]),
    host: r["Host"],
    flowerShape: r["Flower Shape"],
    notes: String(r["Habitat Notes"] ?? ""),
    products: [],
  });
}

// ---------------------------------------------------------------- products
const byLatin = new Map(plants.map((p) => [p.latin, p]));
let orphanProducts = 0;
for (const r of sheet("Species")) {
  const latin = String(r["Latin Name"] ?? "").trim();
  const plant = byLatin.get(latin);
  const compounds = [1, 2, 3]
    .map((k) => ({ code: r[`Compound ${k}`], str: Number(r[`Str ${k}`]) }))
    .filter((c) => c.code);
  const product = {
    id: r["ID"],
    name: r["Common Name"],
    tier: r["Tier"],
    biome: r["Biome"],
    part: r["Part Used"],
    harvest: [Number(r["Harvest Start"]), Number(r["Harvest End"])],
    seedMonth: Number(r["Seed Month"]) || null,
    compounds,
    toxicity: Number(r["Toxicity (0-10)"]),
    taste: r["Taste (journal)"],
    smell: r["Smell (journal)"],
    use: r["Primary Use / Effect"],
    rarity: Number(r["Rarity (1-5)"]),
    basePrice: Number(r["Base Price (c)"]) || 0,
    shelfLifeDays: Number(r["Shelf Life (days)"]) || 0,
  };
  if (!plant) { orphanProducts++; continue; } // plants for later maps aren't authored yet
  plant.products.push(product);
}
for (const p of plants) if (!p.products.length) fail(`Plants › ${p.latin}: no Species (product) row shares this Latin name`);
if (orphanProducts) warn.push(`${orphanProducts} product rows have no Plants entry yet (fine for species not on a built map)`);

if (errors.length) {
  console.error(`\n✗ ${errors.length} problem(s) in ${WORKBOOK}:\n`);
  for (const e of errors) console.error("  • " + e);
  console.error("");
  process.exit(1);
}

plants.sort((a, b) => a.latin.localeCompare(b.latin));
// One plant per line: compact, and git diffs show exactly which plant changed.
writeFileSync(
  OUT,
  `{"source":"data/Rootwake_Species_Database.xlsx","plants":[\n${plants.map((p) => JSON.stringify(p)).join(",\n")}\n]}\n`,
);
for (const w of warn) console.warn("  ! " + w);
const onMap1 = plants.filter((p) => p.maps.includes(1)).length;
console.log(`✓ ${plants.length} plants (${onMap1} on Map 1), ${plants.reduce((s, p) => s + p.products.length, 0)} products → ${OUT.replace(root + "/", "")}`);
