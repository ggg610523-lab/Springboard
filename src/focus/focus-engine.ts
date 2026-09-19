import type { FocusTarget } from "../types";

export type Direction = "up" | "down" | "left" | "right";

interface Handlers {
  onFocus?: () => void;
  onBlur?: () => void;
  onActivate?: () => void;
  onContext?: () => void;
  /** Return true to swallow the arrow key (sliders and text fields use this). */
  onMove?: (direction: Direction) => boolean;
  disabled?: () => boolean;
  /** Stable identity so focus survives a re-render. */
  key?: string;
}

interface ZoneInfo {
  layer: string;
  order: number;
  element: HTMLElement;
}

const VECTORS: Record<Direction, [number, number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

/**
 * A geometric focus engine that reproduces how an Apple TV remote feels:
 * arrows always land on the nearest sensible neighbour, re-entering an area
 * restores the previous item, and everything stays keyboard driven.
 */
export class FocusEngine {
  private zones = new Map<string, ZoneInfo>();
  private handlers = new WeakMap<HTMLElement, Handlers>();
  private layerStack: string[] = ["home"];
  private current: HTMLElement | null = null;
  private memory = new Map<string, string>();
  private onFocusChange: ((el: HTMLElement | null) => void) | null = null;

  private get layer(): string {
    return this.layerStack[this.layerStack.length - 1] ?? "home";
  }

  onchange(fn: (el: HTMLElement | null) => void): void {
    this.onFocusChange = fn;
  }

  attach(el: HTMLElement, handlers: Handlers): void {
    this.handlers.set(el, handlers);
    el.classList.add("focusable");
    el.addEventListener("pointerenter", () => this.focusElement(el));
    el.addEventListener("click", (event) => {
      event.stopPropagation();
      if (this.current !== el) {
        this.focusElement(el);
        return;
      }
      this.activate();
    });
    el.addEventListener("contextmenu", (event) => {
      const handler = this.handlers.get(el);
      if (!handler?.onContext) return;
      event.preventDefault();
      this.focusElement(el);
      handler.onContext();
    });
  }

  handlersFor(el: HTMLElement): Handlers | undefined {
    return this.handlers.get(el);
  }

  registerZone(id: string, element: HTMLElement, order: number, layer = this.layer): void {
    this.zones.set(id, { layer, order, element });
  }

  unregisterZone(id: string): void {
    this.zones.delete(id);
  }

  pushLayer(layer: string): void {
    this.layerStack.push(layer);
  }

  popLayer(layer?: string): string {
    if (layer) {
      const index = this.layerStack.lastIndexOf(layer);
      if (index > 0) this.layerStack.splice(index, 1);
    } else if (this.layerStack.length > 1) {
      this.layerStack.pop();
    }
    return this.layer;
  }

  get activeLayer(): string {
    return this.layer;
  }

  /** Focusables of the active layer, in zone-then-DOM order. */
  private collect(): { el: HTMLElement; zone: ZoneInfo }[] {
    const active = this.layer;
    const zones = [...this.zones.values()]
      .filter((zone) => zone.layer === active)
      .sort((a, b) => a.order - b.order);
    const out: { el: HTMLElement; zone: ZoneInfo }[] = [];
    for (const zone of zones) {
      if (!zone.element.isConnected) continue;
      for (const node of zone.element.querySelectorAll<HTMLElement>(".focusable")) {
        if (!node.isConnected) continue;
        const handler = this.handlers.get(node);
        if (handler?.disabled?.()) continue;
        if (node.hasAttribute("data-focus-skip")) continue;
        if (!this.isRendered(node)) continue;
        out.push({ el: node, zone });
      }
    }
    return out;
  }

  private isRendered(el: HTMLElement): boolean {
    if (el.offsetParent === null && getComputedStyle(el).position !== "fixed") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /** Called after every render; keeps or restores focus sensibly. */
  rebuild(preferKey?: string): void {
    const items = this.collect();
    if (!items.length) {
      this.setCurrent(null);
      return;
    }
    const key = preferKey ?? this.currentKey();
    if (key) {
      const match = items.find((item) => this.handlers.get(item.el)?.key === key);
      if (match) {
        this.setCurrent(match.el);
        return;
      }
    }
    if (this.current && items.some((item) => item.el === this.current)) {
      this.setCurrent(this.current);
      return;
    }
    const remembered = this.bestRemembered(items);
    this.setCurrent(remembered?.el ?? items[0].el);
  }

  private currentKey(): string | undefined {
    return this.current ? this.handlers.get(this.current)?.key : undefined;
  }

  private bestRemembered(items: { el: HTMLElement }[]): { el: HTMLElement } | null {
    for (const key of this.memory.values()) {
      const match = items.find((item) => this.handlers.get(item.el)?.key === key);
      if (match) return match;
    }
    return null;
  }

  private setCurrent(el: HTMLElement | null): void {
    if (this.current && this.current !== el) {
      this.current.classList.remove("is-focused");
      this.handlers.get(this.current)?.onBlur?.();
    }
    this.current = el;
    if (!el) {
      this.onFocusChange?.(null);
      return;
    }
    el.classList.add("is-focused");
    const handler = this.handlers.get(el);
    const zone = this.zoneOf(el);
    if (handler?.key && zone) this.memory.set(zone.id, handler.key);
    handler?.onFocus?.();
    this.ensureVisible(el);
    this.onFocusChange?.(el);
  }

  private zoneOf(el: HTMLElement): { id: string; info: ZoneInfo } | null {
    for (const [id, info] of this.zones) {
      if (info.element.contains(el)) return { id, info };
    }
    return null;
  }

  get focused(): HTMLElement | null {
    return this.current;
  }

  focusElement(el: HTMLElement | null): void {
    if (!el || el === this.current) return;
    if (this.handlers.get(el)?.disabled?.()) return;
    for (const info of this.zones.values()) {
      if (info.layer !== this.layer) continue;
      if (info.element.contains(el)) {
        this.setCurrent(el);
        return;
      }
    }
  }

  focusKey(key: string): boolean {
    const match = this.collect().find((item) => this.handlers.get(item.el)?.key === key);
    if (!match) return false;
    this.setCurrent(match.el);
    return true;
  }

  focusFirst(zoneId?: string): void {
    const items = this.collect().filter((item) => !zoneId || this.zoneOf(item.el)?.id === zoneId);
    if (items.length) this.setCurrent(items[0].el);
  }

  activate(): boolean {
    const handler = this.current ? this.handlers.get(this.current) : undefined;
    if (!handler?.onActivate) return false;
    handler.onActivate();
    return true;
  }

  context(): boolean {
    const handler = this.current ? this.handlers.get(this.current) : undefined;
    if (!handler?.onContext) return false;
    handler.onContext();
    return true;
  }

  /** Move focus one step in a direction, tvOS style. */
  move(direction: Direction): boolean {
    if (!this.current) {
      this.focusFirst();
      return true;
    }
    const handler = this.handlers.get(this.current);
    if (handler?.onMove?.(direction)) return true;

    const items = this.collect();
    const source = this.current.getBoundingClientRect();
    const origin = { x: source.left + source.width / 2, y: source.top + source.height / 2 };
    const [dx, dy] = VECTORS[direction];
    const sourceZone = this.zoneOf(this.current)?.id;

    let best: { el: HTMLElement; score: number } | null = null;
    for (const item of items) {
      if (item.el === this.current) continue;
      const rect = item.el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const deltaX = center.x - origin.x;
      const deltaY = center.y - origin.y;

      // The candidate has to lie in the requested direction.
      const primary = dx !== 0 ? deltaX * dx : deltaY * dy;
      if (primary < 6) continue;

      // Cross-axis distance measured edge to edge, plus overlap detection.
      let cross: number;
      let overlap: boolean;
      if (dx !== 0) {
        cross = Math.max(0, Math.max(rect.top - source.bottom, source.top - rect.bottom));
        overlap = rect.bottom > source.top + 2 && rect.top < source.bottom - 2;
      } else {
        cross = Math.max(0, Math.max(rect.left - source.right, source.left - rect.right));
        overlap = rect.right > source.left + 2 && rect.left < source.right - 2;
      }

      let score = primary + cross * (overlap ? 1.9 : 3.4);
      if (!overlap) score += 26;
      // Vertical travel prefers rows that are actually on screen.
      if (dy !== 0 && !this.isOnScreen(rect)) score += 180;
      // Slight bonus for staying inside the same zone.
      const sameZone = this.zoneOf(item.el)?.id === sourceZone;
      if (sameZone) score -= 14;
      if (overlap && sameZone) score -= 10;

      if (!best || score < best.score) best = { el: item.el, score };
    }

    if (best) {
      this.setCurrent(best.el);
      return true;
    }

    // Nothing in that direction: wrap horizontally, then vertically.
    return this.wrap(direction);
  }

  /** tvOS wraps around the ends of a row and between rows. */
  private wrap(direction: Direction): boolean {
    if (!this.current) return false;
    const zone = this.zoneOf(this.current);
    if (!zone) return false;
    const all = this.collect();
    const inZone = all.filter((item) => this.zoneOf(item.el)?.id === zone.id);
    const index = inZone.findIndex((item) => item.el === this.current);
    if (index < 0) return false;

    if (direction === "left" || direction === "right") {
      const step = direction === "right" ? 1 : -1;
      const next = inZone[(index + step + inZone.length) % inZone.length];
      if (next && next.el !== this.current) {
        this.setCurrent(next.el);
        return true;
      }
      return false;
    }

    // Up / down at the edge of a list: jump to the previous / next zone.
    const zones = [...this.zones.values()]
      .filter((info) => info.layer === this.layer)
      .sort((a, b) => a.order - b.order);
    const zoneIndex = zones.findIndex((info) => info.element.contains(this.current as Node));
    if (zoneIndex < 0) return false;
    const step = direction === "down" ? 1 : -1;
    const target = zones[zoneIndex + step];
    if (!target) return false;
    const first = target.element.querySelector<HTMLElement>(".focusable");
    if (first) {
      this.setCurrent(first);
      return true;
    }
    return false;
  }

  private isOnScreen(rect: DOMRect): boolean {
    return rect.top >= -6 && rect.bottom <= window.innerHeight + 6;
  }

  /** Scroll so the focused tile is centred in its shelf and its row in view. */
  ensureVisible(el: HTMLElement): void {
    const shelf = el.closest<HTMLElement>(".shelf");
    if (shelf) {
      const rect = el.getBoundingClientRect();
      const shelfRect = shelf.getBoundingClientRect();
      const centered =
        shelf.scrollLeft + (rect.left - shelfRect.left) - (shelfRect.width - rect.width) / 2;
      shelf.scrollTo({ left: Math.max(0, centered), behavior: "smooth" });
    }

    const stage = document.getElementById("stage");
    const row = el.closest<HTMLElement>("[data-row]");
    if (stage && row) {
      const rowTop = row.offsetTop;
      const rowBottom = rowTop + row.offsetHeight;
      const viewTop = stage.scrollTop;
      const viewBottom = viewTop + stage.clientHeight;
      const fullyVisible = rowTop >= viewTop - 4 && rowBottom <= viewBottom + 4;
      if (!fullyVisible) {
        const centered = rowTop - Math.max(0, (stage.clientHeight - row.offsetHeight) / 3);
        stage.scrollTo({ top: Math.max(0, centered), behavior: "smooth" });
      }
      return;
    }
    if (!this.isOnScreen(el.getBoundingClientRect())) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  /** Total number of focusable elements in the active layer (for tests/debug). */
  get count(): number {
    return this.collect().length;
  }

  /** Snapshot of the current layer (used by the debug bar in dev builds). */
  get items(): FocusTarget[] {
    return this.collect().map((item) => ({
      el: item.el,
      zone: this.zoneOf(item.el)?.id ?? "",
      key: this.handlers.get(item.el)?.key,
    }));
  }
}

export const focusEngine = new FocusEngine();

/** Attach behaviour + a stable focus key to an element. */
export function makeFocusable(
  el: HTMLElement,
  handlers: Handlers,
  focusKey?: string,
): HTMLElement {
  if (focusKey) el.dataset.focusKey = focusKey;
  focusEngine.attach(el, { ...handlers, key: focusKey ?? handlers.key });
  return el;
}