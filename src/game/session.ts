/**
 * The running game: owns the save, drives the clock, weather and seasons
 * into the world, and turns "the player's hand (or crosshair) is here and the
 * button is held" into foraging.
 *
 * Desktop and VR controls both talk to this class; it doesn't know which one
 * is calling.
 */
import { Vector3 } from "@babylonjs/core";
import { nodeAt } from "../sim/grid";
import { PLANTS, type Plant } from "../data/plants";
import type { HabitatLayers } from "../sim/habitat";
import { ZONE_ORDER } from "../sim/habitat";
import type { Population } from "../sim/placement";
import { WORLD_SEED } from "../sim/placement";
import { suitability } from "../sim/suitability";
import { appearance, type Appearance } from "../sim/phenology";
import { weatherOn, weatherForYear, snowDepths, snowCover, type DayWeather } from "../time/climate";
import { seasonFromWeather, type SeasonAdjust } from "../time/season";
import { SECONDS_PER_GAME_MINUTE, absDay, formatTime } from "../time/clock";
import { money } from "./market";
import { ZONES, SITE } from "../world/map";
import type { Terrain } from "../world/terrain";
import type { Sky } from "../world/sky";
import type { HerbRenderer } from "../veg/herbs";
import type { WoodyRenderer } from "../veg/woody";
import { HarvestState, patchKey, type Layer } from "./harvestState";
import { harvest, examine, notice, type Target } from "./forage";
import { smell, taste, discard, catchUp, finishJobs, type Result as ActionResult } from "./homestead";
import { actStation, isPanelStation, newDraft, viewStation, type BenchDraft, type PanelView } from "./stations";
import { layout, ROOM_NAMES, type RoomId, type Station, type StationId } from "../world/layout";
import { DAYS_IN_YEAR } from "../sim/phenology";
import { TOOLS, TOOL_NAMES, choose, type Tool } from "./harvest";
import { basketWeight, BASKET_CAPACITY_G } from "./basket";
import {
  DATA_HASH, restore, loadFromStorage, saveToStorage, tick, goToSleep, absMinute,
  type GameStateData,
} from "./state";
import type { Fader } from "../ui/fader";
import type { Toasts } from "../ui/toast";

/** Seconds each tool takes. Digging is work. */
const HARVEST_SECONDS: Record<Tool, number> = { hand: 0.45, knife: 0.9, trowel: 1.6 };
const EXAMINE_SECONDS = 1.6;

export type Interactable = Station;

/**
 * Bump when buildings change footprints (plants are placed around them), so
 * old saves' picked-plant records, which point at individual plants, reset.
 */
export const LAYOUT_VERSION = 6;

interface HarvestHold {
  source: string;
  key: string;
  target: Target;
  t: number;
  duration: number;
}

const FORM_WORDS: Record<string, string> = {
  rosette: "rosette", mat: "low creeper", forb: "forb", tallForb: "tall forb", grass: "grass", sedge: "sedge",
  bulb: "bulb plant", vine: "vine", cane: "bramble", horsetail: "horsetail", fungus: "mushroom",
  fungusBracket: "bracket fungus", shrub: "shrub", tree: "tree",
};

export class Session {
  state: GameStateData;
  harvestState!: HarvestState;
  weather!: DayWeather;
  season!: SeasonAdjust;
  /** Snow on the ground this morning (cm). */
  snowCm = 0;
  timeScale = 1;
  paused = false;
  timelapse = false;
  private holds = new Map<string, HarvestHold>();
  /** Things that happened overnight, shown in the morning. */
  private pendingNotes: string[] = [];
  /** Where the player is standing (set by the controls each frame). */
  room: RoomId | null = null;
  /** The station panel that's open, if any. */
  panel: StationId | null = null;
  draft: BenchDraft = newDraft();
  /** Open the satchel (desk → journal). Set by the UI. */
  openJournal: () => void = () => {};
  private examining: { key: string; t: number } | null = null;
  private lastPanelTick = -1;
  private busy = false;
  /** Called when the player must be moved (waking up at home). */
  movePlayer: (to: Vector3, faceTo: Vector3) => void = () => {};
  private listeners: (() => void)[] = [];
  /** Run `fn` after anything changes the save (UI refresh). */
  subscribe(fn: () => void) {
    this.listeners.push(fn);
  }
  private emit() {
    for (const fn of this.listeners) fn();
  }

  constructor(
    private sky: Sky,
    private terrain: Terrain,
    private herbs: HerbRenderer,
    private woody: WoodyRenderer,
    private habitat: HabitatLayers,
    private population: Population,
    private fader: Fader,
    private toasts: Toasts,
    options: { fresh?: boolean } = {},
  ) {
    const world = { hash: (DATA_HASH ^ WORLD_SEED ^ (LAYOUT_VERSION * 0x9e3779b1)) >>> 0, herbs: population.herbs.count, woody: woody.count };
    const loaded = restore(options.fresh ? null : loadFromStorage(), world);
    this.state = loaded.state;
    if (loaded.note) setTimeout(() => toasts.show(loaded.note!), 1500);
    this.bindHarvestState();
    this.refreshDay();
  }

  // ------------------------------------------------------------ setup

  private bindHarvestState() {
    // How many of each species stand in each 8 m patch (for overharvest checks).
    const totals = new Map<string, number>();
    const h = this.population.herbs;
    for (let k = 0; k < h.count; k++) {
      const pk = patchKey(PLANTS[h.plant[k]].latin, h.x[k], h.z[k]);
      totals.set(pk, (totals.get(pk) ?? 0) + 1);
    }
    this.harvestState = new HarvestState(this.state.harvest, (pk) => totals.get(pk) ?? 0);
    this.updateVisibilityHook();
  }

  private updateVisibilityHook() {
    const d = this.state.harvest;
    if (!Object.keys(d.individuals).length && !Object.keys(d.patches).length) {
      this.herbs.visibility = null;
      return;
    }
    const h = this.population.herbs;
    const year = this.state.clock.year, day = absDay(this.state.clock);
    this.herbs.visibility = (k) => this.harvestState.visibility("h", k, PLANTS[h.plant[k]].latin, h.x[k], h.z[k], year, day);
  }

  /** New date: weather, season, plant looks, visibility; the homestead catches up (drying, sales, orders). */
  refreshDay() {
    const c = this.state.clock;
    const notes = catchUp(this.state, (d) => {
      const year = Math.floor((d - 1) / DAYS_IN_YEAR) + 1, doy = ((d - 1) % DAYS_IN_YEAR) + 1;
      return { w: weatherOn(year, doy, WORLD_SEED), doy };
    });
    this.pendingNotes.push(...notes);
    this.weather = weatherOn(c.year, c.doy, WORLD_SEED);
    this.season = seasonFromWeather(weatherForYear(c.year, WORLD_SEED));
    this.snowCm = snowDepths(c.year, WORLD_SEED)[c.doy - 1];
    this.herbs.setDay(c.doy, this.season);
    this.woody.setDay(c.doy, this.season);
    this.herbs.setSnow(snowCover(this.snowCm));
    this.terrain.setVegetationTint(this.herbs.groundTint(), 0.3);
    this.terrain.setSnow(snowCover(this.snowCm));
    this.updateVisibilityHook();
    this.herbs.invalidate();
    this.emit();
  }

  // ------------------------------------------------------------ frame

  update(dt: number, cameraPos: Vector3) {
    if (!this.paused && !this.busy) {
      const minutes = this.timelapse ? dt * 1440 : (dt / SECONDS_PER_GAME_MINUTE) * this.timeScale;
      const ev = tick(this.state, minutes);
      if (ev.newYear) this.harvestState.rollover(this.state.clock.year);
      if (ev.newDay) this.refreshDay();
      if (ev.passedOut && !this.timelapse) void this.passOut();
      const done = finishJobs(this.state);
      for (const r of done) this.toasts.show(r.message, r.detail);
      if (done.length) this.emit();
      // Panels with timers (brewing) refresh a couple of times a game hour.
      if (this.panel === "bench" && this.state.jobs.length && Math.floor(this.state.clock.minutes) % 5 === 0 && this.lastPanelTick !== Math.floor(this.state.clock.minutes)) {
        this.lastPanelTick = Math.floor(this.state.clock.minutes);
        this.emit();
      }
    }
    this.sky.update({ doy: this.state.clock.doy, minutes: this.state.clock.minutes, weather: this.weather, indoors: this.room !== null }, cameraPos, dt);
    for (const hold of this.holds.values()) hold.t += dt;
  }

  // ------------------------------------------------------------ targets

  /** The plant at a ground point (herbs first, then woody within reach). */
  targetAt(x: number, z: number, herbReach = 0.6, woodyReach = 1.4): Target | null {
    const herb = this.herbs.nearest(x, z, herbReach);
    const tree = this.woody.nearest(x, z, woodyReach);
    if (herb && (!tree || herb.distance < tree.distance + 0.3)) {
      const ind = this.herbs.individual(herb.index);
      return this.makeTarget("h", herb.index, PLANTS[ind.plant], ind.cohort, ind.x, ind.z, ind.scale, ind.node);
    }
    if (tree) {
      const w = this.woody.individual(tree.index);
      const n = this.nodeAt(w.x, w.z);
      return this.makeTarget("w", tree.index, tree.plant, 1, w.x, w.z, w.scale, n);
    }
    return null;
  }

  private nodeAt(x: number, z: number) {
    // Tree-line trees stand just past the habitat grid: clamp to its edge.
    return Math.max(0, nodeAt(Math.max(-80, Math.min(80, x)), Math.max(0, Math.min(400, z))));
  }

  private makeTarget(layer: Layer, index: number, plant: Plant, cohort: number, x: number, z: number, scale: number, node: number): Target {
    const zone = ZONES[ZONE_ORDER[this.habitat.zone[node]] ?? "yard"]?.name ?? "the homestead";
    return { layer, index, plant, cohort, x, z, scale, zone, suitability: suitability(plant, this.habitat, node) };
  }

  lookOf(t: Target): Appearance {
    if (t.layer === "h") return this.herbs.appearanceOf(t.index);
    return appearance(t.plant, this.state.clock.doy, 1, this.season);
  }

  /** How the player sees this plant: real name only once identified. */
  displayName(t: Target): string {
    const e = this.state.journal[t.plant.latin];
    return e?.identified ? t.plant.name : `Unknown ${FORM_WORDS[t.plant.form] ?? "plant"}`;
  }
  isIdentified(p: Plant) {
    return !!this.state.journal[p.latin]?.identified;
  }

  /** Words for what the current tool would take, for the HUD. */
  preview(t: Target): string {
    const pick = choose(this.state.tool, { plant: t.plant, look: this.lookOf(t), doy: this.state.clock.doy, season: this.season, cohort: t.cohort });
    if (!pick.ok) return "";
    return this.isIdentified(t.plant) ? `${TOOL_NAMES[this.state.tool]}: take ${pick.product.name}` : `${TOOL_NAMES[this.state.tool]}: take a ${pick.product.part.toLowerCase()} sample`;
  }

  // ------------------------------------------------------------ examine

  /** Call every frame with whatever the player is looking at; identifies after a steady look. */
  look(t: Target | null, dt: number): number {
    if (!t) { this.examining = null; return 0; }
    const key = `${t.layer}${t.index}`;
    if (this.isIdentified(t.plant)) { this.examining = null; return 0; }
    if (this.examining?.key !== key) {
      this.examining = { key, t: 0 };
      notice(this.state, t);
    }
    this.examining.t += dt;
    if (this.examining.t >= EXAMINE_SECONDS) {
      const r = examine(this.state, t);
      if (r.ok) this.toasts.show(r.message, r.detail);
      this.examining = null;
      this.emit();
      return 1;
    }
    return this.examining.t / EXAMINE_SECONDS;
  }

  // ------------------------------------------------------------ harvest

  /**
   * Hold-to-harvest. Call every frame while the button is held, with the
   * current target (or null). Returns progress 0–1. Releasing = call `release`.
   */
  hold(source: string, t: Target | null): number {
    if (!t || this.busy) { this.holds.delete(source); return 0; }
    const key = `${t.layer}${t.index}`;
    let h = this.holds.get(source);
    if (!h || h.key !== key) {
      h = { source, key, target: t, t: 0, duration: HARVEST_SECONDS[this.state.tool] };
      this.holds.set(source, h);
    }
    if (h.t >= h.duration) {
      this.holds.delete(source);
      this.doHarvest(t);
      // Require a fresh press for the next plant.
      this.holds.set(source, { ...h, t: -Infinity });
      return 1;
    }
    return Math.max(0, h.t / h.duration);
  }
  release(source: string) {
    this.holds.delete(source);
  }

  private doHarvest(t: Target) {
    const r = harvest(this.state, this.harvestState, t, { look: this.lookOf(t), season: this.season, weather: this.weather });
    this.toasts.show(r.message, r.detail);
    if (r.changed) {
      this.updateVisibilityHook();
      this.herbs.invalidate();
    }
    this.emit();
  }

  // ------------------------------------------------------------ tools & basket

  setTool(tool: Tool) {
    this.state.tool = tool;
    this.toasts.show(`${TOOL_NAMES[tool]} in hand`);
    this.emit();
  }
  cycleTool(dir = 1) {
    const i = TOOLS.indexOf(this.state.tool);
    this.setTool(TOOLS[(i + dir + TOOLS.length) % TOOLS.length]);
  }
  toggleGloves() {
    this.state.gloves = !this.state.gloves;
    this.toasts.show(this.state.gloves ? "Gloves on" : "Gloves off");
    this.emit();
  }

  smell(lotId: string) { this.report(smell(this.state, lotId)); }
  taste(lotId: string) {
    const r = taste(this.state, lotId);
    this.report(r);
    if (r.collapse) void this.wakeAtHome("You collapsed.");
  }
  discard(lotId: string) { this.report(discard(this.state, lotId)); }
  private report(r: ActionResult) {
    if (r.message) this.toasts.show(r.message, r.detail);
    this.emit();
  }

  // ------------------------------------------------------------ places & stations

  /** The station within reach of someone standing at (x, feetY, z). */
  nearbyInteractable(x: number, z: number, feetY?: number): Interactable | null {
    let best: Interactable | null = null, bestD = Infinity;
    for (const st of layout().stations) {
      if (feetY !== undefined && Math.abs(feetY - st.y) > 1.3) continue;
      const d = Math.hypot(x - st.x, z - st.z);
      if (d <= st.radius && d < bestD) { best = st; bestD = d; }
    }
    return best;
  }

  /** Is the open panel's station still within reach (with a little slack)? */
  panelInReach(x: number, z: number, feetY: number): boolean {
    const st = layout().stations.find((s) => s.id === this.panel);
    return !!st && Math.abs(feetY - st.y) < 1.5 && Math.hypot(x - st.x, z - st.z) <= st.radius + 1;
  }

  interact(it: Interactable) {
    switch (it.id) {
      case "bed": void this.sleep(); return;
      case "desk": this.openJournal(); return;
      case "gloves": this.toggleGloves(); return;
      case "vent": this.stationAct("vent", "loft"); return;
    }
    if (isPanelStation(it.id)) this.openPanel(it.id);
  }

  openPanel(id: StationId | null) {
    this.panel = id;
    this.emit();
  }

  panelView(): PanelView | null {
    return this.panel ? viewStation(this.state, this.panel, this.draft, { weather: this.weather }) : null;
  }

  stationAct(act: string, station: StationId | null = this.panel) {
    if (act === "close") return this.openPanel(null);
    if (!station) return;
    const r = actStation(this.state, station, this.draft, act);
    if (r) this.report(r);
    else this.emit();
    if (r?.collapse) {
      this.panel = null;
      void this.wakeAtHome("You collapsed.");
    }
  }

  /** Name of where you are, for the HUD. */
  placeName(zoneName: string) {
    return this.room ? ROOM_NAMES[this.room] : zoneName;
  }

  // ------------------------------------------------------------ sleep

  async sleep() {
    if (this.busy) return;
    if (this.state.clock.minutes >= 6 * 60 && this.state.clock.minutes < 18 * 60) {
      // Napping all day would skip the season; allow it, but say so.
      this.toasts.show("It's still daylight, but you turn in early.");
    }
    this.busy = true;
    this.panel = null;
    await this.fader.out();
    this.endDay();
    this.toasts.show(this.morningLine(), this.overnight() ?? "Game saved.");
    await this.fader.in();
    this.busy = false;
  }

  private endDay() {
    const before = this.state.clock.year;
    goToSleep(this.state);
    if (this.state.clock.year !== before) this.harvestState.rollover(this.state.clock.year);
    this.refreshDay();
    saveToStorage(this.state);
  }

  private async passOut() {
    await this.wakeAtHome("It's 2 AM. You can't keep your eyes open.");
  }

  private async wakeAtHome(why: string) {
    if (this.busy) return;
    this.busy = true;
    this.panel = null;
    this.toasts.show(why);
    await this.fader.out();
    this.endDay();
    this.moveToBed();
    this.toasts.show(`You wake in your own bed. ${this.morningLine()}`, this.overnight() ?? "Game saved.");
    await this.fader.in();
    this.busy = false;
  }

  /** Put the player beside the bed, facing the window. */
  moveToBed() {
    const bed = layout().stations.find((s) => s.id === "bed")!;
    this.movePlayer(new Vector3(bed.x, bed.y, bed.z), new Vector3(SITE.farmhouse.x, bed.y, SITE.farmhouse.z - 10));
  }

  /** The overnight news (sales, orders, drying), condensed for a toast. */
  private overnight(): string | null {
    const n = this.pendingNotes.splice(0);
    if (!n.length) return null;
    const dry = n.filter((x) => / is dry\.$/.test(x)).length;
    const rest = n.filter((x) => !/ is dry\.$/.test(x));
    const lines = [...rest.slice(0, 3), ...(dry ? [`${dry} bundle${dry > 1 ? "s are" : " is"} dry.`] : [])];
    if (rest.length > 3) lines.push(`(+${rest.length - 3} more in the ledger)`);
    return lines.join(" ");
  }

  private morningLine() {
    const w = this.weather;
    return `${formatTime(this.state.clock.minutes)} · ${Math.round(w.lowF)}–${Math.round(w.highF)} °F · ${describeDay(w)}`;
  }

  // ------------------------------------------------------------ debug

  debugSetDay(doy: number) {
    this.state.clock.doy = ((doy - 1 + 365) % 365) + 1;
    this.refreshDay();
  }
  debugSetMinutes(minutes: number) {
    this.state.clock.minutes = ((minutes % 1440) + 1440) % 1440;
  }

  // ------------------------------------------------------------ readouts

  basketLine() {
    return `${(basketWeight(this.state.basket) / 1000).toFixed(1)} / ${BASKET_CAPACITY_G / 1000} kg`;
  }
  moneyLine() {
    return `${money(this.state.money)} · reputation ${Math.round(this.state.reputation)}`;
  }
  get nowAbsMinute() {
    return absMinute(this.state.clock);
  }
}

function describeDay(w: DayWeather) {
  switch (w.condition) {
    case "storm": return "storms later";
    case "rain": return "rain on the way";
    case "snow": return "snow";
    case "fog": return "foggy morning";
    case "clear": return "clear skies";
    case "partly": return "partly cloudy";
    default: return "overcast";
  }
}

