/**
 * A small SF Symbols flavoured icon set. Everything is inline SVG so the
 * launcher needs no icon font and icons inherit `currentColor`.
 */

type IconDef = { path: string; filled?: boolean; viewBox?: string };

const ICONS: Record<string, IconDef> = {
  search: {
    path: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 4.5 4.5",
  },
  gear: {
    path:
      "M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Zm8-3.2c0 .6-.07 1.1-.2 1.6l2 1.5-2 3.4-2.4-.9c-.8.6-1.7 1.1-2.7 1.4l-.4 2.5h-4l-.4-2.5c-1-.3-1.9-.8-2.7-1.4l-2.4.9-2-3.4 2-1.5a8.7 8.7 0 0 1 0-3.2l-2-1.5 2-3.4 2.4.9c.8-.6 1.7-1.1 2.7-1.4L9.7 1h4l.4 2.5c1 .3 1.9.8 2.7 1.4l2.4-.9 2 3.4-2 1.5c.13.5.2 1 .2 1.6Z",
  },
  play: { path: "M7 4.5v15l13-7.5-13-7.5Z", filled: true },
  heart: {
    path:
      "M12 20.3 4.7 13a4.6 4.6 0 0 1 6.5-6.5l.8.8.8-.8A4.6 4.6 0 0 1 19.3 13Z",
  },
  star: {
    path: "m12 3.6 2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8L3.5 9.8l5.9-.9Z",
    filled: true,
  },
  ban: { path: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Zm-5.6 3 11.1 11.1" },
  shuffle: { path: "M4 6h3l9 12h4m0 0-2.5-2.5M20 18l-2.5 2.5M4 18h3l3-4M14 8.5 15.5 6H20m0 0-2.5-2.5M20 6l-2.5 2.5" },
  check: { path: "m5 12.5 4.5 4.5L19 7" },
  close: { path: "M6 6l12 12M18 6 6 18" },
  chevronRight: { path: "m9 5 7 7-7 7" },
  chevronLeft: { path: "m15 5-7 7 7 7" },
  info: { path: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Zm0 7.5v5m0-8.6v.1" },
  grid: { path: "M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h6v6h-6v-6Z" },
  film: {
    path:
      "M4 5h16v14H4V5Zm4 0v14M16 5v14M4 9h4M4 15h4M16 9h4M16 15h4",
  },
  tv: { path: "M3 7h18v11H3V7Zm5 15h8" },
  house: { path: "m4 11 8-6.5 8 6.5v9H4v-9Zm5.5 9v-5h5v5" },
  power: { path: "M12 3v8m5.7-5.5a8 8 0 1 1-11.4 0" },
  refresh: { path: "M20 12a8 8 0 1 1-2.6-5.9M20 4v4h-4" },
  folder: { path: "M3.5 6.5h6l1.8 2.2h9.2v9.8h-17V6.5Z" },
  external: { path: "M14 4h6v6m0-6-8 8M18 14v6H4V6h6" },
  eye: { path: "M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12Zm9.5 2.3a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6Z" },
  eyeSlash: { path: "M4 4l16 16M9.9 5.2A9.7 9.7 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-2.5 3.5M6.5 7.3A16.6 16.6 0 0 0 2.5 12S6 19 12 19c1.2 0 2.2-.2 3.2-.5" },
  sparkles: {
    path: "m12 4 1.7 4.6L18.5 10l-4.8 1.4L12 16l-1.7-4.6L5.5 10l4.8-1.4L12 4Zm6.5 9.5.9 2.3 2.1.7-2.1.7-.9 2.3-.9-2.3-2.1-.7 2.1-.7.9-2.3Z",
  },
  clock: { path: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM12 8v4.6l3 1.9" },
  volume: { path: "M4 9.5h3l4-3.5v12l-4-3.5H4v-5Zm12-1.5a5 5 0 0 1 0 8M18.5 5.5a8.5 8.5 0 0 1 0 13" },
  volumeMute: { path: "M4 9.5h3l4-3.5v12l-4-3.5H4v-5Zm11.5-.5 5 5m0-5-5 5" },
  trash: { path: "M5 7h14M10 7V5h4v2m-8 0 1 13h10l1-13M10 11v6m4-6v6" },
  plus: { path: "M12 5v14M5 12h14" },
  minus: { path: "M5 12h14" },
  arrowUp: { path: "m5 15 7-7 7 7" },
  keyboard: { path: "M3 6h18v12H3V6Zm3 4h.01M9 10h.01M12 10h.01M15 10h.01M18 10h.01M7 14h10" },
  lock: { path: "M6 11h12v9H6v-9Zm3 0V8a3 3 0 0 1 6 0v3" },
  sleep: { path: "M4 15h6l2-3M10 19h5l3-4" },
  logout: { path: "M15 5H5v14h10m-3-7h9m0 0-3-3m3 3-3 3" },
  reboot: { path: "M12 4v7m5.5-2.5a7.5 7.5 0 1 1-11 0" },
  shutdown: { path: "M12 4v7m5.5-2.5a7.5 7.5 0 1 1-11 0" },
  apps: { path: "M4 4h7v7H4V4Zm9 0h7v7h-7V4ZM4 13h7v7H4v-7Zm9 0h7v7h-7v-7Z" },
  recommend: { path: "m12 4 2 5 5 1.5-4 3.6.8 5.4L12 16.8 8.2 19.5 9 14.1 5 10.5 10 9l2-5Z" },
  panel: { path: "M4 5h16v14H4V5Zm6 0v14" },
  control: { path: "M4 6h16M13 3v6M4 12h16M8 9v6M4 18h16M16 15v6" },
};

export type IconName = keyof typeof ICONS;

/** Create an inline SVG icon element. */
export function icon(name: string, size = 18): SVGSVGElement {
  const def = ICONS[name] ?? ICONS.info;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", def.path);
  if (def.filled) {
    path.setAttribute("fill", "currentColor");
  } else {
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.7");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
  }
  svg.appendChild(path);
  return svg;
}

/** Convenience element factory with class names and text. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}