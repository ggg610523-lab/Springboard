/**
 * Deterministic colours. The real tvOS home screen tints the whole backdrop
 * with the colours of the focused item; we derive stable, Apple-flavoured
 * gradient pairs from the item's identity instead of sampling pixels, so the
 * wash never flickers while scrolling.
 */

import { store } from "./state";
import { sound } from "./sound";
import type { Settings } from "./types";

export function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Gradient pairs sampled from Apple's tvOS screensaver palette. */
const GRADIENTS: [string, string][] = [
  ["#1b3a6b", "#0a1224"],
  ["#4a1d5c", "#150a20"],
  ["#0f4a44", "#061a1c"],
  ["#6b2f18", "#200d08"],
  ["#243a76", "#0b1020"],
  ["#5c2440", "#1b0a14"],
  ["#123f5c", "#07131c"],
  ["#3f2a6b", "#120b20"],
  ["#14483a", "#06170f"],
  ["#5a3a12", "#1c1105"],
  ["#2a2a34", "#0a0a0e"],
  ["#3d1f2b", "#13080c"],
];

/** Two-colour wash for the backdrop, keyed by app id or title. */
export function washFor(seed: string): { a: string; b: string } {
  const [a, b] = GRADIENTS[hashString(seed) % GRADIENTS.length];
  return { a, b };
}

/** CSS fallbacks of `#backdrop-wash` (kept in sync with base.css). */
const WASH_DEFAULT_A = "#1b2a4a";
const WASH_DEFAULT_B = "#2a1636";
/** Must match the `opacity 700ms` fade of `#backdrop-wash::after`. */
const WASH_FADE_MS = 760;

let washCommitTimer: number | null = null;

/**
 * Push new backdrop wash colours with a compositor-only cross-fade.
 *
 * The wash used to be one element whose `background` shorthand was
 * transitioned for 900ms — a full-screen radial-gradient repaint running on
 * the main thread on every focus change. Now the incoming colours land on the
 * top pseudo-layer (`--wash-a-2`/`--wash-b-2`) which fades in via `opacity`
 * alone; when the fade completes the colours are committed to the base layer
 * and the top layer fades back out over identical colours (invisible).
 */
export function setBodyWash(a: string, b: string): void {
  const body = document.body;
  const idle = washCommitTimer === null;
  if (idle && body.style.getPropertyValue("--wash-a") === a && body.style.getPropertyValue("--wash-b") === b) {
    return;
  }

  body.style.setProperty("--wash-a-2", a);
  body.style.setProperty("--wash-b-2", b);
  document.getElementById("backdrop-wash")?.classList.add("is-crossfading");

  if (washCommitTimer !== null) window.clearTimeout(washCommitTimer);
  washCommitTimer = window.setTimeout(() => {
    washCommitTimer = null;
    const incomingA = body.style.getPropertyValue("--wash-a-2");
    const incomingB = body.style.getPropertyValue("--wash-b-2");
    body.style.setProperty("--wash-a", incomingA || WASH_DEFAULT_A);
    body.style.setProperty("--wash-b", incomingB || WASH_DEFAULT_B);
    document.getElementById("backdrop-wash")?.classList.remove("is-crossfading");
  }, WASH_FADE_MS);
}

/** Accent colour used for badges and highlights of a specific item. */
const ACCENTS = [
  "#0a84ff",
  "#ff375f",
  "#30d158",
  "#ff9f0a",
  "#bf5af2",
  "#64d2ff",
  "#ffd60a",
  "#ff6482",
];

export function accentFor(seed: string): string {
  return ACCENTS[hashString(seed) % ACCENTS.length];
}

/** Readable initials for tiles without artwork. */
export function initialsFor(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

/** Genre chips used by the recommendation shelves. */
export const GENRE_TINTS: Record<string, string> = {
  Action: "#ff453a",
  Adventure: "#ff9f0a",
  Animation: "#ffd60a",
  Comedy: "#ffcc00",
  Crime: "#8e8e93",
  Documentary: "#64d2ff",
  Drama: "#bf5af2",
  Family: "#30d158",
  Fantasy: "#da8fff",
  History: "#c7a17a",
  Horror: "#ff375f",
  Mystery: "#5e5ce6",
  Romance: "#ff6482",
  "Sci-Fi": "#0a84ff",
  Thriller: "#48484a",
  War: "#a2845e",
  Western: "#e0a458",
  Saved: "#ffffff",
};

export function genreTint(genre: string): string {
  return GENRE_TINTS[genre] ?? accentFor(genre);
}

// ── Settings → DOM bridge ───────────────────────────────────────────────────

/** Pixel width for each tile size setting. */
const TILE_SIZES: Record<Settings["tileSize"], number> = {
  small: 120,
  medium: 168,
  large: 210,
};

/** Matches `--shelf-padding` in tokens.css. */
const SHELF_PADDING = 46;
/** Never shrink a tile below this, whatever "Apps per row" asks for. */
const MIN_TILE = 96;

/**
 * Effective tile width.
 *
 * `tileSize` picks the preferred size and `iconsPerRow` ("Apps per row") caps
 * it so the requested number of tiles actually fits the window — the setting
 * used to be stored and never read, so it did nothing at all.
 */
function tileSizeFor(settings: Settings): number {
  const base = TILE_SIZES[settings.tileSize] ?? TILE_SIZES.medium;
  const perRow = Math.max(1, Math.min(16, settings.iconsPerRow || 7));
  const gap = Math.max(0, settings.rowSpacing);
  const usable = window.innerWidth - SHELF_PADDING * 2 - (perRow - 1) * gap;
  const fit = Math.floor(usable / perRow);
  return Math.max(MIN_TILE, Math.min(base, fit));
}

/** Custom backdrop image (Settings → Appearance → Backdrop). */
function applyBackdropImage(settings: Settings): void {
  const layer = document.getElementById("backdrop-image");
  if (!layer) return;
  const path = settings.backgroundImage;
  if (settings.backgroundStyle !== "image" || !path) {
    layer.classList.remove("is-visible");
    layer.style.backgroundImage = "";
    return;
  }
  // `appicon://` resolves absolute paths verbatim (see icons.rs → resolve()).
  layer.style.backgroundImage = `url("appicon://localhost/?n=${encodeURIComponent(path)}")`;
  layer.classList.add("is-visible");
}

/** Push theme, accent and layout tokens from the settings into the DOM. */
export function applyTheme(): void {
  const { settings } = store.state;
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  root.dataset.animations = settings.animations ? "on" : "off";
  root.dataset.doubleClick = settings.doubleClickToOpen ? "on" : "off";
  // The "Interface sounds" toggle lives in Settings but was never forwarded to
  // the sound engine — only Control Centre's "Quiet mode" did that.
  sound.setEnabled(settings.soundEffects);
  root.style.setProperty("--accent", settings.accent);
  root.style.setProperty("--corner-radius", `${settings.cornerRadius}px`);
  root.style.setProperty("--row-gap", `${settings.rowSpacing}px`);
  root.style.setProperty("--backdrop-blur", `${settings.backgroundBlur}px`);
  root.style.setProperty("--backdrop-dim", (settings.backgroundDim / 100).toFixed(2));

  const size = tileSizeFor(settings);
  root.style.setProperty("--tile-size", `${size}px`);
  root.style.setProperty("--poster-width", `${Math.round(size * 1.05)}px`);

  // "solid" pins the wash to black; every other style hands the backdrop back
  // to the CSS defaults (or the focused item, via `setBodyWash`).
  if (settings.backgroundStyle === "solid") {
    setBodyWash("#000000", "#000000");
  } else {
    setBodyWash(WASH_DEFAULT_A, WASH_DEFAULT_B);
  }
  applyBackdropImage(settings);
}

/** Re-fit the tiles when the window is resized ("Apps per row" depends on it). */
if (typeof window !== "undefined") {
  let resizeTimer: number | null = null;
  window.addEventListener("resize", () => {
    if (resizeTimer !== null) window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      resizeTimer = null;
      applyTheme();
    }, 120);
  });
}