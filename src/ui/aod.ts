/**
 * Always-On Display (tvOS style).
 *
 * After `settings.aodTimeoutMins` without any input the UI fades to a dimmed
 * ambient screen: a big clock (+ hostname and date) or a slowly panning poster
 * wall. One press of the remote (or moving the pointer) brings the launcher
 * back. Mouse input keeps resetting the timer so a machine that is actively
 * used never blanks.
 */
import { posterUrl } from "../api";
import { sound } from "../sound";
import { store } from "../state";
import { el } from "./icons";
import { hasOverlay } from "./overlay";

const FULLSCREEN_STYLES = ["clock", "clock-weather", "poster-wall"];

let state: "off" | "armed" | "on" = "off";
let timer: number | null = null;
let root: HTMLElement | null = null;
let tickHandle: number | null = null;
let hideHandle: number | null = null;

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function clockText(now: Date): string {
  const settings = store.state.settings;
  const hours = now.getHours();
  const minutes = pad(now.getMinutes());
  if (settings.clock24h) return `${pad(hours)}:${minutes}`;
  const suffix = hours >= 12 ? "PM" : "AM";
  const twelve = hours % 12 === 0 ? 12 : hours % 12;
  return `${twelve}:${minutes} ${suffix}`;
}

function dateText(now: Date): string {
  return now.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  } as Intl.DateTimeFormatOptions);
}

/** Seconds of inactivity before the AOD arms (never while typing in search). */
function timeoutSecs(): number {
  return Math.max(30, store.state.settings.aodTimeoutMins * 60);
}

function clearTimer(): void {
  if (timer !== null) {
    window.clearTimeout(timer);
    timer = null;
  }
}

function removeRoot(): void {
  if (!root) return;
  root.classList.remove("is-on");
  const node = root;
  root = null;
  window.setTimeout(() => node.remove(), 900);
}

function teardown(): void {
  clearTimer();
  if (tickHandle !== null) {
    window.clearInterval(tickHandle);
    tickHandle = null;
  }
  if (hideHandle !== null) {
    window.clearTimeout(hideHandle);
    hideHandle = null;
  }
  removeRoot();
  state = "off";
}

/** Activity from the physical keyboard / remote — dismiss instantly. */
function onActivity(event: KeyboardEvent): void {
  if (state !== "on") return;
  if (event.key === "Escape" || event.key === "Backspace") {
    // Escape/Backspace must still reach the global handler (back / close),
    // so wake quietly instead of playing the dismiss sound.
    teardown();
    schedule();
    return;
  }
  // The first key press only wakes the screen; swallow it.
  event.preventDefault();
  event.stopPropagation();
  dismiss();
}

/** Any pointer/keyboard movement delays the AOD and wakes the screen. */
function onMotion(): void {
  if (state === "on") {
    dismiss();
    return;
  }
  if (state === "armed") {
    clearTimer();
    state = "off";
    schedule();
  }
}

function schedule(): void {
  if (!store.state.settings.aodEnabled || store.state.settings.aodTimeoutMins === 0) return;
  if (state !== "off") return;
  state = "armed";
  timer = window.setTimeout(show, timeoutSecs() * 1000);
}

function dismiss(): void {
  sound.back();
  teardown();
  schedule();
}

function buildClockFace(now: Date): HTMLElement {
  const face = el("div", "aod__clock");
  face.appendChild(el("div", "aod__time", clockText(now)));
  face.appendChild(el("div", "aod__date", dateText(now)));
  face.appendChild(el("div", "aod__sub", store.state.systemInfo?.hostname ?? ""));
  return face;
}

function buildPosterWall(): HTMLElement {
  const wall = el("div", "aod__wall");
  const titles = [...store.state.recommendations];
  if (titles.length < 12) titles.push(...store.state.catalog.slice(0, 24));
  let added = 0;
  for (const item of titles) {
    const url = posterUrl(item);
    if (!url) continue;
    const tile = el("div", "aod__poster");
    tile.style.backgroundImage = `url("${url}")`;
    wall.appendChild(tile);
    added += 1;
    if (added >= 24) break;
  }
  return wall;
}

function show(): void {
  clearTimer();
  state = "on";
  if (hasOverlay()) {
    // Inside Settings or Search the AOD becomes a dimming sheet instead of a
    // full replacement so nothing underneath is lost.
    const style = "clock";
    root = el("div", "aod aod--sheet");
    root.appendChild(buildClockFace(new Date()));
    root.dataset.style = style;
  } else {
    const settings = store.state.settings;
    root = el("div", `aod`);
    root.dataset.style = FULLSCREEN_STYLES.includes(settings.aodStyle)
      ? settings.aodStyle
      : "clock";
    if (root.dataset.style === "poster-wall") {
      root.appendChild(buildPosterWall());
      root.appendChild(buildClockFace(new Date()));
    } else {
      root.appendChild(buildClockFace(new Date()));
    }
  }
  root.style.setProperty("--aod-dim", String(store.state.settings.aodDim / 100));
  document.body.appendChild(root);
  requestAnimationFrame(() => root?.classList.add("is-on"));

  // Repaint the clock text once a minute; rebuild the poster wall hourly.
  tickHandle = window.setInterval(() => {
    if (!root) return;
    const time = root.querySelector(".aod__time");
    const date = root.querySelector(".aod__date");
    const now = new Date();
    if (time) time.textContent = clockText(now);
    if (date) date.textContent = dateText(now);
  }, 30_000);

  hideHandle = window.setTimeout(() => {
    if (!root) return;
    root.classList.add("is-dimmed");
  }, 2.5 * 60 * 1000);
}

/** True while the ambient (always-on) screen is shown. */
export function isAodActive(): boolean {
  return state === "on";
}

/** Re-apply the current AOD settings to a live ambient screen, if any. */
export function refreshAod(): void {
  if (!root) return;
  root.style.setProperty("--aod-dim", String(store.state.settings.aodDim / 100));
  if (state === "on" && !root.classList.contains("aod--sheet")) {
    root.dataset.style = FULLSCREEN_STYLES.includes(store.state.settings.aodStyle)
      ? store.state.settings.aodStyle
      : "clock";
  }
}

/** Start listening; called once from `boot()`. */
export function initAod(): void {
  if (state !== "off") return;
  document.addEventListener("keydown", onActivity, true);
  document.addEventListener("pointermove", onMotion, true);
  document.addEventListener("pointerdown", onMotion, true);
  schedule();
}

/** Tear everything down (used before quitting). */
export function shutdownAod(): void {
  teardown();
}

/** Test hook: force the ambient screen immediately. */
export function previewAod(): void {
  if (state === "on") return;
  clearTimer();
  show();
}

