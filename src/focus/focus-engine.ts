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
  private zoneCache = new WeakMap<HTMLElement, { id: string; info: ZoneInfo }>();
  private layerStack: string[] = ["home"];
  private current: HTMLElement | null = null;
  private memory = new Map<string, string>();
  private onFocusChange: ((el: HTMLElement | null) => void) | null = null;
  private delegated = false;

  constructor() {
    // One delegated listener of each kind for the whole document (see
    // `initDelegation`). The previous per-element listeners (pointerenter +
    // click + contextmenu on every focusable — ~250 across the shelves) were
    // destroyed and recreated on every re-render.
    if (typeof document !== "undefined") this.initDelegation();
  }

  private get layer(): string {
    return this.layerStack[this.layerStack.length - 1] ?? "home";
  }

  onchange(fn: (el: HTMLElement | null) => void): void {
    this.onFocusChange = fn;
  }

  attach(el: HTMLElement, handlers: Handlers): void {
    // Behaviour comes from the delegated document listeners installed in the
    // constructor; attaching only registers the element.
    if (!this.delegated && typeof document !== "undefined") this.initDelegation();
    this.handlers.set(el, handlers);
    el.classList.add("focusable");
  }

  /** Late wiring when the constructor ran before `document` existed. */
  private initDelegation(): void {
    this.delegated = true;
    document.addEventListener("pointerover", (event) => {
      const target = focusableTargetOf(event.target);
      if (target) this.focusElement(target);
    });
    document.addEventListener("click", (event) => {
      const target = focusableTargetOf(event.target);
      if (!target) return;
      event.stopPropagation();
      if (this.current !== target) {
        this.focusElement(target);
        return;
      }
      // When "Double-click to open" is configured, a single click only gives
      // focus; a second click within the window interval activates the item.
      if (target.classList.contains("tile") && event.detail === 1) {
        // We'll check the store via a custom hook or dispatch if configured
        const isDbl = target.ownerDocument?.documentElement?.dataset.doubleClick === "on";
        if (isDbl) return;
      }
      this.activate();
    });
    document.addEventListener("dblclick", (event) => {
      const target = focusableTargetOf(event.target);
      if (!target) return;
      event.stopPropagation();
      this.focusElement(target);
      this.activate();
    });
    document.addEventListener("contextmenu", (event) => {
      const target = focusableTargetOf(event.target);
      if (!target) return;
      const handler = this.handlers.get(target);
      if (!handler?.onContext) return;
      event.preventDefault();
      this.focusElement(target);
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

  /**
   * Drop every zone registered inside `root`.
   *
   * Overlays register their own zones while building; without this the map
   * keeps detached zones around forever, and a second overlay reusing the same
   * zone id (a confirm dialog on top of an info dialog) permanently overwrites
   * the one underneath — leaving that sheet with no focusable zone at all.
   */
  unregisterZonesIn(root: HTMLElement): void {
    for (const [id, info] of this.zones) {
      if (info.element === root || root.contains(info.element)) this.zones.delete(id);
    }
  }

  /**
   * Re-point focus when a re-render detached the focused element, so arrow
   * keys / Enter never act on a node that is no longer in the document.
   */
  private ensureConnected(): void {
    if (this.current && !this.current.isConnected) this.rebuild();
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
  private collect(): { el: HTMLElement; zone: ZoneInfo; zoneId: string }[] {
    const active = this.layer;
    const zones = [...this.zones.entries()]
      .filter(([, zone]) => zone.layer === active)
      .sort((a, b) => a[1].order - b[1].order);
    const out: { el: HTMLElement; zone: ZoneInfo; zoneId: string }[] = [];
    for (const [zoneId, zone] of zones) {
      if (!zone.element.isConnected) continue;
      for (const node of zone.element.querySelectorAll<HTMLElement>(".focusable")) {
        if (!node.isConnected) continue;
        const handler = this.handlers.get(node);
        if (handler?.disabled?.()) continue;
        if (node.hasAttribute("data-focus-skip")) continue;
        if (!this.isRendered(node)) continue;
        out.push({ el: node, zone, zoneId });
      }
    }
    return out;
  }

  private isRendered(el: HTMLElement): boolean {
    // Same test as before, minus the `getComputedStyle` call that forced a
    // style recalc for every candidate on every key press: a `display:none`
    // element reports an all-zero rect, and fixed-position elements (the old
    // `position !== "fixed"` escape hatch) do too have a rect.
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
    const prev = this.current;
    if (prev && prev !== el) {
      prev.classList.remove("is-focused");
      prev.removeAttribute("aria-current");
      this.handlers.get(prev)?.onBlur?.();
    }
    this.current = el;
    if (!el) {
      this.syncRowHighlight(null);
      this.onFocusChange?.(null);
      return;
    }
    el.classList.add("is-focused");
    // Expose the focused element to assistive tech and to CSS that keys off
    // `[aria-current]` in addition to `.is-focused`.
    el.setAttribute("aria-current", "true");
    this.syncRowHighlight(el);
    const handler = this.handlers.get(el);
    const zone = this.zoneOf(el);
    if (handler?.key && zone) this.memory.set(zone.id, handler.key);
    handler?.onFocus?.();
    this.ensureVisible(el);
    this.onFocusChange?.(el);
  }

  /**
   * Mirror focus onto the owning row so the active shelf reads at a glance.
   *
   * The engine already toggles `.is-focused` on the element itself; this adds
   * `.is-row-focused` to the closest `.shelf-section` (see `selection.css`),
   * giving every shelf a visible "this row owns the remote" state.
   */
  private syncRowHighlight(el: HTMLElement | null): void {
    const sections = document.querySelectorAll<HTMLElement>(".shelf-section.is-row-focused");
    for (const section of sections) {
      if (!el || !section.contains(el)) section.classList.remove("is-row-focused");
    }
    const owner = el?.closest<HTMLElement>(".shelf-section");
    if (owner && !owner.classList.contains("is-row-focused")) {
      owner.classList.add("is-row-focused");
    }
  }

  private zoneOf(el: HTMLElement): { id: string; info: ZoneInfo } | null {
    // Memoised: `move` used to walk every zone (with a `contains` ancestry
    // test per zone) for every candidate on every key press. The containment
    // re-check keeps the cache honest when elements are re-parented.
    const cached = this.zoneCache.get(el);
    if (cached && cached.info.element.contains(el)) return cached;
    let found: { id: string; info: ZoneInfo } | null = null;
    for (const [id, info] of this.zones) {
      if (info.element.contains(el)) {
        found = { id, info };
        break;
      }
    }
    if (found) this.zoneCache.set(el, found);
    else this.zoneCache.delete(el);
    return found;
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
    const items = this.collect().filter((item) => !zoneId || item.zoneId === zoneId);
    if (items.length) this.setCurrent(items[0].el);
  }

  activate(): boolean {
    this.ensureConnected();
    const handler = this.current ? this.handlers.get(this.current) : undefined;
    if (!handler?.onActivate) return false;
    handler.onActivate();
    return true;
  }

  context(): boolean {
    this.ensureConnected();
    const handler = this.current ? this.handlers.get(this.current) : undefined;
    if (!handler?.onContext) return false;
    handler.onContext();
    return true;
  }

  /** Move focus one step in a direction, tvOS style. */
  move(direction: Direction): boolean {
    this.ensureConnected();
    if (!this.current) {
      this.focusFirst();
      return Boolean(this.current);
    }
    const handler = this.handlers.get(this.current);
    if (handler?.onMove?.(direction)) return true;

    const items = this.collect();
    // One geometry pass per key press: every candidate rect is snapshotted
    // once, and each element's zone id comes straight from `collect` instead
    // of a second ancestry walk per candidate.
    const rects = new Map<HTMLElement, DOMRect>();
    for (const item of items) rects.set(item.el, item.el.getBoundingClientRect());
    const source = rects.get(this.current) ?? this.current.getBoundingClientRect();
    const origin = { x: source.left + source.width / 2, y: source.top + source.height / 2 };
    const [dx, dy] = VECTORS[direction];
    const sourceZone = this.zoneOf(this.current)?.id;

    let best: { el: HTMLElement; score: number } | null = null;
    for (const item of items) {
      if (item.el === this.current) continue;
      const rect = rects.get(item.el);
      if (!rect || rect.width === 0 || rect.height === 0) continue;
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
      // Vertical travel prefers rows that are actually on screen. Chrome zones
      // (topbar lives above the scroll stage) are always valid targets —
      // without this the top bar was unreachable from the Movies shelves.
      const isChrome = item.zoneId === "topbar" || item.zoneId === "topshelf";
      if (dy !== 0 && !isChrome && !this.isOnScreen(rect)) score += 180;
      // Slight bonus for staying inside the same zone.
      const sameZone = item.zoneId === sourceZone;
      if (sameZone) score -= 14;
      if (overlap && sameZone) score -= 10;
      // Pressing Up from a shelf should reliably surface the chrome above it:
      // the hero pills sit ~200px closer than the tab row, so give the topbar
      // a bonus that outweighs the distance gap when travelling upward.
      if (direction === "up" && item.zoneId === "topbar") score -= 420;

      if (!best || score < best.score) best = { el: item.el, score };
    }

    if (best) {
      this.setCurrent(best.el);
      return true;
    }

    // Nothing in that direction: wrap horizontally, then vertically.
    return this.wrap(direction, items);
  }

  /** tvOS wraps around the ends of a row and between rows. */
  private wrap(direction: Direction, items: { el: HTMLElement; zoneId: string }[]): boolean {
    if (!this.current) return false;
    const zone = this.zoneOf(this.current);
    if (!zone) return false;
    const inZone = items.filter((item) => item.zoneId === zone.id);
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
    // Measure against the real scroll container (#stage) rather than the
    // window: the stage sits between the top bar and the hints bar, so the
    // window-based test was ~140px off at the bottom of the screen and
    // mis-penalised the last row.
    const stage = document.getElementById("stage");
    if (stage) {
      const view = stage.getBoundingClientRect();
      return rect.top >= view.top - 6 && rect.bottom <= view.bottom + 6;
    }
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
      zone: item.zoneId,
      key: this.handlers.get(item.el)?.key,
    }));
  }
}

export const focusEngine = new FocusEngine();

/** Nearest focusable ancestor of an event target (delegated listeners). */
function focusableTargetOf(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>(".focusable");
}

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