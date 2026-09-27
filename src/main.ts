import { api } from "./api";
import { focusEngine } from "./focus/focus-engine";
import { applyTheme } from "./palette";
import { sound } from "./sound";
import { actions, selectTab, store, type TabId } from "./state";
import type { AppInfo, MediaItem } from "./types";
import "./styles/index.css";
import { el } from "./ui/icons";
import { showDialog } from "./ui/dialog";
import { renderHero, setHeroForElement, startHeroRotation } from "./ui/hero";
import { initGamepad } from "./gamepad";
import { renderHints } from "./ui/hints";
import { closeTopOverlay, hasOverlay } from "./ui/overlay";
import { openSearch, isSearchOpen, handleSearchKey } from "./ui/search";
import { openControlCentre } from "./ui/control-centre";
import { openSettings } from "./ui/settings";
import { startSplash, hideSplash } from "./ui/splash";
import { renderShelves } from "./ui/shelves";
import { launchApp, openMedia, playOnPicker } from "./ui/tiles";
import { renderTopbar, startClock } from "./ui/topbar";
import { initAod, refreshAod } from "./ui/aod";

/** Repaint every chrome region after settings or data changed. */
function refreshChrome(): void {
  applyTheme();
  renderTopbar();
  renderHero();
  renderShelves();
  renderHints();
  refreshAod();
  focusEngine.rebuild("topbar");
}

/** Details sheet for an app tile (I key). */
function openAppInfo(app: AppInfo): void {
  showDialog({
    title: app.name,
    body: "Launch this application?",
    returnKey: `tile-${app.id}`,
    actions: [
      { label: "Open", primary: true, onSelect: () => launchApp(app) },
      { label: "Cancel", onSelect: () => undefined },
    ],
  });
}

/** Details sheet for a recommended title (I key). */
function openTitleInfo(item: MediaItem): void {
  showDialog({
    title: item.title,
    body: [item.kind, item.year, item.stars].filter((part) => part && part.length > 0).join(" · "),
    returnKey: `tile-${item.id}`,
    actions: [
      { label: "Open", primary: true, onSelect: () => openMedia(item) },
      { label: "Play on…", onSelect: () => playOnPicker(item, `tile-${item.id}`) },
      { label: "Like", onSelect: () => void actions.feedback(item, "like") },
      { label: "Hide", onSelect: () => void actions.feedback(item, "hide") },
      { label: "Cancel", onSelect: () => undefined },
    ],
  });
}

/** Show the details sheet for whatever tile is focused. */
function infoForFocused(): void {
  const focused = document.activeElement as HTMLElement | null;
  const appId = focused?.closest<HTMLElement>("[data-app-id]")?.dataset.appId;
  if (appId) {
    const app = store.state.apps.find((entry) => entry.id === appId);
    if (app) openAppInfo(app);
    return;
  }
  const mediaId = focused?.closest<HTMLElement>("[data-media-id]")?.dataset.mediaId;
  if (mediaId) {
    const item = [...store.state.recommendations, ...store.state.catalog].find(
      (entry) => entry.id === mediaId,
    );
    if (item) openTitleInfo(item);
  }
}

/** Toggle the system mute state and mirror it into the store. */
async function toggleMute(): Promise<void> {
  try {
    await api.audioCommand("volume-mute");
    const [volume, muted] = await api.getAudio();
    store.set({ audio: { volume, muted } });
  } catch {
    /* the backend toasts failures itself */
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const key = event.key;

  // While search is open, printable keys and Backspace type into the field
  // instead of doing anything else.
  if (hasOverlay() && isSearchOpen() && handleSearchKey(key)) {
    event.preventDefault();
    return;
  }

  // Back / close always works, overlay or not.
  if (key === "Escape" || key === "Backspace") {
    if (hasOverlay()) closeTopOverlay();
    else sound.back();
    event.preventDefault();
    return;
  }

  if (hasOverlay()) {
    switch (key) {
      case "ArrowUp":
        focusEngine.move("up");
        break;
      case "ArrowDown":
        focusEngine.move("down");
        break;
      case "ArrowLeft":
        focusEngine.move("left");
        break;
      case "ArrowRight":
        focusEngine.move("right");
        break;
      case "Enter":
        focusEngine.activate();
        break;
      default:
        return;
    }
    event.preventDefault();
    return;
  }

  switch (key) {
    case "ArrowUp":
      if (focusEngine.move("up")) sound.focus();
      break;
    case "ArrowDown":
      if (focusEngine.move("down")) sound.focus();
      break;
    case "ArrowLeft":
      if (focusEngine.move("left")) sound.focus();
      break;
    case "ArrowRight":
      if (focusEngine.move("right")) sound.focus();
      break;
    case "Enter":
      if (focusEngine.activate()) sound.select();
      break;
    case "i":
    case "I":
      infoForFocused();
      break;
    case "m":
    case "M":
      void toggleMute();
      break;
    case "s":
    case "S":
      openSettings();
      break;
    case "c":
    case "C":
      openControlCentre();
      break;
    default:
      return;
  }
  event.preventDefault();
}

function wireEvents(): void {
  document.addEventListener("keydown", onKeydown);

  // The Top Shelf mirrors whatever tile has focus (hero.ts owns the content).
  focusEngine.onchange((element) => setHeroForElement(element));

  document.addEventListener("launcher:tab", (event) => {
    const id = (event as CustomEvent<TabId>).detail;
    if (id === "search") {
      openSearch();
      return;
    }
    if (id === "settings") {
      openSettings();
      return;
    }
    selectTab(id);
    refreshChrome();
    focusEngine.focusFirst("topbar");
  });

  // The brand hero offers a "Open Settings" pill.
  document.addEventListener("launcher:open-settings", () => openSettings());
}

async function boot(): Promise<void> {
  // The 10s splash sits on top while the app preloads its data, so the home
  // screen paints fully (and the media catalogue finishes fetching) behind it.
  const splash = startSplash();
  await Promise.all([actions.bootstrap(), splash]);
  hideSplash();
  wireEvents();
  refreshChrome();
  focusEngine.focusFirst("topbar");
  startClock();
  startHeroRotation();
  initGamepad();
  initAod();

  await api
    .onAppsScanned((apps) => {
      store.set({ apps });
      refreshChrome();
    })
    .catch(() => undefined);
  await api
    .onLaunchResult((result) => {
      if (!result.ok) sound.error();
    })
    .catch(() => undefined);
}

/** Last-resort paint if booting fails: never leave a black screen. */
function showBootError(error: unknown): void {
  console.error("boot failed", error);
  hideSplash();
  const stage = document.getElementById("rows");
  const topbar = document.getElementById("topbar");
  if (topbar) topbar.replaceChildren();
  if (stage) {
    const card = el("div", "boot-error");
    card.appendChild(el("h1", undefined, "The launcher could not start"));
    card.appendChild(el("p", undefined, String(error)));
    stage.replaceChildren(card);
  }
}

boot().catch(showBootError);
