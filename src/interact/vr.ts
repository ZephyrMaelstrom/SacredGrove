/**
 * VR foraging controls (Quest, hands or controllers).
 *
 *   Left stick walks, right stick turns (see xr/locomotion.ts)
 *   Reach down to a plant and squeeze the grip (controllers) or pinch
 *   (hands) and hold          → harvest with the tool in your right hand
 *   Look steadily at a plant  → identify it
 *   Right B / thumbstick click → next tool        Left Y → gloves on/off
 *   Left X (or Menu)           → open/close the satchel panel
 *   Right A, or pinch at a station → use it (bed, bench, racks, cellar,
 *                                       seed catalog, stand…); its panel floats
 *                                       in front of you
 *   At the bench, with a herb in the mortar: squeeze/pinch inside the mortar
 *   and stir in circles to grind it
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
import { AdvancedDynamicTexture, Control, Rectangle, TextBlock } from "@babylonjs/gui";
import type { Session } from "../game/session";
import { VrPanel } from "./vrPanel";
import type { setupLocomotion } from "../xr/locomotion";
import { cycle, MOVE_SPEEDS, SNAP_ANGLES, TURN_SPEEDS } from "../xr/comfort";
import { layout } from "../world/layout";
import { roomAt } from "../world/walk";
import { isPrep, isStock } from "../game/items";
import { itemName, prepSummary } from "../game/homestead";
import { effectWord, type PanelView } from "../game/stations";
import { nextGoal } from "../game/goals";
import type { Target } from "../game/forage";
import { TOOL_NAMES, type Tool } from "../game/harvest";
import { describe, temperatureAt } from "../time/climate";
import { formatTime } from "../time/clock";
import { formatDoy } from "../sim/phenology";
import { heightAt, groundHit } from "../world/map";
import { PLANTS } from "../data/plants";
import { herbCondition } from "../game/storage";
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
  const paper = new StandardMaterial("envelopePaper", scene);
  paper.diffuseColor = new Color3(0.86, 0.8, 0.64);
  const env = MeshBuilder.CreateBox("env", { width: 0.09, height: 0.005, depth: 0.12 }, scene);
  env.position.z = -0.06;
  env.material = paper;
  return { knife: make("knifeTool", [kHandle, kBlade]), trowel: make("trowelTool", [tHandle, tScoop]), envelope: make("envelopeTool", [env]) };
}

export function setupVrForaging(scene: Scene, xr: WebXRDefaultExperience, session: Session, herbs: HerbRenderer, toasts: Toasts, loco?: Loco) {
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
        // (The right stick turns you now; tools cycle on B.)
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

  /** Feet height: the headset's height above the floor it stands on. */
  const feetY = () => {
    const c = xr.baseExperience.camera;
    return c.globalPosition.y - (c.realWorldHeight || 1.6);
  };
  const tryInteract = (handPos: Vector3 | null) => {
    const cam = scene.activeCamera;
    if (!cam) return false;
    const p = cam.globalPosition;
    const it = session.nearbyInteractable(p.x, p.z, feetY());
    if (!it) return false;
    // A pinch must be made near the thing itself, not anywhere in the room.
    if (handPos && Math.hypot(handPos.x - it.x, handPos.z - it.z) > it.radius + 0.3) return false;
    session.interact(it);
    return true;
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

  // ---------------------------------------------------------- panels
  const satchel = createVrSatchel(scene, session, loco);
  const stationPanel = new VrPanel(scene, "vrStation", (act) => session.stationAct(act), 1.05);
  const syncStation = () => {
    const inXR = xr.baseExperience.state === WebXRState.IN_XR;
    stationPanel.show(inXR ? session.panelView() : null);
  };
  session.subscribe(syncStation);
  // Grinding: stir inside the mortar with a squeezed hand.
  const mortarAt = new Vector3(layout().anchors.mortar.x, layout().anchors.mortar.y + 0.06, layout().anchors.mortar.z);
  const lastStir: Record<Side, Vector3 | null> = { left: null, right: null };
  let stirred = 0;

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
    session.room = roomAt(cp.x, cp.z, feetY());
    // Walk away from a station and its panel closes.
    if (session.panel && !session.panelInReach(cp.x, cp.z, feetY())) session.openPanel(null);

    for (const h of Object.values(hands)) {
      const pos = handPosition(h);
      h.wasPressed = h.pressed;
      h.pressed = !!pos && isPressed(h);
      // Stirring the mortar.
      if (pos && h.pressed && session.panel === "bench" && session.draft.mortar && Vector3.Distance(pos, mortarAt) < 0.16) {
        const last = lastStir[h.side];
        if (last) stirred += Vector3.Distance(pos, last);
        lastStir[h.side] = pos.clone();
        if (stirred >= 0.12) {
          stirred = 0;
          session.stationAct("grind:1");
          pulse(h, 0.25, 25);
        }
        h.progress = 0;
        continue;
      }
      lastStir[h.side] = null;
      if (!pos || satchel.open || stationPanel.open) { session.release(h.side); h.progress = 0; continue; }
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
      session.moneyLine(),
    ];
    const statuses = s.statuses.filter((x) => x.until > session.nowAbsMinute).map((x) => x.label);
    if (statuses.length) lines.push(statuses.join(" · "));
    const prog = Math.max(hands.left.progress, hands.right.progress);
    if (prog > 0) lines.push(`Harvesting ${"▮".repeat(Math.ceil(prog * 8))}${"▯".repeat(8 - Math.ceil(prog * 8))}`);
    else if (gazeTarget) lines.push(`${session.displayName(gazeTarget)}${gazeProgress > 0 ? " — looking closer…" : ""}`);
    const near = session.nearbyInteractable(cam.globalPosition.x, cam.globalPosition.z, feetY());
    if (near && !stationPanel.open) lines.push(`A / pinch at it: ${near.label}`);
    if (session.panel === "bench" && session.draft.mortar) lines.push("Squeeze in the mortar and stir to grind");
    const goal = nextGoal(s);
    if (goal && !lastToast) lines.push(`Note: ${goal.title}`);
    if (toasts.last && toasts.last !== lastToast) lastToast = toasts.last;
    if (lastToast) lines.push(lastToast);
    wristText.text = lines.join("\n");
  });

  return { hands, showJournal: () => satchel.showJournal(), satchelOpen: () => satchel.open };
}

// ------------------------------------------------------------ VR satchel

type SatchelTab = "basket" | "tools" | "journal";
type Loco = ReturnType<typeof setupLocomotion>;

function satchelView(session: Session, tab: SatchelTab, loco?: Loco): PanelView {
  const s = session.state;
  const tabs = { rows: [], buttons: (["basket", "tools", "journal"] as SatchelTab[]).map((t) => ({ label: t[0].toUpperCase() + t.slice(1), act: `tab:${t}`, on: t === tab })) };
  if (tab === "basket") {
    return {
      title: "Satchel", subtitle: `Basket ${session.basketLine()} · ${session.moneyLine()}`,
      sections: [tabs, {
        note: s.basket.length ? undefined : "Empty. Reach to a plant and squeeze or pinch to harvest.",
        rows: s.basket.map((it) => ({
          text: isPrep(it) ? `${it.name} · ${it.volumeMl} ml` : isStock(it) ? `${itemName(s, it)}${it.form === "seed" ? ` · ${it.count}` : ""}` : `${itemName(s, it)} · ${it.grams} g`,
          sub: isPrep(it) ? prepSummary(it) : isStock(it) ? (it.form === "seed" ? "seed packet" : "division") : `${it.part} · ${herbCondition(it)}`,
          bar: isPrep(it) ? undefined : isStock(it) ? Math.round(it.viability) : Math.round(it.potency),
          buttons: [
            ...(isPrep(it) ? [] : [{ label: "Smell", act: `smell:${it.id}` }]),
            { label: "Taste", act: `taste:${it.id}`, warn: true },
            { label: "Toss", act: `toss:${it.id}` },
          ],
        })),
      }],
    };
  }
  if (tab === "tools") {
    return {
      title: "Satchel",
      sections: [tabs, {
        note: "Hands: leaves, flowers, fruit. Knife: bark, sap, whole stems. Trowel: roots, or a living division of perennials. Seed envelope: ripe seed for the garden. Poison ivy, nettle, wild parsnip sap and thorns hurt bare hands.",
        rows: [
          { text: "Tool", buttons: (["hand", "knife", "trowel", "envelope"] as Tool[]).map((t) => ({ label: TOOL_NAMES[t], act: `tool:${t}`, on: s.tool === t })) },
          { text: s.gloves ? "Wearing gloves" : "Bare-handed", buttons: [{ label: s.gloves ? "Gloves off" : "Gloves on", act: "gloves" }] },
        ],
      }, ...(loco ? [{
        title: "Movement",
        note: "Left stick walks (click it to hurry), right stick turns.",
        rows: [
          { text: `Turning: ${loco.comfort.turn}`, buttons: [{ label: "Smooth", act: "comfort:turn:smooth", on: loco.comfort.turn === "smooth" }, { label: "Snap", act: "comfort:turn:snap", on: loco.comfort.turn === "snap" }] },
          loco.comfort.turn === "smooth"
            ? { text: `Turn speed: ${loco.comfort.turnSpeed}°/s`, buttons: [{ label: "Change", act: "comfort:turnSpeed" }] }
            : { text: `Snap angle: ${loco.comfort.snapAngle}°`, buttons: [{ label: "Change", act: "comfort:snapAngle" }] },
          { text: `Walking speed: ${loco.comfort.moveSpeed} m/s`, buttons: [{ label: "Change", act: "comfort:moveSpeed" }] },
          { text: `Walk toward: ${loco.comfort.direction === "head" ? "where you look" : "where the left controller points"}`, buttons: [{ label: "Head", act: "comfort:direction:head", on: loco.comfort.direction === "head" }, { label: "Hand", act: "comfort:direction:hand", on: loco.comfort.direction === "hand" }] },
          { text: `Comfort vignette: ${loco.comfort.vignette ? "on" : "off"}`, buttons: [{ label: loco.comfort.vignette ? "Turn off" : "Turn on", act: "comfort:vignette" }] },
        ],
      }] : [])],
    };
  }
  const known = Object.values(s.journal).filter((e) => e.identified);
  return {
    title: "Field Journal", subtitle: `${known.length} identified · ${Object.keys(s.protocols).length} recipes`,
    sections: [tabs, {
      rows: known.slice().reverse().map((e) => {
        const p = PLANTS.find((x) => x.latin === e.latin)!;
        const does = Object.values(e.effects ?? {}).flat();
        return {
          text: `${p.name} — ${e.timesHarvested} harvest${e.timesHarvested === 1 ? "" : "s"}`,
          sub: [does.length ? `does: ${[...new Set(does)].map(effectWord).join(", ")}` : "", e.notes[0] ?? ""].filter(Boolean).join(" · ") || p.latin,
        };
      }),
    }],
  };
}

function createVrSatchel(scene: Scene, session: Session, loco?: Loco) {
  let tab: SatchelTab = "basket";
  const panel = new VrPanel(scene, "vrSatchel", (act) => {
    const [verb, a] = act.split(":");
    if (verb === "close") return api.toggle();
    if (verb === "tab") tab = a as SatchelTab;
    if (verb === "smell") session.smell(a);
    if (verb === "taste") session.taste(a);
    if (verb === "toss") session.discard(a);
    if (verb === "tool") session.setTool(a as Tool);
    if (verb === "gloves") session.toggleGloves();
    if (verb === "comfort" && loco) {
      const [, key, val] = act.split(":");
      const c = loco.comfort;
      if (key === "turn") loco.set("turn", val as "smooth" | "snap");
      if (key === "direction") loco.set("direction", val as "head" | "hand");
      if (key === "turnSpeed") loco.set("turnSpeed", cycle(TURN_SPEEDS, c.turnSpeed));
      if (key === "snapAngle") loco.set("snapAngle", cycle(SNAP_ANGLES, c.snapAngle));
      if (key === "moveSpeed") loco.set("moveSpeed", cycle(MOVE_SPEEDS, c.moveSpeed));
      if (key === "vignette") loco.set("vignette", !c.vignette);
    }
    render();
  }, 0.95);
  const render = () => panel.show(api.open ? satchelView(session, tab, loco) : null);
  const api = {
    get open() { return panel.open; },
    toggle() {
      const opening = !panel.open;
      session.paused = opening;
      if (opening) panel.show(satchelView(session, tab, loco));
      else panel.show(null);
    },
    showJournal() {
      tab = "journal";
      if (!panel.open) api.toggle();
      else render();
    },
  };
  session.subscribe(() => { if (panel.open) render(); });
  return api;
}
