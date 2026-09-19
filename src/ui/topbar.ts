import { sound } from "../sound";
import { store, type TabId } from "../state";
import type { Settings } from "../types";
import { el, icon } from "./icons";
import { focusEngine, makeFocusable } from "../focus/focus-engine";
import { openControlCentre } from "./control-centre";

interface TabDef {
  id: TabId;
  label: string;
  iconName: string;
}

const TABS: TabDef[] = [
  { id: "home", label: "Home", iconName: "house" },
  { id: "movies", label: "Movies", iconName: "film" },
  { id: "shows", label: "TV", iconName: "tv" },
  { id: "apps", label: "Apps", iconName: "apps" },
  { id: "search", label: "Search", iconName: "search" },
  { id: "settings", label: "Settings", iconName: "gear" },
];

/** Simple 07:45 / 07:45 PM clock text. */
function clockText(settings: Settings, now: Date): string {
  const hours = now.getHours();
  const minutes = now.getMinutes().toString().padStart(2, "0");
  if (settings.clock24h) {
    return `${hours.toString().padStart(2, "0")}:${minutes}`;
  }
  const suffix = hours >= 12 ? "PM" : "AM";
  const twelve = hours % 12 === 0 ? 12 : hours % 12;
  return `${twelve}:${minutes} ${suffix}`;
}

/**
 * The tvOS top bar: wordmark, tab row and clock. Tabs are focusable; switching
 * re-renders the stage and keeps focus on the same tab.
 */
export function renderTopbar(): void {
  const topbar = document.getElementById("topbar");
  if (!topbar) return;
  const { settings, tab } = store.state;

  const wordmark = el("div", "tv-wordmark");
  wordmark.appendChild(el("span", "tv-mark", "T"));
  wordmark.appendChild(el("span", undefined, "ube OS"));
  if (store.state.systemInfo) {
    wordmark.appendChild(el("span", "tv-sub", store.state.systemInfo.hostname));
  }
  topbar.replaceChildren(wordmark, el("div", "topbar-spacer"));

  const tabs = el("div", "topbar-tabs");
  for (const def of TABS) {
    const item = el("button", `topbar-item${tab === def.id ? " is-active" : ""}`);
    item.appendChild(icon(def.iconName, 17));
    item.appendChild(el("span", undefined, def.label));
    makeFocusable(
      item,
      {
        onFocus: () => sound.focus(),
        onActivate: () => {
          sound.select();
          document.dispatchEvent(new CustomEvent<TabId>("launcher:tab", { detail: def.id }));
        },
      },
      `tab-${def.id}`,
    );
    tabs.appendChild(item);
  }
  topbar.appendChild(tabs);
  topbar.appendChild(el("div", "topbar-spacer"));

  if (settings.showClock) {
    topbar.appendChild(el("div", "topbar-clock", clockText(settings, new Date())));
  }

  // The Control Centre pill (tvOS: the TV button's long press).
  const cc = el("button", "topbar-item");
  cc.title = "Control Centre";
  cc.appendChild(icon("control", 17));
  makeFocusable(
    cc,
    {
      onFocus: () => sound.focus(),
      onActivate: () => {
        sound.select();
        openControlCentre();
      },
    },
    "tab-control",
  );
  topbar.appendChild(cc);

  focusEngine.registerZone("topbar", topbar, 0);
}

/** Re-paint the clock once a minute (only touches text, never focus). */
export function startClock(): void {
  const tick = (): void => {
    const node = document.querySelector<HTMLElement>(".topbar-clock");
    if (node) node.textContent = clockText(store.state.settings, new Date());
  };
  window.setInterval(tick, 30_000);
}

/** Focus key of the tab that is currently active. */
export function activeTabKey(): string {
  return `tab-${store.state.tab}`;
}