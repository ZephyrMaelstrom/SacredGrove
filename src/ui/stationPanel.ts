/**
 * Desktop station panel: renders the session's PanelView (see
 * game/stations.ts) as HTML and sends button presses back. Time keeps
 * running while it's open, so brews finish while you work.
 */
import type { Session } from "../game/session";
import type { PanelView, Row, Btn } from "../game/stations";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function renderPanelHtml(v: PanelView): string {
  const btn = (b: Btn) =>
    `<button data-act="${esc(b.act)}" class="${b.warn ? "warn" : ""} ${b.on ? "on" : ""}" ${b.disabled ? "disabled" : ""}>${esc(b.label)}</button>`;
  const row = (r: Row) => `<tr class="${r.tone ?? ""}"><td><b>${esc(r.text)}</b>${r.sub ? `<br><span class="dim">${esc(r.sub)}</span>` : ""}</td>
    <td>${r.bar !== undefined ? `<span class="pot"><span style="width:${r.bar}%"></span></span> ${r.bar}%` : ""}</td>
    <td class="acts">${(r.buttons ?? []).map(btn).join("")}</td></tr>`;
  const sections = v.sections.map((s) => `
    <section>
      ${s.title ? `<h3>${esc(s.title)}</h3>` : ""}
      ${s.note ? `<p class="dim">${esc(s.note)}</p>` : ""}
      ${s.rows.length ? `<table>${s.rows.map(row).join("")}</table>` : ""}
      ${s.buttons?.length ? `<div class="sbtns">${s.buttons.map(btn).join("")}</div>` : ""}
    </section>`).join("");
  return `<div class="satchel-head"><b class="ptitle">${esc(v.title)}</b><button data-act="close" class="close">✕</button></div>
    <div class="satchel-body">${v.subtitle ? `<p class="dim">${esc(v.subtitle)}</p>` : ""}${sections}</div>`;
}

export class StationPanel {
  private el: HTMLElement;
  private shown: string | null = null;

  constructor(private session: Session) {
    this.el = document.getElementById("station")!;
    this.el.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button");
      if (!b || b.disabled) return;
      const act = b.dataset.act;
      if (act) session.stationAct(act);
    });
    session.subscribe(() => this.render());
    window.addEventListener("keydown", (e) => {
      if (this.open && e.key === "Escape") session.openPanel(null);
    });
  }

  get open() {
    return !!this.session.panel;
  }

  render() {
    const v = this.session.panelView();
    this.el.classList.toggle("open", !!v);
    document.body.classList.toggle("panel-open", !!v);
    if (!v) {
      this.shown = null;
      return;
    }
    if (this.shown !== this.session.panel) document.exitPointerLock?.();
    this.shown = this.session.panel;
    const scroll = this.el.querySelector(".satchel-body")?.scrollTop ?? 0;
    this.el.innerHTML = renderPanelHtml(v);
    const body = this.el.querySelector(".satchel-body");
    if (body) body.scrollTop = scroll;
  }
}
