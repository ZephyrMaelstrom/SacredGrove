import { Scene, UniversalCamera, Vector3 } from "@babylonjs/core";
import { heightAt } from "../world/map";
import { step, surfaceAt, type Walker } from "../world/walk";
import type { RoomId } from "../world/layout";

export const EYE_HEIGHT = 1.7;

/**
 * WASD + mouse-look walker for testing in a normal browser. Walks on the
 * ground and on floors, climbs stairs, stops at walls (see world/walk.ts).
 */
export function createDesktopCamera(scene: Scene, canvas: HTMLCanvasElement, start: Vector3) {
  const cam = new UniversalCamera("desktopCam", start, scene);
  cam.minZ = 0.05;
  cam.maxZ = 1200;
  cam.fov = 1.05;
  cam.speed = 0.35;
  cam.angularSensibility = 2500;
  cam.inertia = 0.6;
  cam.keysUp = [87, 38]; // W, ↑
  cam.keysDown = [83, 40]; // S, ↓
  cam.keysLeft = [65, 37]; // A, ←
  cam.keysRight = [68, 39]; // D, →
  cam.attachControl(canvas, true);
  cam.setTarget(start.add(new Vector3(0, 0, 10)));

  canvas.addEventListener("click", () => {
    if (document.pointerLockElement !== canvas) canvas.requestPointerLock?.();
  });

  const feet0 = start.y - EYE_HEIGHT;
  let walker: Walker = { x: start.x, z: start.z, feet: surfaceAt(start.x, start.z, feet0)?.y ?? feet0, vy: 0, room: null };

  let sprint = false;
  // Fly mode (F, or ?fly in the URL): free camera for checking the map from
  // above. Q / E move down / up. Walking rules (ground, walls) are off.
  let fly = new URLSearchParams(location.search).has("fly");
  let rise = 0;
  window.addEventListener("keydown", (e) => {
    if (e.key === "Shift") sprint = true;
    if (e.key === "f" || e.key === "F") {
      fly = !fly;
      if (!fly) {
        // Land on whatever is below.
        const p = cam.position;
        walker = { x: p.x, z: p.z, feet: surfaceAt(p.x, p.z, p.y)?.y ?? heightAt(p.x, p.z), vy: 0, room: null };
      }
    }
    if (fly && (e.key === "e" || e.key === "E")) rise = 1;
    if (fly && (e.key === "q" || e.key === "Q")) rise = -1;
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Shift") sprint = false;
    if ("eEqQ".includes(e.key)) rise = 0;
  });

  scene.onBeforeRenderObservable.add(() => {
    if (scene.activeCamera !== cam) return;
    cam.speed = (sprint ? 0.9 : 0.35) * (fly ? 3 : 1);
    if (fly) {
      cam.position.y = Math.max(heightAt(cam.position.x, cam.position.z) + 0.5, cam.position.y + rise * cam.speed);
      return;
    }
    const dt = Math.min(0.1, scene.getEngine().getDeltaTime() / 1000);
    walker = step(walker, cam.position.x, cam.position.z, dt);
    cam.position.set(walker.x, walker.feet + EYE_HEIGHT, walker.z);
  });

  return {
    camera: cam,
    isFlying: () => fly,
    /** Where your feet are and which room you're in. */
    feet: () => walker.feet,
    room: (): RoomId | null => (fly ? null : walker.room),
    /** Put the walker somewhere (waking up, loading). */
    place(feet: Vector3, faceTo?: Vector3) {
      walker = { x: feet.x, z: feet.z, feet: feet.y, vy: 0, room: null };
      cam.position.set(feet.x, feet.y + EYE_HEIGHT, feet.z);
      if (faceTo) cam.setTarget(new Vector3(faceTo.x, feet.y + EYE_HEIGHT, faceTo.z));
    },
  };
}
