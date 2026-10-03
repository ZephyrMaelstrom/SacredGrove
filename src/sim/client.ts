/** Main-thread side of the simulation worker. */
import type { SimRequest, SimResponse } from "./sim.worker";

export type SimReady = Extract<SimResponse, { type: "ready" }>;

export function startSimulation(map = 1): Promise<SimReady> {
  const worker = new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module" });
  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<SimResponse>) => {
      if (e.data.type === "ready") resolve(e.data);
      else reject(new Error(e.data.message));
    };
    worker.onerror = (e) => reject(new Error(e.message));
    worker.postMessage({ type: "init", map } satisfies SimRequest);
  });
}
