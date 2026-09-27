import { focusEngine } from "../focus/focus-engine";
import { sound } from "../sound";
import { el } from "./icons";

interface OverlayOptions {
  /** Focus layer name; the engine only navigates inside the top layer. */
  layer?: string;
  /** Extra class for the overlay wrapper. */
  className?: string;
  /** Build the contents. The wrapper is already mounted. */
  build: (root: HTMLElement, helpers: { close: () => void }) => void;
  /** Key of the element that should regain focus once closed. */
  returnKey?: string;
  /** Called once the close animation finished. */
  onClose?: () => void;
}

interface OverlayHandle {
  root: HTMLElement;
  close: () => void;
}

const stack: OverlayHandle[] = [];

function container(): HTMLElement {
  let node = document.getElementById("overlays");
  if (!node) {
    node = el("div");
    node.id = "overlays";
    document.body.appendChild(node);
  }
  return node;
}

/** Open a centred overlay panel and take over focus navigation. */
export function openOverlay(options: OverlayOptions): OverlayHandle {
  const layer = options.layer ?? "overlay";
  const root = el("div", `overlay${options.className ? ` ${options.className}` : ""}`);
  container().appendChild(root);

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    root.classList.remove("is-open");
    window.setTimeout(() => {
      root.remove();
      focusEngine.popLayer(layer);
      const index = stack.findIndex((handle) => handle.root === root);
      if (index >= 0) stack.splice(index, 1);
      const previous = stack[index - 1];
      if (previous) {
        focusEngine.rebuild(options.returnKey);
      } else if (options.returnKey) {
        focusEngine.rebuild(options.returnKey);
      } else {
        focusEngine.rebuild();
      }
      options.onClose?.();
    }, 200);
  };

  focusEngine.pushLayer(layer);
  options.build(root, { close });

  // Animate in on the next frame so the transition runs.
  requestAnimationFrame(() => root.classList.add("is-open"));
  focusEngine.rebuild();

  const handle: OverlayHandle = { root, close };
  stack.push(handle);
  return handle;
}

/** True when at least one overlay is open. */
export function hasOverlay(): boolean {
  return stack.length > 0;
}

/** Close the topmost overlay; returns true when something was closed. */
export function closeTopOverlay(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  sound.back();
  top.close();
  return true;
}

/** Close every open overlay (used when switching tabs). */
export function closeAllOverlays(): void {
  while (stack.length) stack[stack.length - 1].close();
}

/** The overlay wrapper currently on top, if any. */
export function topOverlay(): HTMLElement | null {
  return stack.length ? stack[stack.length - 1].root : null;
}

/** Small centred toast notification. */
export function toast(
  message: string,
  kind: "info" | "ok" | "error" = "info",
  iconName?: string,
): void {
  const root = container();
  let box = root.querySelector<HTMLElement>(".toast-stack");
  if (!box) {
    box = el("div", "toast-stack");
    root.appendChild(box);
  }
  const node = el("div", `toast${kind === "info" ? "" : ` toast--${kind}`}`);
  if (kind !== "info" || iconName) {
    node.appendChild(iconFrom(iconName ?? (kind === "error" ? "info" : "check")));
  }
  node.appendChild(el("span", undefined, message));
  box.appendChild(node);
  window.setTimeout(() => {
    node.classList.add("is-leaving");
    window.setTimeout(() => node.remove(), 240);
  }, kind === "error" ? 5200 : 2600);
}

function iconFrom(name: string): SVGSVGElement {
  // Imported lazily to avoid a circular import at module init time.
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", name === "check" ? "m5 12.5 4.5 4.5L19 7" : "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Zm0 7.5v5m0-8.6v.1");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.8");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  return svg;
}