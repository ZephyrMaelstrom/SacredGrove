/**
 * The forager's basket: what you're carrying. Lots of the same product picked
 * on the same day merge (potency averaged by weight). Storage, drying and
 * spoilage arrive with the homestead in M6.
 */
export const BASKET_CAPACITY_G = 4000;

export interface Lot {
  id: string;
  latin: string;
  productId: string;
  productName: string;
  part: string;
  grams: number;
  potency: number;
  /** Absolute day it was harvested (freshness from M6 on). */
  harvestedDay: number;
}

export type Basket = Lot[];

export const basketWeight = (b: Basket) => b.reduce((s, l) => s + l.grams, 0);

/** Add a harvest; returns the grams that actually fit. */
export function addToBasket(b: Basket, lot: Omit<Lot, "id">): number {
  const room = BASKET_CAPACITY_G - basketWeight(b);
  const grams = Math.max(0, Math.min(room, lot.grams));
  if (grams === 0) return 0;
  const same = b.find((l) => l.productId === lot.productId && l.harvestedDay === lot.harvestedDay);
  if (same) {
    same.potency = Math.round((same.potency * same.grams + lot.potency * grams) / (same.grams + grams));
    same.grams += grams;
  } else {
    b.push({ ...lot, grams, id: `${lot.productId}-${lot.harvestedDay}-${b.length}-${Math.round(lot.potency)}` });
  }
  return grams;
}

export function removeLot(b: Basket, id: string): Lot | null {
  const i = b.findIndex((l) => l.id === id);
  return i < 0 ? null : b.splice(i, 1)[0];
}
