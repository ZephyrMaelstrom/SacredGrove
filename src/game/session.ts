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
import { ZONES, SITE, heightAt } from "../world/map";
import type { Terrain } from "../world/terrain";
import type { Sky } from "../world/sky";
import type { HerbRenderer } from "../veg/herbs";
import type { WoodyRenderer } from "../veg/woody";
import { HarvestState, patchKey, type Layer } from "./harvestState";
import { harvest, examine, notice, smell, taste, discard, type Target, type ActionResult } from "./forage";
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

export interface Interactable {
  id: string;
  label: string;
  x: number;
  z: number;
  radius: number;
}

export const DOOR: Interactable = { id: "door", label: "Front door — go to bed", x: SITE.farmhouse.x, z: SITE.farmhouse.z - SITE.farmhouse.d / 2 - 1, radius: 2.6 };
export const BARN: Interactable = { id: "barn", label: "Barn — unload your basket", x: SITE.barn.x, z: SITE.barn.z - SITE.barn.d / 2 - 1.5, radius: 3.2 };
const PORCH = new Vector3(SITE.farmhouse.x, 0, SITE.farmhouse.z - SITE.farmhouse.d / 2 - 3.5);

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
  private examining: { key: string; t: number } | null = null;
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
    const world = { hash: (DATA_HASH ^ WORLD_SEED) >>> 0, herbs: population.herbs.count, woody: woody.count };
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

  /** New date: weather, season, plant looks, visibility. */
  refreshDay() {
    const c = this.state.clock;
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
    }
    this.sky.update({ doy: this.state.clock.doy, minutes: this.state.clock.minutes, weather: this.weather }, cameraPos, dt);
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

  // ------------------------------------------------------------ places

  nearbyInteractable(x: number, z: number): Interactable | null {
    for (const it of [DOOR, BARN]) if (Math.hypot(x - it.x, z - it.z) <= it.radius) return it;
    return null;
  }

  interact(it: Interactable) {
    if (it.id === "door") void this.sleep();
    if (it.id === "barn") this.unload();
  }

  /** Placeholder storage until the barn interior (M6): the basket empties into the barn stores. */
  unload() {
    const s = this.state;
    if (!s.basket.length) return this.toasts.show("Your basket is empty.");
    const grams = basketWeight(s.basket);
    s.stores ??= [];
    s.stores.push(...s.basket);
    s.basket = [];
    this.toasts.show(`Unloaded ${grams} g into the barn.`, "Drying racks and the root cellar come with the barn interior (M6).");
    this.emit();
  }

  // ------------------------------------------------------------ sleep

  async sleep() {
    if (this.busy) return;
    if (this.state.clock.minutes >= 6 * 60 && this.state.clock.minutes < 18 * 60) {
      // Napping all day would skip the season; allow it, but say so.
      this.toasts.show("It's still daylight, but you turn in early.");
    }
    this.busy = true;
    await this.fader.out();
    this.endDay();
    this.toasts.show(this.morningLine(), "Game saved.");
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
    this.toasts.show(why);
    await this.fader.out();
    this.endDay();
    const to = PORCH.clone();
    to.y = heightAt(to.x, to.z);
    this.movePlayer(to, new Vector3(SITE.barn.x, to.y, SITE.barn.z));
    this.toasts.show(`You wake on the porch. ${this.morningLine()}`, "Game saved.");
    await this.fader.in();
    this.busy = false;
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

