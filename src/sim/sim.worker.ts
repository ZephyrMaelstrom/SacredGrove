/// <reference lib="webworker" />
/**
 * Simulation worker: builds the habitat grid (M2) and the plant population
 * (M3) off the render thread, then hands the typed arrays back without
 * copying (transferable buffers).
 *
 * Later milestones add to this worker: the day clock and patch recovery (M4),
 * harvest pressure (M5), succession (M8).
 */
import { computeHabitat, type HabitatLayers } from "./habitat";
import { populate, type Population, type InstanceSet } from "./placement";

export type SimRequest = { type: "init"; map: number; seed?: number };
export type SimResponse =
  | { type: "ready"; habitat: HabitatLayers; population: Population; timings: { habitatMs: number; placementMs: number } }
  | { type: "error"; message: string };

const buffersOf = (o: object): ArrayBuffer[] =>
  Object.values(o).filter((v): v is ArrayBufferView => ArrayBuffer.isView(v)).map((v) => v.buffer as ArrayBuffer);

self.onmessage = (e: MessageEvent<SimRequest>) => {
  if (e.data.type !== "init") return;
  try {
    const t0 = performance.now();
    const habitat = computeHabitat();
    const t1 = performance.now();
    const population = populate(habitat, e.data.map, e.data.seed);
    const t2 = performance.now();
    const transfer = [
      ...buffersOf(habitat),
      ...buffersOf(population.herbs as InstanceSet),
      ...buffersOf(population.woody as InstanceSet),
      population.dominant.buffer as ArrayBuffer,
    ];
    const msg: SimResponse = { type: "ready", habitat, population, timings: { habitatMs: t1 - t0, placementMs: t2 - t1 } };
    (self as unknown as Worker).postMessage(msg, transfer);
  } catch (err) {
    (self as unknown as Worker).postMessage({ type: "error", message: String((err as Error)?.stack ?? err) } satisfies SimResponse);
  }
};
