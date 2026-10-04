/**
 * A floating panel in VR that renders a PanelView (the same data the desktop
 * panels show), a page at a time. Point and pull the trigger (controllers)
 * or poke (hands) to press buttons.
 */
import { MeshBuilder, Vector3, type Mesh, type Scene } from "@babylonjs/core";
import { AdvancedDynamicTexture, Button, Control, Grid, Rectangle, StackPanel, TextBlock } from "@babylonjs/gui";
import type { PanelView, Btn } from "../game/stations";

const W = 1280, H = 960;
const ROWS_PER_PAGE = 8;

interface Line {
  kind: "title" | "note" | "row" | "buttons";
  text?: string;
  sub?: string;
  tone?: string;
  bar?: number;
  buttons?: Btn[];
}

function flatten(v: PanelView): Line[] {
  const out: Line[] = [];
  if (v.subtitle) out.push({ kind: "note", text: v.subtitle });
  for (const s of v.sections) {
    if (s.title) out.push({ kind: "title", text: s.title });
    if (s.note) out.push({ kind: "note", text: s.note });
    for (const r of s.rows) out.push({ kind: "row", text: r.text, sub: r.sub, tone: r.tone, bar: r.bar, buttons: r.buttons });
    if (s.buttons?.length) out.push({ kind: "buttons", buttons: s.buttons });
  }
  return out;
}

export class VrPanel {
  readonly plane: Mesh;
  private head: StackPanel;
  private body: StackPanel;
  private page = 0;
  private lastTitle = "";
  open = false;

  constructor(private scene: Scene, name: string, private onAct: (act: string) => void, width = 1.0) {
    this.plane = MeshBuilder.CreatePlane(name, { width, height: (width * H) / W }, scene);
    this.plane.isNearPickable = true;
    this.plane.renderingGroupId = 2;
    this.plane.setEnabled(false);
    const ui = AdvancedDynamicTexture.CreateForMesh(this.plane, W, H);
    const bg = new Rectangle(`${name}_bg`);
    bg.background = "rgba(20,28,20,0.94)";
    bg.cornerRadius = 30;
    bg.thickness = 0;
    ui.addControl(bg);
    const grid = new Grid(`${name}_grid`);
    grid.addRowDefinition(96, true);
    grid.addRowDefinition(1);
    bg.addControl(grid);
    this.head = new StackPanel(`${name}_head`);
    this.head.isVertical = false;
    this.head.height = "96px";
    grid.addControl(this.head, 0, 0);
    this.body = new StackPanel(`${name}_body`);
    this.body.paddingLeft = this.body.paddingRight = "28px";
    grid.addControl(this.body, 1, 0);
  }

  /** Float the panel in front of the camera. */
  place() {
    const cam = this.scene.activeCamera!;
    const f = cam.getDirection(Vector3.Forward());
    f.y = 0;
    f.normalize();
    this.plane.position = cam.globalPosition.add(f.scale(0.85)).add(new Vector3(0, -0.12, 0));
    this.plane.lookAt(cam.globalPosition.add(new Vector3(0, -0.12, 0)));
    this.plane.rotate(Vector3.Up(), Math.PI); // the plane's front faces away from lookAt
  }

  show(v: PanelView | null) {
    const was = this.open;
    this.open = !!v;
    this.plane.setEnabled(this.open);
    if (!v) return;
    if (!was || v.title !== this.lastTitle) {
      this.page = 0;
      this.place();
    }
    this.lastTitle = v.title;
    this.render(v);
  }

  private button(label: string, w: number, fn: () => void, opts: { warn?: boolean; on?: boolean; disabled?: boolean } = {}) {
    const b = Button.CreateSimpleButton(`b_${label}_${Math.random()}`, label);
    b.width = `${w}px`;
    b.height = "66px";
    b.color = "#eef0e6";
    b.fontSize = 26;
    b.background = opts.disabled ? "#2a3328" : opts.warn ? "#7a3a2a" : opts.on ? "#6b8f4e" : "#3d5a36";
    b.alpha = opts.disabled ? 0.5 : 1;
    b.cornerRadius = 12;
    b.paddingLeft = b.paddingRight = "5px";
    if (!opts.disabled) b.onPointerUpObservable.add(fn);
    return b;
  }

  private text(t: string, size: number, color: string, height: number, width?: number) {
    const tb = new TextBlock(undefined, t);
    tb.color = color;
    tb.fontSize = size;
    tb.height = `${height}px`;
    if (width) tb.width = `${width}px`;
    tb.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    tb.textWrapping = true;
    return tb;
  }

  private render(v: PanelView) {
    const lines = flatten(v);
    // Pages break on rows, keeping section titles with what follows.
    const pages: Line[][] = [[]];
    let rows = 0;
    for (const l of lines) {
      const cost = l.kind === "row" ? 1 : l.kind === "buttons" ? 0.8 : 0.5;
      if (rows + cost > ROWS_PER_PAGE && pages[pages.length - 1].length) {
        pages.push([]);
        rows = 0;
      }
      pages[pages.length - 1].push(l);
      rows += cost;
    }
    this.page = Math.min(this.page, pages.length - 1);

    this.head.clearControls();
    const title = this.text(v.title, 34, "#f0d36a", 96, 760);
    title.paddingLeft = "28px";
    this.head.addControl(title);
    this.head.addControl(this.button("◀", 90, () => { this.page = Math.max(0, this.page - 1); this.render(v); }, { disabled: this.page === 0 }));
    this.head.addControl(this.text(`${this.page + 1}/${pages.length}`, 26, "#c8ccbd", 96, 90));
    this.head.addControl(this.button("▶", 90, () => { this.page = Math.min(pages.length - 1, this.page + 1); this.render(v); }, { disabled: this.page >= pages.length - 1 }));
    this.head.addControl(this.button("Close", 150, () => this.onAct("close"), { warn: true }));

    this.body.clearControls();
    for (const l of pages[this.page]) {
      if (l.kind === "title") this.body.addControl(this.text(l.text!, 30, "#f0d36a", 54));
      else if (l.kind === "note") this.body.addControl(this.text(l.text!, 22, "#c8ccbd", 64));
      else {
        const row = new StackPanel();
        row.isVertical = false;
        row.height = l.kind === "row" ? "92px" : "76px";
        const btns = l.buttons ?? [];
        const bw = btns.length > 3 ? 120 : btns.length === 3 ? 150 : 170;
        if (l.kind === "row") {
          const color = l.tone === "warn" ? "#e8b8a0" : l.tone === "good" ? "#b8e0a0" : "#eef0e6";
          const label = this.text(`${l.text}${l.bar !== undefined ? ` · ${l.bar}%` : ""}${l.sub ? `\n${l.sub}` : ""}`, 22, color, 92, W - 70 - bw * btns.length);
          row.addControl(label);
        }
        for (const b of btns) row.addControl(this.button(b.label, bw, () => this.onAct(b.act), b));
        this.body.addControl(row);
      }
    }
  }
}
