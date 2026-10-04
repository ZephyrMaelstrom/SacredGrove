/**
 * M7 — The apothecary bench: grinding and brewing.
 *
 * Every product carries hidden compounds (alkaloids, tannins, mucilage,
 * volatile oils…) and hidden effects (cough, sleep, fever…). A brew pulls
 * compounds into water according to the method:
 *
 *   hot infusion  boiling water poured over, minutes. Volatile oils come out
 *                 fast and escape unless the cup is covered; tannins keep
 *                 coming the longer it steeps (harsh, astringent); mucilage
 *                 suffers in heat; roots and bark barely give anything unless
 *                 ground fine.
 *   cold infusion room-temperature water, hours. The only way to get
 *                 mucilage intact (slippery elm, mallow-type throat coats);
 *                 gentle, few tannins, weak on everything else.
 *   decoction     simmered, tens of minutes. Gets everything out of roots
 *                 and bark; boils the aromatics off; destroys mucilage; the
 *                 only safe way to use "must be cooked" fruit like elderberry.
 *
 * Grinding raises extraction (powders give up their compounds fast) but
 * over-grinding heats the material and costs volatile oils.
 *
 * From the extracted compounds come the brew's effect strength per cup,
 * its flavor, how harmful it is, and what it looks and smells like.
 */
import { PLANTS, EFFECT_TAGS, type Product, type EffectTag } from "../data/plants";
import { METHOD_NAMES, newId, type Flavor, type HerbLot, type Method, type PrepItem } from "./items";

type Code = "ALK" | "ANT" | "ACI" | "BIT" | "COU" | "FLA" | "GLY" | "LAT" | "MUC" | "PIG" | "RES" | "SAP" | "SUG" | "TAN" | "VOL" | "SPR" | "RHZ";

/** Most of each compound class a method can pull out (fraction). */
const EMAX: Record<Method, Record<Code, number>> = {
  hot: { ALK: 0.5, ANT: 0.7, ACI: 0.9, BIT: 0.7, COU: 0.3, FLA: 0.5, GLY: 0.75, LAT: 0.1, MUC: 0.4, PIG: 0.6, RES: 0.05, SAP: 0.7, SUG: 0.9, TAN: 0.8, VOL: 0.65, SPR: 0.2, RHZ: 0 },
  cold: { ALK: 0.25, ANT: 0.5, ACI: 0.8, BIT: 0.4, COU: 0.2, FLA: 0.3, GLY: 0.4, LAT: 0.05, MUC: 0.9, PIG: 0.3, RES: 0, SAP: 0.4, SUG: 0.8, TAN: 0.25, VOL: 0.45, SPR: 0.3, RHZ: 0.5 },
  decoction: { ALK: 0.75, ANT: 0.6, ACI: 0.9, BIT: 0.85, COU: 0.3, FLA: 0.55, GLY: 0.85, LAT: 0.15, MUC: 0.1, PIG: 0.7, RES: 0.1, SAP: 0.8, SUG: 0.95, TAN: 0.95, VOL: 0.15, SPR: 0.1, RHZ: 0 },
};
/** Time constant (minutes) for each class to come out of soft leaf material. */
const TAU: Record<Method, Partial<Record<Code, number>>> = {
  hot: { ACI: 2, SUG: 3, VOL: 2, GLY: 4, BIT: 4, ANT: 4, FLA: 6, ALK: 8, TAN: 7, SAP: 6, MUC: 5, PIG: 5 },
  cold: { ACI: 30, SUG: 40, VOL: 40, GLY: 60, BIT: 60, ANT: 60, FLA: 90, ALK: 120, TAN: 180, SAP: 90, MUC: 120, PIG: 90 },
  decoction: { ACI: 4, SUG: 5, VOL: 3, GLY: 8, BIT: 8, ANT: 8, FLA: 10, ALK: 12, TAN: 10, SAP: 10, MUC: 5, PIG: 8 },
};
const TOUGH = new Set(["Root", "Rhizome", "Bark", "Twig", "Seed", "Tuber", "Bulb", "Resin"]);

export const productById = (id: string): { product: Product; latin: string; name: string } | null => {
  for (const p of PLANTS) {
    const pr = p.products.find((x) => x.id === id);
    if (pr) return { product: pr, latin: p.latin, name: p.name };
  }
  return null;
};

// ---------------------------------------------------------------- grinding

export function canGrind(lot: HerbLot): string | null {
  if (lot.state === "moldy" || lot.state === "spoiled") return "That's ruined.";
  if (lot.state !== "dried") return "Fresh material just smears in the mortar. Dry it first.";
  if (lot.part === "Sap") return "You can't grind a liquid.";
  return null;
}

/** Work the pestle: each stroke takes the lot closer to a fine powder. */
export function grind(lot: HerbLot, strokes: number): void {
  if (canGrind(lot)) return;
  const before = lot.ground;
  lot.ground = 1 - (1 - lot.ground) * Math.exp(-strokes / 14);
  // Past a fine powder, the friction heat drives off the volatile oils.
  if (lot.ground > 0.85) {
    const over = lot.ground - Math.max(before, 0.85);
    const aromatic = productById(lot.productId)?.product.compounds.some((c) => c.code === "VOL");
    if (aromatic) lot.potency = Math.max(0, lot.potency * (1 - over * 1.5));
  }
}

// ---------------------------------------------------------------- brewing

export interface BrewIngredient {
  lot: HerbLot;
  grams: number;
}

export interface BrewParams {
  method: Method;
  waterMl: number;
  minutes: number;
  /** Lid on (infusions): keeps the volatile oils in. */
  covered: boolean;
  ingredients: BrewIngredient[];
}

export const BREW_LIMITS = {
  waterMl: [250, 2000] as const,
  minutes: { hot: [1, 30], cold: [30, 720], decoction: [5, 90] } as Record<Method, [number, number]>,
};

/** Fraction of each compound class pulled from one ingredient. */
export function extraction(method: Method, minutes: number, covered: boolean, part: string, ground: number, fresh: boolean): Record<Code, number> {
  const tough = TOUGH.has(part);
  const tauScale = tough ? (ground > 0 ? 4 - 2.8 * ground : 4) : ground > 0 ? 1 - 0.4 * ground : 1;
  const boost = 1 + 0.35 * ground;
  const out = {} as Record<Code, number>;
  for (const code of Object.keys(EMAX[method]) as Code[]) {
    const tau = (TAU[method][code] ?? 6) * tauScale;
    let f = EMAX[method][code] * (1 - Math.exp(-minutes / tau)) * boost;
    if (code === "VOL") {
      // Aromatics escape with the steam.
      const escape = method === "decoction" ? (covered ? 20 : 8) : method === "hot" ? (covered ? 60 : 15) : 400;
      f *= Math.exp(-minutes / escape) * (fresh ? 1.15 : 1);
    }
    if (code === "MUC" && method === "hot") f *= Math.exp(-minutes / 30);
    if (code === "RHZ" && !fresh) f = 0;
    out[code] = Math.min(1, f);
  }
  return out;
}

const dryGrams = (lot: HerbLot, grams: number) => (grams * (1 - lot.moisture)) / 0.9;

export interface BrewResult {
  prep: PrepItem;
  /** Per ingredient: overall fraction extracted (for the journal / debug). */
  extracted: number[];
}

/** Brew: returns the preparation (the caller removes the grams from the lots). */
export function brew(p: BrewParams, day: number): BrewResult {
  const cups = Math.max(0.5, p.waterMl / 250);
  const effects: Partial<Record<EffectTag, number>> = {};
  const raw: Partial<Record<EffectTag, number>> = {};
  const flav = { bitter: 0, astringent: 0, sweet: 0, sour: 0, aroma: 0, slimy: 0 };
  let tox = 0, pigment = 0, red = 0, total = 0;
  const extracted: number[] = [];
  const aromas: { smell: string; w: number }[] = [];

  for (const ing of p.ingredients) {
    const info = productById(ing.lot.productId);
    if (!info || ing.grams <= 0) { extracted.push(0); continue; }
    const pr = info.product;
    const fresh = ing.lot.state === "fresh";
    const f = extraction(p.method, p.minutes, p.covered, ing.lot.part, ing.lot.ground, fresh);
    const strSum = pr.compounds.reduce((s, c) => s + c.str, 0) || 1;
    const frac = pr.compounds.reduce((s, c) => s + c.str * (f[c.code as Code] ?? 0.3), 0) / strSum;
    extracted.push(frac);
    const dg = dryGrams(ing.lot, ing.grams);
    const pot = ing.lot.state === "moldy" || ing.lot.state === "spoiled" ? 0 : ing.lot.potency / 100;
    total += dg * frac;

    for (const tag of EFFECT_TAGS) {
      const e = pr.effects[tag];
      if (!e || tag === "toxic") continue;
      raw[tag] = (raw[tag] ?? 0) + dg * pot * e * frac;
    }
    // Harm: the product's toxicity, its "toxic" effect, and raw must-cook fruit.
    let t = Math.max(pr.toxicity / 10, pr.effects.toxic ?? 0);
    // Cyanogenic glycosides (wild cherry) break down as the material dries.
    const glyDriven = pr.compounds[0]?.code === "GLY";
    if (glyDriven && ing.lot.state === "dried") t *= 0.75;
    // Truly poisonous plants (8+) are dangerous in small amounts.
    tox += dg * (t * t * 1.4 + Math.max(0, t - 0.75) * 12) * frac;
    if (pr.cookOnly && p.method !== "decoction") tox += dg * 0.12;
    if (ing.lot.state === "moldy") tox += dg * 0.2;

    for (const c of pr.compounds) {
      const x = dg * (c.str / 10) * (f[c.code as Code] ?? 0);
      if (c.code === "BIT" || c.code === "ALK") flav.bitter += x * (c.code === "ALK" ? 0.6 : 1);
      if (c.code === "TAN") flav.astringent += x;
      if (c.code === "SUG") flav.sweet += x;
      if (c.code === "ACI") flav.sour += x;
      if (c.code === "VOL") { flav.aroma += x; aromas.push({ smell: pr.smell, w: x }); }
      if (c.code === "MUC") flav.slimy += x;
      if (c.code === "PIG" || c.code === "TAN") pigment += x;
      if (c.code === "ANT") red += x;
    }
  }

  const sat = (x: number, k: number) => 1 - Math.exp(-x / k);
  for (const tag of EFFECT_TAGS) if (raw[tag]) effects[tag] = round2(sat(raw[tag]! / cups, 1.6));
  const flavor: Flavor = {
    bitter: round2(sat(flav.bitter / cups, 0.6)), astringent: round2(sat(flav.astringent / cups, 0.8)),
    sweet: round2(sat(flav.sweet / cups, 0.8)), sour: round2(sat(flav.sour / cups, 0.6)),
    aroma: round2(sat(flav.aroma / cups, 0.5)), slimy: round2(sat(flav.slimy / cups, 0.6)),
  };
  const toxicity = round2(sat(tox / cups, 1.2));

  const names = p.ingredients.filter((i) => i.grams > 0).map((i) => productById(i.lot.productId)?.name.split(" (")[0] ?? "herb");
  const label = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} & ${names[1]}` : `${names[0]} blend`;
  const noun = p.method === "decoction" ? "decoction" : p.method === "cold" ? "cold infusion" : "tea";
  aromas.sort((a, b) => b.w - a.w);

  const prep: PrepItem = {
    kind: "prep",
    id: newId("prep"),
    name: `${label} ${noun}`,
    method: p.method,
    volumeMl: Math.round(p.waterMl * (p.method === "decoction" ? Math.exp(-p.minutes / 120) : 0.95)), // decoctions reduce
    effects: effects as Record<string, number>,
    flavor,
    toxicity,
    madeDay: day,
    spoilDay: day + 2,
    ingredients: p.ingredients.filter((i) => i.grams > 0).map((i) => ({
      productId: i.lot.productId, latin: i.lot.latin, name: productById(i.lot.productId)?.name ?? i.lot.productName, grams: Math.round(i.grams),
    })),
    description: describe(p.method, sat(total / cups, 3), sat(pigment / cups, 0.8), sat(red / cups, 0.5), flavor, aromas[0]?.smell),
    protocol: protocolKey(p),
    known: false,
    brewed: { waterMl: p.waterMl, minutes: p.minutes, covered: p.covered },
  };
  return { prep, extracted };
}

const round2 = (v: number) => Math.round(v * 100) / 100;

export function protocolKey(p: BrewParams): string {
  const total = p.ingredients.reduce((s, i) => s + i.grams, 0) || 1;
  const parts = p.ingredients.filter((i) => i.grams > 0)
    .map((i) => `${i.lot.productId}:${Math.round((i.grams / total) * 10) * 10}`)
    .sort();
  return `${p.method}|${parts.join(",")}`;
}

function describe(method: Method, strength: number, pigment: number, red: number, f: Flavor, smell?: string): string {
  const depth = strength > 0.6 ? "deep" : strength > 0.3 ? "clear" : "pale";
  const hue = red > 0.35 ? "ruby-red" : pigment > 0.6 ? "dark brown" : pigment > 0.3 ? "amber" : method === "cold" ? "faintly green" : "green-gold";
  const bits = [`${depth}, ${hue}`];
  if (f.slimy > 0.35) bits.push("thick and slippery");
  if (f.aroma > 0.3 && smell) bits.push(`smells of ${smell.toLowerCase()}`);
  else if (f.aroma > 0.3) bits.push("strongly aromatic");
  if (f.astringent > 0.55) bits.push("puckering just to smell");
  return bits.join("; ");
}

// ---------------------------------------------------------------- tasting

export interface PrepTaste {
  severity: "none" | "mild" | "sick" | "collapse";
  message: string;
  /** Effects you could feel (strength ≥ 0.2), strongest first. */
  felt: EffectTag[];
  status?: { id: string; label: string; minutes: number };
}

const FEEL: Partial<Record<EffectTag, string>> = {
  sleep: "your eyelids grow heavy", calm: "your shoulders loosen", digestion: "warmth settles in your stomach",
  cough: "it coats and soothes your throat", fever: "you break into a light sweat", wound: "it's sharply astringent — a wash for cuts, maybe",
  skin: "it feels cooling where it touches your lips", pain: "a dull ache in your back fades", immunity: "a clean, sharp feeling clears your sinuses",
  stamina: "you feel a lift, like after a good meal", kidney: "you need the outhouse not long after", flavor: "it's genuinely pleasant to drink",
  food: "it's filling, almost a broth", repellent: "the smell alone would keep bugs off", dye: "it stains your cup",
};

export function flavorWords(f: Flavor): string {
  const w: string[] = [];
  if (f.bitter > 0.55) w.push("very bitter"); else if (f.bitter > 0.25) w.push("bitter");
  if (f.astringent > 0.5) w.push("puckering"); else if (f.astringent > 0.25) w.push("dry, tannic");
  if (f.sweet > 0.3) w.push("sweet");
  if (f.sour > 0.3) w.push("tart");
  if (f.aroma > 0.3) w.push("fragrant");
  if (f.slimy > 0.35) w.push("slippery");
  return w.length ? w.join(", ") : "mild, watery";
}

export const perceivedBitter = (f: Flavor) => Math.max(0, f.bitter - 0.4 * f.sweet - 0.25 * f.aroma);

export function tastePrep(p: PrepItem): PrepTaste {
  if (p.spoiled) return { severity: "mild", message: "Sour and off. It's turned.", felt: [], status: { id: "upset", label: "Upset stomach", minutes: 60 } };
  const felt = (Object.entries(p.effects) as [EffectTag, number][])
    .filter(([, v]) => v >= 0.2).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const taste = `${flavorWords(p.flavor)}.`;
  if (p.toxicity >= 0.6) {
    return { severity: "collapse", felt: [], message: `${taste} Then your heart races and the room tilts. You wake at home the next morning.`, status: { id: "recovering", label: "Recovering", minutes: 1440 } };
  }
  if (p.toxicity >= 0.3) {
    return { severity: "sick", felt, message: `${taste} Your stomach clenches. This brew is harmful.`, status: { id: "nauseous", label: "Nauseous", minutes: 180 } };
  }
  const feelings = felt.slice(0, 2).map((t) => FEEL[t]).filter(Boolean);
  const body = feelings.length ? ` After a while, ${feelings.join(", and ")}.` : " You don't feel much of anything.";
  if (p.toxicity >= 0.12) {
    return { severity: "mild", felt, message: `${taste}${body} Your stomach is a little unsettled.`, status: { id: "upset", label: "Upset stomach", minutes: 60 } };
  }
  return { severity: "none", felt, message: `${taste}${body}` };
}

/** Words for how strong an effect is. */
export function strengthWord(v: number) {
  return v >= 0.75 ? "strong" : v >= 0.5 ? "good" : v >= 0.25 ? "mild" : "faint";
}

export { METHOD_NAMES };
