import { Color3, Engine, MeshBuilder, PointLight, Scene, Vector3, WebXRState } from "@babylonjs/core";
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
import { DAYS_IN_YEAR, formatDoy } from "./sim/phenology";
import { HerbRenderer, QUALITY } from "./veg/herbs";
import { WoodyRenderer } from "./veg/woody";
import { Session } from "./game/session";
import { clearStorage, loadFromStorage } from "./game/state";
import { setupDesktop } from "./interact/desktop";
import { setupVrForaging } from "./interact/vr";
import { Fader } from "./ui/fader";
import { Toasts } from "./ui/toast";
import { Satchel } from "./ui/satchel";
import { StationPanel } from "./ui/stationPanel";
import { HomesteadProps } from "./world/props";
import { createColliders } from "./world/colliders";
import { layout } from "./world/layout";
import { GardenRenderer } from "./veg/garden";
import { Ambience } from "./audio/ambience";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const loading = document.getElementById("loading")!;
const status = document.getElementById("loadingStatus");
const say = (msg: string) => status && (status.textContent = msg);

/**
 * URL options:
 *   ?new                 start a new game (erases the save)
 *   ?doy=150&hour=14     jump to a date and time (testing; not saved until you sleep)
 *   ?quality=low|medium|high · ?overlay=moisture · ?fly · ?dev · ?timelapse
 */
const params = new URLSearchParams(location.search);
const quality = QUALITY[params.get("quality") ?? ""] ?? QUALITY.medium;

async function boot() {
  say("growing the habitat…");
  const simPromise = startSimulation(1);

  const engine = new Engine(canvas, true, { stencil: true, xrCompatible: true }, true);
  const scene = new Scene(engine);
  scene.skipPointerMovePicking = true;

  const sky = createSky(scene);
  const terrain = createTerrain(scene);
  const builder = createHomestead(scene, sky.shadows);
  const woody = new WoodyRenderer(scene, sky.shadows);
  const structural = createStructuralWoody(scene, builder, woody);
  builder.mergeStatic();
  const props = new HomesteadProps(scene, sky.shadows);
  const colliders = createColliders(scene);

  // Lamplight indoors: one point light that moves to the room you're in, lighting only the buildings.
  const lamp = new PointLight("lamp", new Vector3(0, -50, 0), scene);
  lamp.diffuse = new Color3(1, 0.82, 0.6);
  lamp.specular = new Color3(0.1, 0.08, 0.05);
  lamp.range = 11;
  lamp.intensity = 0;
  lamp.includedOnlyMeshes = scene.meshes.filter((m) => m.name.startsWith("static_") || ["bundles", "jars", "crates", "mortar", "pestle", "pot", "coldJar", "ventDoor"].includes(m.name));

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

  if (params.has("new")) clearStorage();
  const resumed = !!loadFromStorage();
  // New game: on the drive by the road. Resumed: beside the bed, where you went to sleep.
  const bed = layout().stations.find((st) => st.id === "bed")!;
  const spawn = resumed ? new Vector3(bed.x, bed.y + EYE_HEIGHT, bed.z) : new Vector3(-20, 0, 12);
  if (!resumed) spawn.y = heightAt(spawn.x, spawn.z) + EYE_HEIGHT;
  const desktop = createDesktopCamera(scene, canvas, spawn);
  const desktopCam = desktop.camera;
  if (resumed) desktopCam.setTarget(new Vector3(spawn.x - 3, spawn.y, spawn.z - 6));
  scene.activeCamera = desktopCam;

  const { xr } = await setupXR(scene, [terrain.mesh, colliders.floors]);
  if (xr) {
    walls.forEach((w) => xr.teleportation?.addBlockerMesh(w));
    xr.teleportation?.addBlockerMesh(colliders.blockers);
    xr.baseExperience.onInitialXRPoseSetObservable.add((xrCam) => {
      xrCam.setTransformationFromNonVRCamera(desktopCam, true);
    });
  }

  say("placing plants…");
  const sim = await simPromise;
  console.info(`[sim] habitat ${sim.timings.habitatMs.toFixed(0)} ms, plants ${sim.timings.placementMs.toFixed(0)} ms, ` +
    `${sim.population.herbs.count} herbs, ${sim.population.woody.count} woody`);
  woody.addPopulation(sim.population.woody);
  const herbs = new HerbRenderer(scene, sim.population, sim.habitat, quality);

  // --- The game.
  const fader = new Fader(scene);
  const ambience = new Ambience();
  const toasts = new Toasts();
  const session = new Session(sky, terrain, herbs, woody, sim.habitat, sim.population, fader, toasts);
  session.timelapse = params.has("timelapse");
  if (params.get("doy")) session.debugSetDay(Math.min(DAYS_IN_YEAR, Math.max(1, Number(params.get("doy")))));
  if (params.get("hour")) session.debugSetMinutes(Number(params.get("hour")) * 60);
  session.movePlayer = (to, face) => {
    const cam = scene.activeCamera!;
    if (xr && cam === xr.baseExperience.camera) {
      xr.baseExperience.camera.position.set(to.x, to.y + xr.baseExperience.camera.realWorldHeight, to.z);
    } else {
      desktop.place(to, face);
    }
  };

  const satchel = new Satchel(session);
  new StationPanel(session);
  const input = setupDesktop(scene, canvas, session, {
    isFlying: desktop.isFlying,
    feet: desktop.feet,
    toggleSatchel: () => satchel.toggle(),
    satchelOpen: () => satchel.open,
  });
  const vr = xr ? setupVrForaging(scene, xr, session, herbs, toasts) : null;
  session.openJournal = () => (vr && scene.activeCamera === xr!.baseExperience.camera ? vr.showJournal() : satchel.show("journal"));
  const garden = new GardenRenderer(scene);
  const refreshWorld = () => {
    props.update(session.state);
    garden.update(session.state, session.season);
  };
  refreshWorld();
  session.subscribe(refreshWorld);

  let overlay: OverlayMode = (params.get("overlay") as OverlayMode) ?? "natural";
  if (!OVERLAY_CYCLE.includes(overlay)) overlay = "natural";
  createHud({
    scene, engine, session, habitat: sim.habitat, herbs,
    desktop: () => input.state,
    overlayLabel: () => (overlay === "suitability" ? `where ${input.state.target?.plant.name ?? "?"} can grow` : OVERLAY_LABEL[overlay]),
  });
  if (overlay !== "natural") applyOverlay(terrain, sim.habitat, overlay);

  let vegetationOn = true;
  scene.onBeforeRenderObservable.add(() => {
    const cam = scene.activeCamera;
    if (!cam) return;
    const dt = Math.min(0.1, engine.getDeltaTime() / 1000);
    if (!xr || cam !== xr.baseExperience.camera) session.room = desktop.room();
    session.update(dt, cam.globalPosition);
    // Lamplight in whichever room you're in: a soft glow by day, the main light at night.
    const room = session.room;
    const lampAt = room ? layout().anchors.lamps.find((l) => l.room === room) : null;
    if (lampAt) lamp.position.set(lampAt.x, lampAt.y, lampAt.z);
    lamp.intensity = lampAt ? 0.3 + 1.3 * (1 - sky.daylight()) : 0;
    structural.setLight(sky.daylight());
    input.update(dt);
    if (vegetationOn) herbs.update(cam.globalPosition);
    ambience.update({ doy: session.state.clock.doy, minutes: session.state.clock.minutes, weather: session.weather, indoors: session.room !== null }, dt);
  });

  // --- Debug keys (see README).
  window.addEventListener("keydown", (e) => {
    if (satchel.open || session.panel) return;
    const c = session.state.clock;
    switch (e.key) {
      case "z": case "Z":
        overlay = OVERLAY_CYCLE[(OVERLAY_CYCLE.indexOf(overlay as never) + 1) % OVERLAY_CYCLE.length] ?? "natural";
        applyOverlay(terrain, sim.habitat, overlay);
        break;
      case "x": case "X": {
        const plant = input.state.target?.plant ?? null;
        overlay = overlay === "suitability" || !plant ? "natural" : "suitability";
        applyOverlay(terrain, sim.habitat, overlay, plant);
        break;
      }
      case "]": session.debugSetDay(c.doy + 7); break;
      case "[": session.debugSetDay(c.doy - 7); break;
      case ".": session.debugSetDay(c.doy + 1); break;
      case ",": session.debugSetDay(c.doy - 1); break;
      case "=": session.debugSetMinutes(c.minutes + 60); break;
      case "-": session.debugSetMinutes(c.minutes - 60); break;
      case "t": case "T":
        session.timelapse = !session.timelapse;
        toasts.show(session.timelapse ? "Time-lapse: one day per second" : "Time-lapse off");
        break;
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

  // ---- Start screen: time waits until you begin (and sound may only start after a click).
  const start = document.getElementById("start")!;
  const btns = document.getElementById("startBtns")!;
  const help = document.getElementById("help")!;
  let begun = false;
  session.paused = true;
  const begin = () => {
    if (begun) return;
    begun = true;
    start.classList.remove("open");
    session.paused = false;
    ambience.start();
    if (params.has("new")) history.replaceState(null, "", location.pathname);
    if (!resumed) {
      help.classList.remove("hidden");
      setTimeout(() => help.classList.add("hidden"), 60000);
      setTimeout(() => toasts.show("March 10. The old place is yours now.", "Your satchel's field notes (Tab) will walk you through a first season. Start by looking closely at a few plants."), 600);
    }
    canvas.requestPointerLock?.();
  };
  const button = (label: string, fn: () => void, alt = false) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (alt) b.className = "alt";
    b.onclick = fn;
    btns.appendChild(b);
  };
  if (resumed) {
    const c = session.state.clock;
    button(`Continue · Year ${c.year}, ${formatDoy(c.doy)}`, begin);
    button("New game", () => {
      if (confirm("Start over? Your saved game will be erased.")) location.search = "?new";
    }, true);
  } else {
    button("Begin", begin);
  }
  start.classList.add("open");
  xr?.baseExperience.onStateChangedObservable.add((st) => { if (st === WebXRState.IN_XR) begin(); });

  window.addEventListener("keydown", (e) => {
    if (e.key === "h" || e.key === "H") help.classList.toggle("hidden");
    if (e.key === "m" || e.key === "M") toasts.show(ambience.toggleMute() ? "Sound off" : "Sound on");
  });

  // Handy in the browser console while building.
  Object.assign(window as unknown as Record<string, unknown>, { scene, engine, sim, herbs, woody, session, layout: layout() });
}

boot().catch((err) => {
  console.error(err);
  loading.textContent = `Failed to start: ${err?.message ?? err}`;
});
