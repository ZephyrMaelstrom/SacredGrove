/** Small deterministic RNG + hashing (same results in the worker, the renderer and tests). */

/** mulberry32: fast, good enough for placement, fully reproducible from a seed. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 32-bit hash of a string (FNV-1a), e.g. to seed a plant's own patch pattern. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mix two integers into a new 32-bit seed. */
export const mixSeed = (a: number, b: number) => (Math.imul(a ^ (b + 0x9e3779b9), 0x85ebca6b) ^ (a >>> 13)) >>> 0;
