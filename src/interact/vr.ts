/**
 * VR foraging controls (Quest, hands or controllers).
 *
 *   Reach down to a plant and squeeze the grip (controllers) or pinch
 *   (hands) and hold          → harvest with the tool in your right hand
 *   Look steadily at a plant  → identify it
 *   Right B / thumbstick click → next tool        Left Y → gloves on/off
 *   Left X (or Menu)           → open/close the satchel panel
 *   Right A, or pinch beside the door or barn → sleep / unload
 *
 * A small readout floats above your left hand: time, weather, tool, basket,
 * what you're looking at, and the last thing that happened.
 */
import {
  Color3, Mesh, MeshBuilder, StandardMaterial, TransformNode, Vector3,
  WebXRFeatureName, WebXRHandJoint, WebXRState,
  type AbstractMesh, type Scene, type WebXRDefaultExperience, type WebXRHandTracking,
  type WebXRInputSource, type WebXRHand, type WebXRAbstractMotionController,
} from "@babylonjs/core";
import { AdvancedDynamicTexture, Button, Control, Grid, Rectangle, StackPanel, TextBlock } from "@babylonjs/gui";
import type { Session } from "../game/session";
import { DOOR, BARN } from "../game/session";
import type { Target } from "../game/forage";
import { TOOL_NAMES, type Tool } from "../game/harvest";
import { describe, temperatureAt } from "../time/climate";
import { formatTime } from "../time/clock";
import { formatDoy } from "../sim/phenology";
import { heightAt, groundHit } from "../world/map";
import { PLANTS } from "../data/plants";
import type { HerbRenderer } from "../veg/herbs";
import type { Toasts } from "../ui/toast";

type Side = "left" | "right";

interface HandState {
  side: Side;
  controller?: WebXRInputSource;
  motion?: WebXRAbstractMotionController;
  hand?: WebXRHand;
  pressed: boolean;
  wasPressed: boolean;
  progress: number;
}

const PINCH = 0.025;

function toolMeshes(scene: Scene) {
  const steel = new StandardMaterial("steel", scene);
  steel.diffuseColor = new Color3(0.75, 0.77, 0.8);
  steel.specularColor = new Color3(0.6, 0.6, 0.6);
  const wood = new StandardMaterial("toolWood", scene);
  wood.diffuseColor = new Color3(0.45, 0.3, 0.18);
  const make = (name: string, parts: Mesh[]) => {
    const root = new TransformNode(name, scene);
    for (const p of parts) { p.parent = root; p.isPickable = false; }
    root.setEnabled(false);
    return root;
  };
  const kHandle = MeshBuilder.CreateBox("kh", { width: 0.022, height: 0.022, depth: 0.1 }, scene);
  kHandle.material = wood;
  const kBlade = MeshBuilder.CreateBox("kb", { width: 0.004, height: 0.022, depth: 0.11 }, scene);
  kBlade.position.z = -0.1;
  kBlade.material = steel;
  const tHandle = MeshBuilder.CreateCylinder("th", { diameter: 0.025, height: 0.11, tessellation: 8 }, scene);
  tHandle.rotation.x = Math.PI / 2;
  tHandle.material = wood;
  const tScoop = MeshBuilder.CreateCylinder("ts", { diameterTop: 0.02, diameterBottom: 0.06, height: 0.14, tessellation: 8, arc: 0.5 }, scene);
  tScoop.rotation.x = Math.PI / 2;
  tScoop.position.z = -0.13;
  tScoop.material = steel;
  return { knife: make("knifeTool", [kHandle, kBlade]), trowel: make("trowelTool", [tHandle, tScoop]) };
}

export function setupVrForaging(scene: Scene, xr: WebXRDefaultExperience, session: Session, herbs: HerbRenderer, toasts: Toasts) {
  const hands: Record<Side, HandState> = {
    left: { side: "left", pressed: false, wasPressed: false, progress: 0 },
    right: { side: "right", pressed: false, wasPressed: false, progress: 0 },
  };
  const tools = toolMeshes(scene);
  let gazeTarget: Target | null = null;
  let gazeProgress = 0;

  // ---------------------------------------------------------- inputs
  xr.input.onControllerAddedObservable.add((c) => {
    const side = c.inputSource.handedness as Side;
    if (side !== "left" && side !== "right") return;
    hands[side].controller = c;
    c.onMotionControllerInitObservable.add((mc) => {
      hands[side].motion = mc;
      const btn = (id: string, fn: () => void) => mc.getComponent(id)?.onButtonStateChangedObservable.add((comp) => { if (comp.changes.pressed?.current) fn(); });
      if (side === "right") {
        btn("b-button", () => session.cycleTool(1));
        btn("xr-standard-thumbstick", () => session.cycleTool(1));
        btn("a-button", () => tryInteract(null));
      } else {
        btn("x-button", () => satchel.toggle());
        btn("menu", () => satchel.toggle());
        btn("y-button", () => session.toggleGloves());
      }
    });
  });
  xr.input.onControllerRemovedObservable.add((c) => {
    const side = c.inputSource.handedness as Side;
    if (hands[side]?.controller === c) Object.assign(hands[side], { controller: undefined, motion: undefined });
  });
  const handTracking = xr.baseExperience.featuresManager.getEnabledFeature(WebXRFeatureName.HAND_TRACKING) as WebXRHandTracking | null;
  handTracking?.onHandAddedObservable.add((hand) => {
    const side = hand.xrController.inputSource.handedness as Side;
    if (side === "left" || side === "right") hands[side].hand = hand;
  });
  handTracking?.onHandRemovedObservable.add((hand) => {
    for (const h of Object.values(hands)) if (h.hand === hand) h.hand = undefined;
  });

  const handPosition = (h: HandState): Vector3 | null => {
    if (h.hand) {
      const tip = h.hand.getJointMesh(WebXRHandJoint.INDEX_FINGER_TIP);
      const thumb = h.hand.getJointMesh(WebXRHandJoint.THUMB_TIP);
      if (tip && thumb) return tip.absolutePosition.add(thumb.absolutePosition).scale(0.5);
    }
    const m = h.controller?.grip ?? h.controller?.pointer;
    return m ? m.absolutePosition.clone() : null;
  };
  const isPressed = (h: HandState): boolean => {
    if (h.hand) {
      const tip = h.hand.getJointMesh(WebXRHandJoint.INDEX_FINGER_TIP);
      const thumb = h.hand.getJointMesh(WebXRHandJoint.THUMB_TIP);
      if (tip && thumb) return Vector3.Distance(tip.absolutePosition, thumb.absolutePosition) < PINCH;
    }
    const mc = h.motion;
    return !!(mc?.getComponent("xr-standard-squeeze")?.pressed);
  };
  const pulse = (h: HandState, strength: number, ms: number) => {
    try { void h.motion?.pulse(strength, ms); } catch { /* no haptics */ }
  };

  /** Which plant is within reach of a hand (low enough to actually touch it). */
  const reachable = (pos: Vector3): Target | null => {
    const t = session.targetAt(pos.x, pos.z, 0.45, 0.9);
    if (!t) return null;
    const gy = heightAt(t.x, t.z);
    if (t.layer === "h") {
      const top = gy + herbs.heightOf(t.index) + 0.35;
      return pos.y >= gy - 0.15 && pos.y <= top ? t : null;
    }
    return pos.y <= gy + 2.6 ? t : null;
  };

  const tryInteract = (handPos: Vector3 | null) => {
    const cam = scene.activeCamera;
    if (!cam) return false;
    const p = handPos ?? cam.globalPosition;
    for (const it of [DOOR, BARN]) {
      const d = Math.hypot(p.x - it.x, p.z - it.z);
      if ((handPos && d < 1.4) || (!handPos && d < it.radius)) {
        session.interact(it);
        return true;
      }
    }
    return false;
  };

  // ---------------------------------------------------------- wrist readout
  const wrist = MeshBuilder.CreatePlane("wristPanel", { width: 0.2, height: 0.125 }, scene);
  wrist.billboardMode = Mesh.BILLBOARDMODE_ALL;
  wrist.isPickable = false;
  wrist.renderingGroupId = 2;
  const wristUi = AdvancedDynamicTexture.CreateForMesh(wrist, 640, 400, false);
  const wristBg = new Rectangle("wbg");
  wristBg.background = "rgba(18,26,18,0.82)";
  wristBg.cornerRadius = 24;
  wristBg.thickness = 0;
  wristUi.addControl(wristBg);
  const wristText = new TextBlock("wtext", "");
  wristText.color = "#eef0e6";
  wristText.fontSize = 30;
  wristText.textWrapping = true;
  wristText.paddingLeft = wristText.paddingRight = "24px";
  wristText.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
  wristBg.addControl(wristText);
  let lastToast = "";
  wrist.setEnabled(false);

  // ---------------------------------------------------------- satchel panel
  const satchel = createVrSatchel(scene, session);

  // ---------------------------------------------------------- per frame
  scene.onBeforeRenderObservable.add(() => {
    const inXR = xr.baseExperience.state === WebXRState.IN_XR;
    wrist.setEnabled(inXR);
    if (!inXR) return;
    const dt = scene.getEngine().getDeltaTime() / 1000;
    const cam = scene.activeCamera!;

    // Gaze identifies.
    const dir = cam.getDirection(Vector3.Forward());
    const cp = cam.globalPosition;
    const hit = groundHit(cp.x, cp.y, cp.z, dir.x, dir.y, dir.z, 6);
    gazeTarget = hit && hit.distance <= 4.5 ? session.targetAt(hit.x, hit.z) : null;
    gazeProgress = satchel.open ? 0 : session.look(gazeTarget, dt);

    for (const h of Object.values(hands)) {
      const pos = handPosition(h);
      h.wasPressed = h.pressed;
      h.pressed = !!pos && isPressed(h);
      if (!pos || satchel.open) { session.release(h.side); h.progress = 0; continue; }
      const edge = h.pressed && !h.wasPressed;
      if (edge && tryInteract(pos)) continue;
      const t = h.pressed ? reachable(pos) : null;
      if (h.pressed && t) {
        const before = h.progress;
        h.progress = session.hold(h.side, t);
        if (h.progress >= 1 && before < 1) pulse(h, 0.6, 80);
        else if (h.progress > 0 && Math.floor(h.progress * 4) !== Math.floor(before * 4)) pulse(h, 0.15, 20);
      } else {
        session.release(h.side);
        h.progress = 0;
      }
    }

    // Tool model in the right hand.
    const right = hands.right;
    const anchor: AbstractMesh | null = right.hand?.getJointMesh(WebXRHandJoint.WRIST) ?? right.controller?.grip ?? null;
    const tool: Tool = session.state.tool;
    for (const [name, mesh] of Object.entries(tools)) {
      const on = name === tool && !!anchor;
      mesh.setEnabled(on);
      if (on && mesh.parent !== anchor) {
        mesh.parent = anchor;
        mesh.position.set(0, -0.01, right.hand ? -0.08 : -0.02);
        mesh.rotation.set(0, 0, 0);
      }
    }

    // Wrist readout above the left hand.
    const lp = handPosition(hands.left);
    if (lp) wrist.position.copyFrom(lp.add(new Vector3(0, 0.12, 0)));
    else wrist.position.copyFrom(cam.globalPosition.add(dir.scale(0.6)).add(new Vector3(0, -0.35, 0)));
    const s = session.state, w = session.weather;
    const lines = [
      `${formatTime(s.clock.minutes)} · ${formatDoy(s.clock.doy)} · ${Math.round(temperatureAt(w, s.clock.minutes))}°F ${describe(w, s.clock.minutes)}`,
      `${TOOL_NAMES[s.tool]}${s.gloves ? " + gloves" : ""} · basket ${session.basketLine()}`,
    ];
    const statuses = s.statuses.filter((x) => x.until > session.nowAbsMinute).map((x) => x.label);
    if (statuses.length) lines.push(statuses.join(" · "));
    const prog = Math.max(hands.left.progress, hands.right.progress);
    if (prog > 0) lines.push(`Harvesting ${"▮".repeat(Math.ceil(prog * 8))}${"▯".repeat(8 - Math.ceil(prog * 8))}`);
    else if (gazeTarget) lines.push(`${session.displayName(gazeTarget)}${gazeProgress > 0 ? " — looking closer…" : ""}`);
    const near = session.nearbyInteractable(cam.globalPosition.x, cam.globalPosition.z);
    if (near) lines.push(`A / pinch at it: ${near.label}`);
    if (toasts.last && toasts.last !== lastToast) lastToast = toasts.last;
    if (lastToast) lines.push(lastToast);
    wristText.text = lines.join("\n");
  });

  return { hands };
}

// ------------------------------------------------------------ VR satchel

function createVrSatchel(scene: Scene, session: Session) {
  const plane = MeshBuilder.CreatePlane("vrSatchel", { width: 0.9, height: 0.64 }, scene);
  plane.isNearPickable = true;
  plane.renderingGroupId = 2;
  plane.setEnabled(false);
  const ui = AdvancedDynamicTexture.CreateForMesh(plane, 1152, 820);
  const bg = new Rectangle("sbg");
  bg.background = "rgba(20,28,20,0.92)";
  bg.cornerRadius = 30;
  bg.thickness = 0;
  ui.addControl(bg);
  const grid = new Grid("sgrid");
  grid.addRowDefinition(90, true);
  grid.addRowDefinition(1);
  bg.addControl(grid);
  const head = new StackPanel("shead");
  head.isVertical = false;
  head.height = "90px";
  grid.addControl(head, 0, 0);
  const body = new StackPanel("sbody");
  body.paddingLeft = body.paddingRight = "30px";
  grid.addControl(body, 1, 0);

  let tab: "basket" | "tools" | "journal" = "basket";
  const button = (label: string, w: number, fn: () => void, warn = false) => {
    const b = Button.CreateSimpleButton(`b_${label}_${Math.random()}`, label);
    b.width = `${w}px`;
    b.height = "64px";
    b.color = "#eef0e6";
    b.fontSize = 28;
    b.background = warn ? "#7a3a2a" : "#3d5a36";
    b.cornerRadius = 12;
    b.paddingLeft = b.paddingRight = "6px";
    b.onPointerUpObservable.add(fn);
    return b;
  };
  const text = (t: string, size = 28, color = "#eef0e6") => {
    const tb = new TextBlock(undefined, t);
    tb.color = color;
    tb.fontSize = size;
    tb.height = `${size + 20}px`;
    tb.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    tb.textWrapping = true;
    return tb;
  };

  const render = () => {
    head.clearControls();
    for (const t of ["basket", "tools", "journal"] as const) head.addControl(button(t[0].toUpperCase() + t.slice(1), 220, () => { tab = t; render(); }));
    head.addControl(button("Close", 160, () => api.toggle(), true));
    body.clearControls();
    const s = session.state;
    if (tab === "basket") {
      body.addControl(text(`Basket ${session.basketLine()}`, 30, "#c8ccbd"));
      if (!s.basket.length) body.addControl(text("Empty. Reach to a plant and squeeze or pinch to harvest."));
      for (const l of s.basket.slice(0, 7)) {
        const row = new StackPanel();
        row.isVertical = false;
        row.height = "76px";
        const plant = PLANTS.find((p) => p.latin === l.latin);
        const known = !!(plant && s.journal[l.latin]?.identified);
        const label = text(`${known ? l.productName : "Unknown " + l.part.toLowerCase()} · ${l.grams} g · ${l.potency}%`, 26);
        label.width = "560px";
        row.addControl(label);
        row.addControl(button("Smell", 150, () => session.smell(l.id)));
        row.addControl(button("Taste", 150, () => session.taste(l.id), true));
        row.addControl(button("Toss", 140, () => session.discard(l.id)));
        body.addControl(row);
      }
      if (s.basket.length > 7) body.addControl(text(`…and ${s.basket.length - 7} more`, 24, "#c8ccbd"));
    } else if (tab === "tools") {
      const row = new StackPanel();
      row.isVertical = false;
      row.height = "90px";
      for (const t of ["hand", "knife", "trowel"] as Tool[]) row.addControl(button((s.tool === t ? "● " : "") + TOOL_NAMES[t], 240, () => session.setTool(t)));
      body.addControl(row);
      body.addControl(button(s.gloves ? "Take gloves off" : "Put gloves on", 400, () => session.toggleGloves()));
      body.addControl(text("Hands: leaves, flowers, fruit, seed. Knife: bark, sap, whole stems (cleaner cuts). Trowel: roots, rhizomes, bulbs.", 24, "#c8ccbd"));
      body.addControl(text("Poison ivy, nettle, wild parsnip sap and thorns hurt bare hands.", 24, "#e8b8a0"));
    } else {
      const entries = Object.values(s.journal);
      const known = entries.filter((e) => e.identified);
      body.addControl(text(`${known.length} identified · ${entries.length - known.length} unknown`, 30, "#c8ccbd"));
      for (const e of known.slice(-8).reverse()) {
        const p = PLANTS.find((x) => x.latin === e.latin)!;
        body.addControl(text(`${p.name} — ${e.timesHarvested} harvest${e.timesHarvested === 1 ? "" : "s"}${e.notes.length ? " · " + e.notes[0] : ""}`, 24));
      }
      body.addControl(text("Full journal pages are in the desktop satchel (Tab).", 22, "#9aa090"));
    }
  };

  const api = {
    open: false,
    toggle() {
      api.open = !api.open;
      session.paused = api.open;
      plane.setEnabled(api.open);
      if (api.open) {
        const cam = scene.activeCamera!;
        const f = cam.getDirection(Vector3.Forward());
        f.y = 0;
        f.normalize();
        plane.position = cam.globalPosition.add(f.scale(0.85)).add(new Vector3(0, -0.15, 0));
        plane.lookAt(cam.globalPosition.add(new Vector3(0, -0.15, 0)));
        plane.rotate(Vector3.Up(), Math.PI); // the plane's front faces away from lookAt
        render();
      }
    },
  };
  session.subscribe(() => { if (api.open) render(); });
  return api;
}
