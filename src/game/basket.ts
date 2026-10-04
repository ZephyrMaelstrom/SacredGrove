/**
 * The forager's basket: what you're carrying (fresh harvest, dried goods,
 * bottled preparations). Fresh lots of the same product picked the same day
 * merge, with potency averaged by weight.
 */
import { FRESH_MOISTURE, isHerb, itemGrams, newId, type HerbLot, type Item } from "./items";

export const BASKET_CAPACITY_G = 4000;

/** Back-compat name: a harvested lot. */
export type Lot = HerbLot;
export type Basket = Item[];

export const basketWeight = (b: Basket) => b.reduce((s, i) => s + itemGrams(i), 0);

export type NewLot = Pick<HerbLot, "latin" | "productId" | "productName" | "part" | "grams" | "potency" | "harvestedDay">;

/** Add a fresh harvest; returns the grams that actually fit. */
export function addToBasket(b: Basket, lot: NewLot): number {
  const room = BASKET_CAPACITY_G - basketWeight(b);
  const grams = Math.max(0, Math.min(room, lot.grams));
  if (grams === 0) return 0;
  const same = b.find((l): l is HerbLot => isHerb(l) && l.productId === lot.productId && l.harvestedDay === lot.harvestedDay && l.state === "fresh" && l.ground === 0);
  if (same) {
    same.potency = Math.round((same.potency * same.grams + lot.potency * grams) / (same.grams + grams));
    same.grams += grams;
  } else {
    b.push({
      ...lot, grams, kind: "herb", id: newId(lot.productId),
      moisture: FRESH_MOISTURE[lot.part] ?? 0.7, state: "fresh", mold: 0, ground: 0, updatedDay: lot.harvestedDay,
    });
  }
  return grams;
}

export function removeLot(b: Item[], id: string): Item | null {
  const i = b.findIndex((l) => l.id === id);
  return i < 0 ? null : b.splice(i, 1)[0];
}

/** Move up to `grams` of an item from one list to another, splitting herb lots. */
export function moveItem(from: Item[], to: Item[], id: string, grams = Infinity): Item | null {
  const i = from.findIndex((l) => l.id === id);
  if (i < 0) return null;
  const it = from[i];
  if (!isHerb(it) || grams >= it.grams) {
    from.splice(i, 1);
    to.push(it);
    return it;
  }
  const part: HerbLot = { ...it, id: newId(it.productId), grams: Math.round(grams) };
  it.grams -= part.grams;
  to.push(part);
  return part;
}
