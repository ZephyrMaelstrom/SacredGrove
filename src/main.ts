import { Engine, MeshBuilder, Scene, Vector3 } from "@babylonjs/core";
import { createSky } from "./world/sky";
import { createTerrain } from "./world/terrain";
import { createHomestead } from "./world/buildings";
import { createWoody } from "./world/trees";
import { heightAt, WALKABLE } from "./world/map";
import { setupXR } from "./xr/setupXR";
import { createDesktopCamera, EYE_HEIGHT } from "./xr/desktopControls";
import { createHud } from "./debug/hud";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const loading = document.getElementById("loading")!;

async function boot() {
  const engine = new Engine(canvas, true, { stencil: true, xrCompatible: true }, true);
  const scene = new Scene(engine);
  scene.skipPointerMovePicking = true;

  const { shadows } = createSky(scene);
  const terrain = createTerrain(scene);
  const builder = createHomestead(scene, shadows);
  createWoody(scene, builder, shadows);

  // Invisible walls: teleport rays stop at the fence and the tree line.
  const walls = [
    MeshBuilder.CreateBox("wall_north", { width: 160, height: 30, depth: 1 }, scene),
    MeshBuilder.CreateBox("wall_west", { width: 1, height: 30, depth: 400 }, scene),
    MeshBuilder.CreateBox("wall_east", { width: 1, height: 30, depth: 400 }, scene),
  ];
  walls[0].position.set(0, 10, WALKABLE.maxZ + 1);
  walls[1].position.set(WALKABLE.minX - 1, 10, 200);
  walls[2].position.set(WALKABLE.maxX + 1, 10, 200);
  walls.forEach((w) => (w.isVisible = false));

  // Spawn on the drive near the road, looking north up the property.
  const spawn = new Vector3(-20, heightAt(-20, 12) + EYE_HEIGHT, 12);
  const desktopCam = createDesktopCamera(scene, canvas, spawn);
  scene.activeCamera = desktopCam;

  const { xr } = await setupXR(scene, [terrain.mesh]);
  if (xr) {
    walls.forEach((w) => xr.teleportation?.addBlockerMesh(w));
    xr.baseExperience.onInitialXRPoseSetObservable.add((xrCam) => {
      xrCam.setTransformationFromNonVRCamera(desktopCam, true);
    });
  }

  createHud(scene, engine, () => scene.activeCamera);

  // Debug: Z toggles the zone overlay (M1 placement check).
  let zonesOn = false;
  window.addEventListener("keydown", (e) => {
    if (e.key === "z" || e.key === "Z") {
      zonesOn = !zonesOn;
      terrain.setDebugZones(zonesOn);
    }
  });

  await scene.whenReadyAsync();
  loading.classList.add("hidden");
  engine.runRenderLoop(() => scene.render());
  window.addEventListener("resize", () => engine.resize());

  // Handy in the browser console while building.
  Object.assign(window as unknown as Record<string, unknown>, { scene, engine });
}

boot().catch((err) => {
  console.error(err);
  loading.textContent = `Failed to start: ${err?.message ?? err}`;
});
