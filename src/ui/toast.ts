/** Short messages at the bottom of the screen (desktop). VR shows the same text on the wrist. */
export type ToastListener = (text: string, detail?: string) => void;

export class Toasts {
  private el: HTMLElement;
  private listeners: ToastListener[] = [];
  last = "";
  lastDetail = "";

  constructor() {
    this.el = document.getElementById("toasts")!;
  }
  onToast(fn: ToastListener) {
    this.listeners.push(fn);
  }
  show(text: string, detail?: string) {
    if (!text) return;
    this.last = text;
    this.lastDetail = detail ?? "";
    for (const fn of this.listeners) fn(text, detail);
    const div = document.createElement("div");
    div.className = "toast";
    div.innerHTML = `<b>${escape(text)}</b>${detail ? `<br><span>${escape(detail)}</span>` : ""}`;
    this.el.appendChild(div);
    while (this.el.children.length > 4) this.el.firstElementChild?.remove();
    setTimeout(() => div.classList.add("fade"), 5000 + (detail ? 2500 : 0));
    setTimeout(() => div.remove(), 6000 + (detail ? 2500 : 0));
  }
}

const escape = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
