/**
 * The satchel (desktop): what you're carrying, your Field Journal, what's in
 * the barn, and how you're feeling. Tab or J opens it and frees the mouse.
 */
import { PLANTS } from "../data/plants";
import type { Session } from "../game/session";
import { absDay, formatTime } from "../time/clock";
import { formatDoy } from "../sim/phenology";
import type { Lot } from "../game/basket";

type Tab = "basket" | "journal" | "barn" | "status";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FORM_WORDS: Record<string, string> = {
  rosette: "rosette", mat: "low creeper", forb: "forb", tallForb: "tall forb", grass: "grass", sedge: "sedge",
  bulb: "bulb plant", vine: "vine", cane: "bramble", horsetail: "horsetail", fungus: "mushroom",
  fungusBracket: "bracket fungus", shrub: "shrub", tree: "tree",
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export class Satchel {
  private el: HTMLElement;
  private tab: Tab = "basket";
  open = false;

  constructor(private session: Session) {
    this.el = document.getElementById("satchel")!;
    this.el.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button");
      if (!b) return;
      const { act, id, tab } = b.dataset;
      if (tab) { this.tab = tab as Tab; this.render(); return; }
      if (act === "close") return this.toggle();
      if (act === "smell" && id) session.smell(id);
      if (act === "taste" && id) session.taste(id);
      if (act === "toss" && id) session.discard(id);
    });
    session.subscribe(() => { if (this.open) this.render(); });
  }

  toggle() {
    this.open = !this.open;
    this.el.classList.toggle("open", this.open);
    this.session.paused = this.open;
    if (this.open) {
      document.exitPointerLock?.();
      this.render();
    }
  }

  private lotRow(l: Lot, actions: boolean) {
    const s = this.session.state;
    const plant = PLANTS.find((p) => p.latin === l.latin);
    const known = !!(plant && s.journal[l.latin]?.identified);
    const age = absDay(s.clock) - l.harvestedDay;
    const when = age === 0 ? "today" : age === 1 ? "yesterday" : `${age} days ago`;
    const name = known ? l.productName : `Unknown ${FORM_WORDS[plant?.form ?? ""] ?? "plant"} (${l.part.toLowerCase()})`;
    const btns = actions
      ? `<button data-act="smell" data-id="${esc(l.id)}">Smell</button><button data-act="taste" data-id="${esc(l.id)}" class="warn">Taste</button><button data-act="toss" data-id="${esc(l.id)}">Toss</button>`
      : "";
    return `<tr><td><b>${esc(name)}</b><br><span class="dim">${esc(l.part)} · picked ${when}</span></td><td>${l.grams} g</td><td>${potencyBar(l.potency)}</td><td class="acts">${btns}</td></tr>`;
  }

  render() {
    const s = this.session.state;
    const tabs = (["basket", "journal", "barn", "status"] as Tab[])
      .map((t) => `<button data-tab="${t}" class="${t === this.tab ? "on" : ""}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("");
    let body = "";
    if (this.tab === "basket") {
      body = s.basket.length
        ? `<p class="dim">Basket ${this.session.basketLine()} · Smell and taste a sample to fill in its journal page. Tasting unknown plants is dangerous.</p>
           <table>${s.basket.map((l) => this.lotRow(l, true)).join("")}</table>`
        : `<p class="dim">Your basket is empty. Hold the left mouse button on a plant to harvest it.</p>`;
    } else if (this.tab === "barn") {
      body = s.stores.length
        ? `<p class="dim">Unloaded at the barn. Drying, the root cellar and the apothecary bench come in M6–M7.</p><table>${s.stores.map((l) => this.lotRow(l, false)).join("")}</table>`
        : `<p class="dim">Nothing in the barn yet. Press E at the barn doors to unload your basket.</p>`;
    } else if (this.tab === "status") {
      const now = this.session.nowAbsMinute;
      const st = s.statuses.filter((x) => x.until > now);
      body = `<p>${formatDoy(s.clock.doy)}, Year ${s.clock.year} · ${formatTime(s.clock.minutes)}</p>
        <p>${st.length ? st.map((x) => `<b>${esc(x.label)}</b> — ${duration(x.until - now)} left`).join("<br>") : "You feel fine."}</p>
        <p class="dim">${s.gloves ? "Wearing gloves." : "Bare-handed (G puts on gloves)."} · ${s.stats.harvests} harvests · ${s.stats.daysPlayed} nights slept</p>`;
    } else {
      body = this.journal();
    }
    this.el.innerHTML = `<div class="satchel-head">${tabs}<button data-act="close" class="close">✕</button></div><div class="satchel-body">${body}</div>`;
  }

  private journal() {
    const s = this.session.state;
    const entries = Object.values(s.journal);
    if (!entries.length) return `<p class="dim">Your Field Journal is empty. Look closely at a plant (hold your gaze on it) or harvest it to start a page.</p>`;
    const known = entries.filter((e) => e.identified).length;
    entries.sort((a, b) => Number(b.identified) - Number(a.identified) || a.latin.localeCompare(b.latin));
    const rows = entries.map((e) => {
      const p = PLANTS.find((x) => x.latin === e.latin)!;
      if (!e.identified) return `<div class="entry unknown"><b>Unknown ${FORM_WORDS[p.form] ?? "plant"}</b><br><span class="dim">Seen in ${esc(e.zones.join(", "))}. Look closer to identify.</span></div>`;
      const products = p.products.map((pr) => {
        const got = e.collected.includes(pr.id);
        const smell = e.smelled.includes(pr.id) ? `smell: ${esc(pr.smell || "faint")}` : "smell: ?";
        const taste = e.tasted.includes(pr.id) ? `taste: ${esc(pr.taste || "bland")}` : "taste: ?";
        const best = e.best[pr.id] ? ` · best ${e.best[pr.id]}%` : "";
        return `<li>${got ? "✓" : "○"} ${esc(pr.name)} <span class="dim">(${pr.part.toLowerCase()}) — ${smell} · ${taste}${best}</span></li>`;
      }).join("");
      const months = e.months.sort((a, b) => a - b).map((m) => MONTHS[m - 1]).join(", ");
      return `<div class="entry"><b>${esc(p.name)}</b> <i>${esc(p.latin)}</i>
        <br><span class="dim">${esc(p.notes)}</span>
        <br><span class="dim">Found in: ${esc(e.zones.join(", "))}${months ? ` · harvested in ${months}` : ""} · ${e.timesHarvested} harvest${e.timesHarvested === 1 ? "" : "s"}</span>
        <ul>${products}</ul>${e.notes.length ? `<p class="warnText">${e.notes.map(esc).join("<br>")}</p>` : ""}</div>`;
    }).join("");
    return `<p class="dim">${known} identified · ${entries.length - known} unknown · ${PLANTS.length} plants grow on this land.</p>${rows}`;
  }
}

function potencyBar(p: number) {
  return `<span class="pot"><span style="width:${p}%"></span></span> ${p}%`;
}
function duration(min: number) {
  if (min >= 1440) return `${Math.ceil(min / 1440)} days`;
  if (min >= 60) return `${Math.ceil(min / 60)} hours`;
  return `${Math.ceil(min)} minutes`;
}
