import { Engine, MeshBuilder, Scene, Vector3 } from "@babylonjs/core";
import { createSky } from "./world/sky";
import { createTerrain } from "./world/terrain";
import { createHomestead } from "./world/buildings";
import { createStructuralWoody } from "./world/trees";
import { heightAt, WALKABLE } from "./world/map";
import { setupXR } from "./xr/setupXR";
import { createDesktopCamera, EYE_HEIGHT } from "./xr/desktopControls";
import { createHud } from "./debug/hud";
import { applyOverlay, OVERLAY_CYCLE, OVERLAY_LABEL, type OverlayMode } from "./debug/overlay";
import { startSimulation } from "./sim/client";
import { START_DOY, DAYS_IN_YEAR } from "./sim/phenology";
import { HerbRenderer, QUALITY } from "./veg/herbs";
import { WoodyRenderer } from "./veg/woody";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const loading = document.getElementById("loading")!;
const status = document.getElementById("loadingStatus");
const say = (msg: string) => status && (status.textContent = msg);

/** URL options: ?doy=150 (day of year), ?quality=low|medium|high, ?overlay=moisture */
const params = new URLSearchParams(location.search);
const startDay = Math.min(DAYS_IN_YEAR, Math.max(1, Number(params.get("doy")) || START_DOY));
const quality = QUALITY[params.get("quality") ?? ""] ?? QUALITY.medium;

async function boot() {
  // Start the simulation first: habitat + plants compute while the scene builds.
  say("growing the habitat…");
  const simPromise = startSimulation(1);

  const engine = new Engine(canvas, true, { stencil: true, xrCompatible: true }, true);
  const scene = new Scene(engine);
  scene.skipPointerMovePicking = true;

  const { shadows } = createSky(scene);
  const terrain = createTerrain(scene);
  const builder = createHomestead(scene, shadows);
  const woody = new WoodyRenderer(scene, shadows);
  createStructuralWoody(scene, builder, woody);
  builder.mergeStatic();

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
  const { camera: desktopCam } = createDesktopCamera(scene, canvas, spawn);
  scene.activeCamera = desktopCam;

  const { xr } = await setupXR(scene, [terrain.mesh]);
  if (xr) {
    walls.forEach((w) => xr.teleportation?.addBlockerMesh(w));
    xr.baseExperience.onInitialXRPoseSetObservable.add((xrCam) => {
      xrCam.setTransformationFromNonVRCamera(desktopCam, true);
    });
  }

  // --- Vegetation from the simulation.
  say("placing plants…");
  const sim = await simPromise;
  console.info(`[sim] habitat ${sim.timings.habitatMs.toFixed(0)} ms, plants ${sim.timings.placementMs.toFixed(0)} ms, ` +
    `${sim.population.herbs.count} herbs, ${sim.population.woody.count} woody`);
  woody.addPopulation(sim.population.woody);
  const herbs = new HerbRenderer(scene, sim.population, sim.habitat, quality);

  let day = startDay;
  let overlay: OverlayMode = (params.get("overlay") as OverlayMode) ?? "natural";
  if (!OVERLAY_CYCLE.includes(overlay)) overlay = "natural";
  const setDay = (d: number) => {
    day = ((d - 1 + DAYS_IN_YEAR) % DAYS_IN_YEAR) + 1;
    herbs.setDay(day);
    woody.setDay(day);
    terrain.setVegetationTint(herbs.groundTint(), 0.3);
    if (overlay !== "natural") applyOverlay(terrain, sim.habitat, overlay, hud.lookedAt());
  };

  const hud = createHud({
    scene, engine, ground: terrain.mesh,
    getCam: () => scene.activeCamera,
    getDay: () => day,
    getOverlay: () => (overlay === "suitability" ? `where ${hud.lookedAt()?.name ?? "?"} can grow` : OVERLAY_LABEL[overlay]),
    habitat: sim.habitat, herbs, woody,
  });
  setDay(day);
  if (overlay !== "natural") applyOverlay(terrain, sim.habitat, overlay);

  let vegetationOn = true;
  scene.onBeforeRenderObservable.add(() => {
    const cam = scene.activeCamera;
    if (cam && vegetationOn) herbs.update(cam.globalPosition);
  });

  // --- Desktop debug keys (see README).
  window.addEventListener("keydown", (e) => {
    switch (e.key) {
      case "z": case "Z": {
        overlay = OVERLAY_CYCLE[(OVERLAY_CYCLE.indexOf(overlay as never) + 1) % OVERLAY_CYCLE.length] ?? "natural";
        applyOverlay(terrain, sim.habitat, overlay);
        break;
      }
      case "x": case "X": {
        const plant = hud.lookedAt();
        overlay = overlay === "suitability" || !plant ? "natural" : "suitability";
        applyOverlay(terrain, sim.habitat, overlay, plant);
        break;
      }
      case "]": setDay(day + 7); break;
      case "[": setDay(day - 7); break;
      case ".": setDay(day + 1); break;
      case ",": setDay(day - 1); break;
      case "v": case "V":
        vegetationOn = !vegetationOn;
        herbs.setEnabled(vegetationOn);
        break;
    }
  });

  await scene.whenReadyAsync();
  loading.classList.add("hidden");
  engine.runRenderLoop(() => scene.render());
  window.addEventListener("resize", () => engine.resize());

  // Handy in the browser console while building.
  Object.assign(window as unknown as Record<string, unknown>, { scene, engine, sim, herbs, woody, setDay });
}

boot().catch((err) => {
  console.error(err);
  loading.textContent = `Failed to start: ${err?.message ?? err}`;
});
