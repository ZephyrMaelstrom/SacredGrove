import { Scene, Engine, Camera } from "@babylonjs/core";
import { ZONES, zoneAt } from "../world/map";

/** Desktop overlay: where you are, frame rate, and controls. Hidden in VR. */
export function createHud(scene: Scene, engine: Engine, getCam: () => Camera | null) {
  const el = document.getElementById("hud")!;
  let last = 0;
  scene.onAfterRenderObservable.add(() => {
    const now = performance.now();
    if (now - last < 250) return;
    last = now;
    const cam = getCam();
    if (!cam) return;
    const p = cam.globalPosition;
    const zone = ZONES[zoneAt(p.x, p.z)];
    el.innerHTML =
      `<b>${zone.name}</b><br>` +
      `x ${p.x.toFixed(1)} · z ${p.z.toFixed(1)} m<br>` +
      `${engine.getFps().toFixed(0)} fps · ${scene.getActiveMeshes().length} meshes`;
  });
  return el;
}
