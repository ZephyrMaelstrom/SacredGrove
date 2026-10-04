/**
 * The satchel (desktop): what you're carrying, your Field Journal, the
 * recipes you've worked out, and your ledger. Tab or J opens it and frees
 * the mouse.
 */
import { PLANTS } from "../data/plants";
import type { Session } from "../game/session";
import { absDay, formatTime } from "../time/clock";
import { formatDoy } from "../sim/phenology";
import { isPrep, isStock, METHOD_NAMES, type Item } from "../game/items";
import { herbCondition } from "../game/storage";
import { itemName, money, prepSummary } from "../game/homestead";
import { effectWord } from "../game/stations";
import { strengthWord } from "../game/apothecary";
import { GOALS, nextGoal } from "../game/goals";

type Tab = "notes" | "basket" | "journal" | "recipes" | "ledger";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FORM_WORDS: Record<string, string> = {
  rosette: "rosette", mat: "low creeper", forb: "forb", tallForb: "tall forb", grass: "grass", sedge: "sedge",
  bulb: "bulb plant", vine: "vine", cane: "bramble", horsetail: "horsetail", fungus: "mushroom",
  fungusBracket: "bracket fungus", shrub: "shrub", tree: "tree",
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export class Satchel {
  private el: HTMLElement;
  private tab: Tab = "notes";
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

  /** Open straight to a tab (the writing desk opens the journal). */
  show(tab: Tab) {
    this.tab = tab;
    if (!this.open) this.toggle();
    else this.render();
  }

  private lotRow(l: Item, actions: boolean) {
    const s = this.session.state;
    if (isPrep(l)) {
      const btns = actions ? `<button data-act="taste" data-id="${esc(l.id)}" class="warn">Taste</button><button data-act="toss" data-id="${esc(l.id)}">Pour out</button>` : "";
      return `<tr><td><b>${esc(l.name)}</b><br><span class="dim">${esc(prepSummary(l))} · ${esc(l.description)}</span></td><td>${l.volumeMl} ml</td><td></td><td class="acts">${btns}</td></tr>`;
    }
    if (isStock(l)) {
      const btns = actions ? `<button data-act="toss" data-id="${esc(l.id)}">Toss</button>` : "";
      return `<tr><td><b>${esc(itemName(s, l))}</b><br><span class="dim">${l.form === "seed" ? `${l.count} seeds · plant in a garden bed` : "living division · plant it soon"}${l.chill ? ` · ${l.chill} cold days banked` : ""}</span></td><td></td><td>${potencyBar(l.viability)}</td><td class="acts">${btns}</td></tr>`;
    }
    const plant = PLANTS.find((p) => p.latin === l.latin);
    const known = !!(plant && s.journal[l.latin]?.identified);
    const age = absDay(s.clock) - l.harvestedDay;
    const when = age === 0 ? "today" : age === 1 ? "yesterday" : `${age} days ago`;
    const name = known ? l.productName : `Unknown ${FORM_WORDS[plant?.form ?? ""] ?? "plant"} (${l.part.toLowerCase()})`;
    const btns = actions
      ? `<button data-act="smell" data-id="${esc(l.id)}">Smell</button><button data-act="taste" data-id="${esc(l.id)}" class="warn">Taste</button><button data-act="toss" data-id="${esc(l.id)}">Toss</button>`
      : "";
    return `<tr><td><b>${esc(name)}</b><br><span class="dim">${esc(l.part)} · ${herbCondition(l)} · picked ${when}</span></td><td>${l.grams} g</td><td>${potencyBar(Math.round(l.potency))}</td><td class="acts">${btns}</td></tr>`;
  }

  render() {
    const s = this.session.state;
    const tabs = (["notes", "basket", "journal", "recipes", "ledger"] as Tab[])
      .map((t) => `<button data-tab="${t}" class="${t === this.tab ? "on" : ""}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("");
    let body = "";
    if (this.tab === "basket") {
      body = s.basket.length
        ? `<p class="dim">Basket ${this.session.basketLine()} · Smell and taste a sample to fill in its journal page. Tasting unknown plants is dangerous.</p>
           <table>${s.basket.map((l) => this.lotRow(l, true)).join("")}</table>`
        : `<p class="dim">Your basket is empty. Hold the left mouse button on a plant to harvest it.</p>`;
    } else if (this.tab === "notes") {
      const next = nextGoal(s);
      body = `<p class="dim">Field notes: a way through your first season. Each one finishes itself when you've done it.</p>` +
        GOALS.map((g) => {
          const done = s.goals.includes(g.id);
          return `<div class="entry ${done ? "unknown" : ""}">${done ? "✓" : g === next ? "▸" : "○"} <b>${esc(g.title)}</b>${done ? "" : `<br><span class="dim">${esc(g.hint)}</span>`}</div>`;
        }).join("");
    } else if (this.tab === "recipes") {
      body = this.recipes();
    } else if (this.tab === "ledger") {
      const now = this.session.nowAbsMinute;
      const st = s.statuses.filter((x) => x.until > now);
      const where = Object.entries(s.storage).filter(([, l]) => l.length).map(([k, l]) => `${k} ${l.length}`).join(" · ");
      body = `<p>${formatDoy(s.clock.doy)}, Year ${s.clock.year} · ${formatTime(s.clock.minutes)}</p>
        <p><b>${money(s.money)}</b> in your pocket · ${money(s.cashBox)} in the stand's cash box · reputation ${Math.round(s.reputation)}/100</p>
        <p>${st.length ? st.map((x) => `<b>${esc(x.label)}</b> — ${duration(x.until - now)} left`).join("<br>") : "You feel fine."}</p>
        <p class="dim">${s.gloves ? "Wearing gloves." : "Bare-handed (G puts on gloves)."} · ${s.stats.harvests} harvests · ${s.stats.brews} brews · ${s.stats.sales} sold · ${s.stats.ordersDone} orders filled · ${s.stats.daysPlayed} nights slept${where ? ` · stored: ${where}` : ""}</p>
        <h3>Ledger</h3>${s.ledger.length ? s.ledger.map((l) => `<p class="dim">Day ${l.day}: ${esc(l.text)}</p>`).join("") : `<p class="dim">Nothing yet.</p>`}`;
    } else {
      body = this.journal();
    }
    this.el.innerHTML = `<div class="satchel-head">${tabs}<button data-act="close" class="close">✕</button></div><div class="satchel-body">${body}</div>`;
  }

  private recipes() {
    const list = Object.values(this.session.state.protocols).filter((p) => Object.keys(p.best).length || p.notes.length);
    if (!list.length) return `<p class="dim">No recipes worked out yet. Brew something at the apothecary bench, then taste it (or have a customer report back) to learn what it does. Single-herb brews teach you the most.</p>`;
    list.sort((a, b) => Math.max(0, ...Object.values(b.best)) - Math.max(0, ...Object.values(a.best)));
    return list.map((p) => {
      const ings = p.ingredients.map((i) => `${esc(i.name)} ${i.share}%`).join(" + ");
      const eff = Object.entries(p.best).sort((a, b) => b[1] - a[1]).map(([t, v]) => `${strengthWord(v)} ${esc(effectWord(t))}`).join(", ");
      const how = `${METHOD_NAMES[p.method as keyof typeof METHOD_NAMES] ?? p.method}, ${p.waterMl} ml, ${p.minutes} min${p.method === "hot" ? (p.covered ? ", lid on" : ", lid off") : ""}`;
      return `<div class="entry"><b>${esc(p.name)}</b><br><span class="dim">${ings} · ${esc(how)}</span>
        <br>${eff ? `<span class="hint">${eff}</span>` : `<span class="dim">no noticeable effect</span>`}
        ${p.notes.length ? `<br><span class="dim">${p.notes.map(esc).join(" · ")}</span>` : ""}</div>`;
    }).join("");
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
        const eff = e.effects?.[pr.id]?.length ? `<br><span class="hint">does: ${e.effects[pr.id].map(effectWord).map(esc).join(", ")}</span>` : "";
        const sus = e.suspected?.[pr.id]?.length ? `<br><span class="dim">maybe: ${e.suspected[pr.id].map(effectWord).map(esc).join(", ")}?</span>` : "";
        const no = e.doesnt?.[pr.id]?.length ? `<br><span class="dim">not for: ${e.doesnt[pr.id].map(effectWord).map(esc).join(", ")}</span>` : "";
        return `<li>${got ? "✓" : "○"} ${esc(pr.name)} <span class="dim">(${pr.part.toLowerCase()}) — ${smell} · ${taste}${best}</span>${eff}${sus}${no}</li>`;
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
  p = Math.round(p);
  return `<span class="pot"><span style="width:${p}%"></span></span> ${p}%`;
}
function duration(min: number) {
  if (min >= 1440) return `${Math.ceil(min / 1440)} days`;
  if (min >= 60) return `${Math.ceil(min / 60)} hours`;
  return `${Math.ceil(min)} minutes`;
}
