/**
 * VR movement: smooth walking on the left thumbstick and smooth (or snap)
 * turning on the right, with no teleporting needed.
 *
 *   Left stick       walk (where you look, or where the left controller
 *                    points — your choice); click it to hurry
 *   Right stick      turn left / right
 *
 * Walking goes through the same walker as the desktop (world/walk.ts): you
 * follow the ground and floors, climb stairs, can't walk through walls, and
 * stay inside the property. Your real steps and leaning are never fought.
 *
 * With hand tracking alone (no thumbsticks) the teleport arc comes back so
 * you can still get around; it switches off again when controllers return.
 *
 * Comfort settings live in the satchel's Tools tab.
 */
import { Mesh, MeshBuilder, Quaternion, StandardMaterial, DynamicTexture, Vector3, WebXRFeatureName, WebXRState, type Scene, type WebXRDefaultExperience, type WebXRInputSource } from "@babylonjs/core";
import { step, surfaceAt, type Walker } from "../world/walk";
import { loadComfort, saveComfort, locomote, type ComfortSettings, type StickInput, type TurnState } from "./comfort";

function vignette(scene: Scene): Mesh {
  const tex = new DynamicTexture("vignetteTex", { width: 256, height: 256 }, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const g = ctx.createRadialGradient(128, 128, 40, 128, 128, 128);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(0.55, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,1)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  tex.hasAlpha = true;
  tex.update();
  const mat = new StandardMaterial("vignetteMat", scene);
  mat.diffuseTexture = tex;
  mat.opacityTexture = tex;
  mat.emissiveColor.set(0, 0, 0);
  mat.disableLighting = true;
  mat.disableDepthWrite = true;
  mat.backFaceCulling = false;
  mat.alpha = 0;
  const plane = MeshBuilder.CreatePlane("vignette", { size: 0.9 }, scene);
  plane.material = mat;
  plane.isPickable = false;
  plane.renderingGroupId = 3;
  plane.setEnabled(false);
  return plane;
}

export function setupLocomotion(scene: Scene, xr: WebXRDefaultExperience, opts: { blocked: () => boolean }) {
  const comfort = loadComfort();
  const cam = xr.baseExperience.camera;
  const fm = xr.baseExperience.featuresManager;
  const turn: TurnState = { armed: true };
  const sources: Partial<Record<"left" | "right", WebXRInputSource>> = {};
  let hands = 0, pads = 0;
  let walker: Walker | null = null;
  let last = new Vector3();
  let hurry = false;
  let fade = 0;

  // Teleport only when there's no controller to walk with.
  const teleportOn = (on: boolean) => {
    try {
      if (on) fm.attachFeature(WebXRFeatureName.TELEPORTATION);
      else fm.detachFeature(WebXRFeatureName.TELEPORTATION);
    } catch { /* feature not available */ }
  };
  const refreshTeleport = () => teleportOn(pads === 0 && hands > 0);

  xr.input.onControllerAddedObservable.add((c) => {
    const side = c.inputSource.handedness;
    if (c.inputSource.hand) hands++;
    else if (c.inputSource.gamepad) {
      pads++;
      if (side === "left" || side === "right") sources[side] = c;
      c.onMotionControllerInitObservable.add((mc) => {
        if (side === "left") mc.getComponent("xr-standard-thumbstick")?.onButtonStateChangedObservable.add((b) => {
          if (b.changes.pressed?.current) hurry = !hurry;
        });
      });
    }
    refreshTeleport();
  });
  xr.input.onControllerRemovedObservable.add((c) => {
    if (c.inputSource.hand) hands = Math.max(0, hands - 1);
    else if (c.inputSource.gamepad) {
      pads = Math.max(0, pads - 1);
      for (const k of ["left", "right"] as const) if (sources[k] === c) delete sources[k];
    }
    refreshTeleport();
  });
  xr.baseExperience.onStateChangedObservable.add((st) => {
    if (st === WebXRState.IN_XR) {
      walker = null;
      refreshTeleport();
    }
  });

  const veil = vignette(scene);

  const axes = (src?: WebXRInputSource) => {
    const t = src?.motionController?.getComponent("xr-standard-thumbstick") ?? src?.motionController?.getComponent("xr-standard-touchpad");
    return t ? t.axes : { x: 0, y: 0 };
  };

  scene.onBeforeRenderObservable.add(() => {
    if (xr.baseExperience.state !== WebXRState.IN_XR) { veil.setEnabled(false); return; }
    const dt = Math.min(0.05, scene.getEngine().getDeltaTime() / 1000);
    const height = cam.realWorldHeight || 1.6;
    const p = cam.position;

    // (Re)start tracking after entering VR or a jump (teleport, waking in bed).
    if (!walker || Vector3.Distance(p, last) > 1.5) {
      const feet = p.y - height;
      const floor = surfaceAt(p.x, p.z, feet + 0.3)?.y ?? feet;
      p.y += floor - feet; // stand exactly on the floor
      walker = { x: p.x, z: p.z, feet: floor, vy: 0, room: null };
    }

    const l = axes(sources.left), r = axes(sources.right);
    const busy = opts.blocked();
    const input: StickInput = busy ? { moveX: 0, moveY: 0, turnX: 0, hurry } : { moveX: l.x, moveY: l.y, turnX: r.x, hurry };
    // Hurrying lasts until you let go of the stick.
    if (Math.abs(l.x) < 0.15 && Math.abs(l.y) < 0.15) hurry = false;

    // Facing: the headset, or the left controller, flattened to the ground.
    let fwd = cam.getDirection(Vector3.Forward());
    if (comfort.direction === "hand" && sources.left?.pointer) fwd = sources.left.pointer.getDirection(Vector3.Forward());
    const yaw = Math.atan2(fwd.x, fwd.z);
    const m = locomote(input, yaw, dt, comfort, turn);

    // Walk with the stick through the walker (walls, stairs, floors). Your real
    // steps and leaning (over the workbench, say) are taken as they are.
    const here: Walker = { ...walker, x: p.x, z: p.z };
    const next = step(here, p.x + m.dx, p.z + m.dz, dt);
    p.x = next.x;
    p.z = next.z;
    p.y += next.feet - walker.feet;
    walker = next;

    // Turn about your own head.
    if (m.dYaw) {
      const e = cam.rotationQuaternion.toEulerAngles();
      cam.rotationQuaternion = Quaternion.FromEulerAngles(e.x, e.y + m.dYaw, e.z);
    }
    last = p.clone();

    // Comfort vignette.
    const moving = Math.hypot(m.dx, m.dz) / dt > 0.2 || Math.abs(m.dYaw) / dt > 0.2;
    fade += ((comfort.vignette && moving ? 1 : 0) - fade) * Math.min(1, dt * 8);
    veil.setEnabled(fade > 0.02);
    if (fade > 0.02) {
      veil.position.copyFrom(p.add(cam.getDirection(Vector3.Forward()).scale(0.3)));
      veil.rotationQuaternion = cam.rotationQuaternion.clone();
      (veil.material as StandardMaterial).alpha = 0.85 * fade;
    }
  });

  return {
    comfort,
    /** Change a setting and remember it. */
    set<K extends keyof ComfortSettings>(k: K, v: ComfortSettings[K]) {
      comfort[k] = v;
      saveComfort(comfort);
    },
  };
}
