import { Scene, UniversalCamera, Vector3 } from "@babylonjs/core";
import { WALKABLE, heightAt } from "../world/map";

export const EYE_HEIGHT = 1.7;

/** WASD + mouse-look walker for testing in a normal browser. */
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

  let sprint = false;
  // Fly mode (F, or ?fly in the URL): free camera for checking the map from
  // above. Q / E move down / up. Walking rules (ground, fences) are off.
  let fly = new URLSearchParams(location.search).has("fly");
  let rise = 0;
  window.addEventListener("keydown", (e) => {
    if (e.key === "Shift") sprint = true;
    if (e.key === "f" || e.key === "F") fly = !fly;
    if (e.key === "e" || e.key === "E") rise = 1;
    if (e.key === "q" || e.key === "Q") rise = -1;
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
    clampToWalkable(cam.position);
    cam.position.y = heightAt(cam.position.x, cam.position.z) + EYE_HEIGHT;
  });
  return { camera: cam, isFlying: () => fly };
}

/** Keeps a position inside the walkable area (tree line and fence are walls). */
export function clampToWalkable(p: Vector3) {
  p.x = Math.min(WALKABLE.maxX, Math.max(WALKABLE.minX, p.x));
  p.z = Math.min(WALKABLE.maxZ, Math.max(WALKABLE.minZ, p.z));
}
