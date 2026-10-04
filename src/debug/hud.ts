/**
 * Desktop HUD.
 *
 * Game view: place, date and time, weather and temperature, tool, gloves,
 * basket, how you feel, and what you're looking at (named only once
 * identified), with harvest and examine progress around the crosshair.
 *
 * Dev view (` key or ?dev): real names for everything, habitat values
 * underfoot, why a plant grows where it does, and the frame budget.
 */
import { SceneInstrumentation, type Engine, type Scene } from "@babylonjs/core";
import { ZONES, zoneAt } from "../world/map";
import { formatDoy } from "../sim/phenology";
import { describeNode, type HabitatLayers } from "../sim/habitat";
import { nodeAt } from "../sim/grid";
import { explain, limitingFactor } from "../sim/suitability";
import { describe, temperatureAt } from "../time/climate";
import { formatTime, seasonName } from "../time/clock";
import { TOOL_NAMES } from "../game/harvest";
import type { Session } from "../game/session";
import type { DesktopState } from "../interact/desktop";
import type { HerbRenderer } from "../veg/herbs";

const STAGE_WORDS: Record<string, string> = {
  winter: "dormant", emerging: "just emerging", vegetative: "in leaf", flowering: "in bloom",
  fruiting: "setting seed", senescent: "dying back",
};
const pct = (v: number) => `${Math.round(v * 100)}`;

export interface HudContext {
  scene: Scene;
  engine: Engine;
  session: Session;
  habitat: HabitatLayers;
  herbs: HerbRenderer;
  desktop: () => DesktopState;
  overlayLabel: () => string;
}

export function createHud(ctx: HudContext) {
  const el = document.getElementById("hud")!;
  const cross = document.getElementById("crosshair")!;
  const instr = new SceneInstrumentation(ctx.scene);
  let dev = new URLSearchParams(location.search).has("dev");
  let last = 0;
  window.addEventListener("keydown", (e) => { if (e.key === "`") dev = !dev; });

  ctx.scene.onAfterRenderObservable.add(() => {
    const d = ctx.desktop();
    // Progress ring around the crosshair every frame.
    const prog = d.harvestProgress > 0 ? d.harvestProgress : d.examineProgress;
    const colour = d.harvestProgress > 0 ? "#f0d36a" : "#9fd3ff";
    cross.style.background = prog > 0
      ? `conic-gradient(${colour} ${prog * 360}deg, rgba(255,255,255,.25) 0deg)`
      : d.target ? "rgba(255,255,255,.95)" : "rgba(255,255,255,.6)";
    cross.classList.toggle("ring", prog > 0);

    const now = performance.now();
    if (now - last < 150) return;
    last = now;
    const cam = ctx.scene.activeCamera;
    if (!cam) return;
    const s = ctx.session, st = s.state, w = s.weather;
    const p = cam.globalPosition;
    const zone = ZONES[zoneAt(p.x, p.z)];
    const lines: string[] = [];
    const temp = Math.round(temperatureAt(w, st.clock.minutes));
    lines.push(`<b>${formatTime(st.clock.minutes)}</b> · ${formatDoy(st.clock.doy)}, ${seasonName(st.clock.doy)} · Year ${st.clock.year}${s.timelapse ? " · ⏩ time-lapse" : ""}`);
    lines.push(`${describe(w, st.clock.minutes)} · ${temp} °F · ${zone.name}`);
    lines.push(`<span class="dim">${TOOL_NAMES[st.tool]}${st.gloves ? " · gloves" : ""} · basket ${s.basketLine()}</span>`);
    const statuses = st.statuses.filter((x) => x.until > s.nowAbsMinute).map((x) => x.label);
    if (statuses.length) lines.push(`<span class="warnText">${statuses.join(" · ")}</span>`);

    if (d.interactable) lines.push(`<span class="hint">E · ${d.interactable.label}</span>`);
    if (d.target) {
      const t = d.target;
      const a = s.lookOf(t);
      const known = dev || s.isIdentified(t.plant);
      const name = known ? `${t.plant.name} <i>${t.plant.latin}</i>` : s.displayName(t);
      lines.push(`▸ ${name} — ${STAGE_WORDS[a.stage] ?? a.stage}`);
      if (!known && d.examineProgress > 0) lines.push(`<span class="dim">looking closer…</span>`);
      const action = s.preview(t);
      if (d.targetDistance > 3) lines.push(`<span class="dim">step closer to harvest</span>`);
      else if (action) lines.push(`<span class="hint">hold click · ${action}</span>`);
      if (dev) {
        const n = nodeAt(t.x, t.z);
        if (n >= 0) {
          const f = explain(t.plant, ctx.habitat, n);
          lines.push(`<span class="dim">habitat fit ${pct(f.total)}% · limited by: ${limitingFactor(f)}</span>`);
        }
      }
    }
    if (dev) {
      const n = nodeAt(p.x, p.z);
      if (n >= 0) {
        const h = describeNode(ctx.habitat, n);
        lines.push(`<span class="dim">light ${pct(h.light)} · moist ${pct(h.moisture)} · disturb ${pct(h.disturbance)} · fert ${pct(h.fertility)} · ${h.mow}${h.plowed ? "" : " · never plowed"}</span>`);
      }
      const tris = Math.round(ctx.scene.getActiveIndices() / 3 / 1000);
      lines.push(`<span class="dim">${ctx.engine.getFps().toFixed(0)} fps · ${instr.drawCallsCounter.current} draws · ${tris}k tris · ${ctx.herbs.visibleCount} plants · overlay: ${ctx.overlayLabel()}</span>`);
    }
    el.innerHTML = lines.join("<br>");
  });
}
