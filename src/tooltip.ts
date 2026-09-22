/** A small hover box that follows the mouse over the map. */

export class Tooltip {
  private readonly el: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'tooltip';
    this.el.hidden = true;
    parent.appendChild(this.el);
  }

  show(text: string, x: number, y: number): void {
    this.el.textContent = text;
    this.el.hidden = false;
    const parent = this.el.parentElement!.getBoundingClientRect();
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    let left = x + 14;
    let top = y + 14;
    if (left + w > parent.width - 8) left = x - w - 8;
    if (top + h > parent.height - 8) top = y - h - 8;
    this.el.style.left = `${Math.max(0, left)}px`;
    this.el.style.top = `${Math.max(0, top)}px`;
  }

  hide(): void {
    this.el.hidden = true;
  }
}
