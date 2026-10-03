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
  window.addEventListener("keydown", (e) => { if (e.key === "Shift") sprint = true; });
  window.addEventListener("keyup", (e) => { if (e.key === "Shift") sprint = false; });

  scene.onBeforeRenderObservable.add(() => {
    if (scene.activeCamera !== cam) return;
    cam.speed = sprint ? 0.9 : 0.35;
    clampToWalkable(cam.position);
    cam.position.y = heightAt(cam.position.x, cam.position.z) + EYE_HEIGHT;
  });
  return cam;
}

/** Keeps a position inside the walkable area (tree line and fence are walls). */
export function clampToWalkable(p: Vector3) {
  p.x = Math.min(WALKABLE.maxX, Math.max(WALKABLE.minX, p.x));
  p.z = Math.min(WALKABLE.maxZ, Math.max(WALKABLE.minZ, p.z));
}
