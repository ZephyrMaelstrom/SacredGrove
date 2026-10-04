/**
 * Desktop foraging controls.
 *
 *   look at a plant      → its name once identified; a steady look identifies it
 *   hold left mouse      → harvest with the tool in hand (within arm's reach)
 *   1 / 2 / 3            → hands / knife / trowel
 *   G                    → gloves on/off
 *   E                    → use the door (sleep) or barn (unload) when close
 *   Tab or J             → the satchel: basket, journal, barn, how you feel
 */
import { Vector3, type Scene } from "@babylonjs/core";
import { groundHit } from "../world/map";
import type { Session, Interactable } from "../game/session";
import type { Target } from "../game/forage";

export const REACH = 3.0;
const LOOK = 4.5;

export interface DesktopState {
  target: Target | null;
  targetDistance: number;
  harvestProgress: number;
  examineProgress: number;
  interactable: Interactable | null;
}

export function setupDesktop(
  scene: Scene,
  canvas: HTMLCanvasElement,
  session: Session,
  opts: { isFlying: () => boolean; toggleSatchel: () => void; satchelOpen: () => boolean },
) {
  let mouseDown = false;
  const st: DesktopState = { target: null, targetDistance: Infinity, harvestProgress: 0, examineProgress: 0, interactable: null };

  canvas.addEventListener("pointerdown", (e) => {
    if (e.button === 0 && document.pointerLockElement === canvas) mouseDown = true;
  });
  window.addEventListener("pointerup", (e) => {
    if (e.button === 0) {
      mouseDown = false;
      session.release("desktop");
    }
  });
  window.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (e.key === "Tab" || e.key === "j" || e.key === "J") {
      e.preventDefault();
      opts.toggleSatchel();
      return;
    }
    if (opts.satchelOpen()) return;
    switch (e.key) {
      case "1": session.setTool("hand"); break;
      case "2": session.setTool("knife"); break;
      case "3": session.setTool("trowel"); break;
      case "g": case "G": session.toggleGloves(); break;
      case "e": case "E":
        if (!opts.isFlying() && st.interactable) session.interact(st.interactable);
        break;
    }
  });

  return {
    state: st,
    update(dt: number) {
      const cam = scene.activeCamera;
      if (!cam || opts.satchelOpen()) {
        st.target = null;
        st.harvestProgress = 0;
        return st;
      }
      const p = cam.globalPosition;
      st.interactable = session.nearbyInteractable(p.x, p.z);
      const dir = cam.getDirection(Vector3.Forward());
      const gp = groundHit(p.x, p.y, p.z, dir.x, dir.y, dir.z, LOOK + 2);
      st.target = null;
      st.targetDistance = Infinity;
      if (gp) {
        const t = session.targetAt(gp.x, gp.z);
        if (t) {
          const d = Vector3.Distance(p, new Vector3(t.x, gp.y, t.z));
          if (d <= LOOK) {
            st.target = t;
            st.targetDistance = d;
          }
        }
      }
      st.examineProgress = session.look(st.target, dt);
      if (mouseDown && st.target && st.targetDistance <= REACH) st.harvestProgress = session.hold("desktop", st.target);
      else {
        st.harvestProgress = 0;
        if (!mouseDown) session.release("desktop");
      }
      return st;
    },
  };
}
