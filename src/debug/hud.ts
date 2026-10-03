/**
 * Desktop HUD: where you are, the date, what you're looking at and why it
 * grows there, and the frame budget. Hidden in VR (a wrist readout comes with
 * the Field Journal in M5).
 */
import { Engine, Ray, Scene, SceneInstrumentation, Vector3, type AbstractMesh, type Camera } from "@babylonjs/core";
import { ZONES, zoneAt } from "../world/map";
import { formatDoy } from "../sim/phenology";
import { describeNode, type HabitatLayers } from "../sim/habitat";
import { nodeAt } from "../sim/grid";
import { explain, limitingFactor } from "../sim/suitability";
import { PLANTS, type Plant } from "../data/plants";
import type { HerbRenderer } from "../veg/herbs";
import type { WoodyRenderer } from "../veg/woody";

export interface HudContext {
  scene: Scene;
  engine: Engine;
  ground: AbstractMesh;
  getCam: () => Camera | null;
  getDay: () => number;
  getOverlay: () => string;
  habitat?: HabitatLayers;
  herbs?: HerbRenderer;
  woody?: WoodyRenderer;
}

const STAGE_WORDS: Record<string, string> = {
  winter: "dormant", emerging: "just emerging", vegetative: "in leaf", flowering: "in bloom",
  fruiting: "setting seed", senescent: "dying back",
};
const pct = (v: number) => `${Math.round(v * 100)}`;

export function createHud(ctx: HudContext) {
  const el = document.getElementById("hud")!;
  const instr = new SceneInstrumentation(ctx.scene);
  instr.captureFrameTime = true;
  let last = 0;
  let lookedAt: Plant | null = null;

  ctx.scene.onAfterRenderObservable.add(() => {
    const now = performance.now();
    if (now - last < 200) return;
    last = now;
    const cam = ctx.getCam();
    if (!cam) return;
    const p = cam.globalPosition;
    const zone = ZONES[zoneAt(p.x, p.z)];
    const lines: string[] = [];
    lines.push(`<b>${zone.name}</b> · ${formatDoy(ctx.getDay())}`);

    // What's under the crosshair?
    lookedAt = null;
    if (ctx.habitat && ctx.herbs) {
      const dir = cam.getDirection(Vector3.Forward());
      const hit = ctx.scene.pickWithRay(new Ray(p, dir, 25), (m) => m === ctx.ground);
      if (hit?.pickedPoint) {
        const gp = hit.pickedPoint;
        const near = ctx.herbs.nearest(gp.x, gp.z, 0.6);
        const tree = ctx.woody?.nearest(gp.x, gp.z, 2.5);
        let label = "";
        if (near && (!tree || near.distance < tree.distance)) {
          const a = ctx.herbs.appearanceOf(near.index);
          const plant = PLANTS[ctx.herbs.plantIndexOf(near.index)];
          lookedAt = plant;
          label = `${plant.name} <i>${plant.latin}</i> — ${STAGE_WORDS[a.stage] ?? a.stage}`;
        } else if (tree) {
          lookedAt = tree.plant;
          label = `${tree.plant.name} <i>${tree.plant.latin}</i>`;
        }
        if (lookedAt) {
          const n = nodeAt(gp.x, gp.z);
          const f = n >= 0 ? explain(lookedAt, ctx.habitat, n) : null;
          lines.push(`▸ ${label}`);
          if (f) lines.push(`<span class="dim">habitat fit ${pct(f.total)}% · limited by: ${limitingFactor(f)}</span>`);
          lines.push(`<span class="dim">${lookedAt.notes}</span>`);
        }
      }
      const n = nodeAt(p.x, p.z);
      if (n >= 0) {
        const d = describeNode(ctx.habitat, n);
        lines.push(`<span class="dim">light ${pct(d.light)} · moist ${pct(d.moisture)} · disturb ${pct(d.disturbance)} · fert ${pct(d.fertility)} · ${d.mow}${d.plowed ? "" : " · never plowed"}</span>`);
      }
    }
    const tris = Math.round(ctx.scene.getActiveIndices() / 3 / 1000);
    lines.push(
      `<span class="dim">${ctx.engine.getFps().toFixed(0)} fps · ${instr.drawCallsCounter.current} draws · ${tris}k tris` +
        (ctx.herbs ? ` · ${ctx.herbs.visibleCount} plants` : "") +
        ` · overlay: ${ctx.getOverlay()}</span>`,
    );
    el.innerHTML = lines.join("<br>");
  });
  return { lookedAt: () => lookedAt };
}
