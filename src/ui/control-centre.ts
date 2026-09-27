/**
 * tvOS 17 style Control Centre: a compact panel that drops from the top of the
 * screen with three tabs — Profiles, quick Controls and System power. It is
 * opened with the C key, the Control Centre pill in the top bar, or R3 on a
 * gamepad, and closed with Esc / Back / tapping the scrim.
 *
 *   Profiles  device info, install stats, deep link to Settings
 *   Controls  volume + mute, Do Not Disturb, sleep timer
 *   System    rescan, suspend / lock / display off, logout / reboot / shut down
 */
import { api } from "../api";
import { focusEngine, makeFocusable } from "../focus/focus-engine";
import { sound } from "../sound";
import { actions, store } from "../state";
import { el, icon } from "./icons";
import { showDialog } from "./dialog";
import { hasOverlay, openOverlay, toast } from "./overlay";

type CcTab = "profile" | "controls" | "system";

const TABS: { id: CcTab; label: string; iconName: string }[] = [
  { id: "profile", label: "Profiles", iconName: "recommend" },
  { id: "controls", label: "Controls", iconName: "control" },
  { id: "system", label: "System", iconName: "power" },
];

const SLEEP_OPTIONS: [number, string][] = [
  [0, "Off"],
  [15, "15 min"],
  [30, "30 min"],
  [60, "1 hour"],
  [90, "90 min"],
];

/** Currently mounted panel pieces, refreshed on the fly as settings change. */
let content: HTMLElement | null = null;
let ccRoot: HTMLElement | null = null;
let closeOverlay: (() => void) | null = null;
const tabNodes = new Map<string, HTMLElement>();
let activeTab: CcTab = "controls";

let volFill: HTMLElement | null = null;
let volPct: HTMLElement | null = null;
let muteSwitch: HTMLElement | null = null;
let timerText: HTMLElement | null = null;

/** Sleep timer state survives the panel closing, like a real remote. */
let activeSleep = 0;
let sleepUntil = 0;
let sleepHandle: number | null = null;

function groupTitle(node: HTMLElement, text: string): void {
  node.appendChild(el("div", "cc-group", text));
}

/** A focusable tvOS row with an icon, a label and an optional hint. */
function actionRow(
  label: string,
  hint: string | null,
  iconName: string,
  key: string,
  fn: () => void,
  danger = false,
): HTMLElement {
  const row = el("div", `cc-row${danger ? " cc-row--danger" : ""}`);
  row.appendChild(icon(iconName, 18));
  const text = el("div", "cc-label");
  text.appendChild(el("span", undefined, label));
  if (hint) text.appendChild(el("span", "settings-hint", hint));
  row.appendChild(text);
  makeFocusable(
    row,
    {
      onFocus: () => sound.focus(),
      onActivate: () => {
        sound.select();
        fn();
      },
    },
    key,
  );
  return row;
}

/** A focusable tvOS toggle row with the shared iOS switch. */
function switchRowCC(
  label: string,
  hint: string | null,
  iconName: string,
  key: string,
  isOn: () => boolean,
  onToggle: (next: boolean) => void,
): HTMLElement {
  const row = el("div", "cc-row");
  row.appendChild(icon(iconName, 18));
  const text = el("div", "cc-label");
  text.appendChild(el("span", undefined, label));
  if (hint) text.appendChild(el("span", "settings-hint", hint));
  row.appendChild(text);
  const toggle = el("div", `switch${isOn() ? " is-on" : ""}`);
  row.appendChild(toggle);
  makeFocusable(
    row,
    {
      onFocus: () => sound.focus(),
      onActivate: () => {
        sound.toggle();
        const next = !isOn();
        toggle.classList.toggle("is-on", next);
        onToggle(next);
      },
    },
    key,
  );
  return row;
}

/* ── Profiles tab ───────────────────────────────────────────────────────── */
function buildProfile(node: HTMLElement): void {
  node.appendChild(el("div", "cc-head", "Profiles"));
  node.appendChild(el("div", "cc-sub", "Who's using this Apple TV."));

  const info = store.state.systemInfo;
  const name = info?.hostname ?? "This device";
  const user = el("div", "cc-user");
  const avatar = el("div", "cc-user__avatar", (name.trim()[0] || "?").toUpperCase());
  user.appendChild(avatar);
  const meta = el("div");
  meta.appendChild(el("div", "cc-user__name", name));
  meta.appendChild(el("div", "cc-user__note", "Guest profile · host console"));
  user.appendChild(meta);
  node.appendChild(user);

  groupTitle(node, "Device");
  const stats = el("div", "settings-stats");
  const cards: [string, string, string][] = [
    ["Apps", String(info?.appCount ?? store.state.apps.length), "installed"],
    ["Launcher", info?.launcherVersion ? `v${info.launcherVersion}` : "—", store.state.settings.schema ? "current schema" : ""],
    ["OS", info?.os ?? "—", ""],
    ["Session", info?.sessionType ?? "—", ""],
    ["Desktop", info?.desktop ?? "—", ""],
    ["Icon themes", String(info?.iconThemes.length ?? 0), "available"],
  ];
  for (const [label, value, note] of cards) {
    const card = el("div", "stat-card");
    card.appendChild(el("div", "stat-card__label", label));
    card.appendChild(el("div", "stat-card__value", value));
    if (note) card.appendChild(el("div", "stat-card__note", note));
    stats.appendChild(card);
  }
  node.appendChild(stats);

  groupTitle(node, "More");
  node.appendChild(
    actionRow(
      "Open Settings",
      "Full launcher configuration.",
      "gear",
      "cc-profile-settings",
      () => {
        document.dispatchEvent(
          new CustomEvent<"settings">("launcher:tab", { detail: "settings", bubbles: true }),
        );
      },
    ),
  );
}

/* ── Controls tab ───────────────────────────────────────────────────────── */
function changeVolume(direction: 1 | -1): void {
  void api
    .audioCommand(direction === 1 ? "volume-up" : "volume-down")
    .then(() => api.getAudio())
    .then(([volume, muted]) => {
      store.set({ audio: { volume, muted } });
      syncVolumeUi();
    })
    .catch(() => undefined);
}

function toggleMute(): void {
  void api
    .audioCommand("volume-mute")
    .then(() => api.getAudio())
    .then(([volume, muted]) => {
      store.set({ audio: { volume, muted } });
      syncVolumeUi();
    })
    .catch(() => undefined);
}

function syncVolumeUi(): void {
  const stored = store.state.audio.volume ?? store.state.settings.volume;
  const volume = Math.max(0, Math.min(100, stored));
  if (volFill) volFill.style.width = `${volume}%`;
  if (volPct) volPct.textContent = `${Math.round(volume)}%`;
  if (muteSwitch) muteSwitch.classList.toggle("is-on", Boolean(store.state.audio.muted));
}

function buildControls(node: HTMLElement): void {
  node.appendChild(el("div", "cc-head", "Controls"));
  node.appendChild(el("div", "cc-sub", "Audio and quiet time."));

  groupTitle(node, "Audio");
  const volume = el("div", "cc-row");
  volume.appendChild(icon("volume", 18));
  volume.appendChild(el("div", "cc-label", "Volume"));
  const minus = el("button", "cc-btn", "−");
  makeFocusable(
    minus,
    {
      onFocus: () => sound.focus(),
      onActivate: () => changeVolume(-1),
    },
    "cc-vol-down",
  );
  volume.appendChild(minus);
  const track = el("div", "cc-track");
  volFill = el("div", "cc-track__fill");
  track.appendChild(volFill);
  volume.appendChild(track);
  const plus = el("button", "cc-btn", "+");
  makeFocusable(
    plus,
    {
      onFocus: () => sound.focus(),
      onActivate: () => changeVolume(1),
    },
    "cc-vol-up",
  );
  volume.appendChild(plus);
  volPct = el("div", "cc-value", "");
  volume.appendChild(volPct);
  node.appendChild(volume);

  const rowMute = el("div", "cc-row");
  rowMute.appendChild(icon("volumeMute", 18));
  rowMute.appendChild(el("div", "cc-label", "Mute"));
  muteSwitch = el("div", `switch${store.state.audio.muted ? " is-on" : ""}`);
  rowMute.appendChild(muteSwitch);
  makeFocusable(
    rowMute,
    {
      onFocus: () => sound.focus(),
      onActivate: () => {
        sound.toggle();
        toggleMute();
      },
    },
    "cc-mute",
  );
  node.appendChild(rowMute);
  syncVolumeUi();

  groupTitle(node, "Do Not Disturb");
  node.appendChild(
    switchRowCC(
      "Quiet mode",
      "Mutes the interface sounds while it's on.",
      "sleep",
      "cc-dnd",
      () => store.state.settings.soundEffects,
      (next) => {
        sound.setEnabled(next);
        actions.patchSettings({ soundEffects: next });
        toast(next ? "Do Not Disturb off" : "Do Not Disturb on", "ok");
      },
    ),
  );

  groupTitle(node, "Sleep Timer");
  const timerRow = el("div", "cc-row");
  timerRow.appendChild(icon("clock", 18));
  timerRow.appendChild(el("div", "cc-label", "Sleep timer"));
  timerText = el("div", "cc-timer", timerNow());
  timerRow.appendChild(timerText);
  node.appendChild(timerRow);

  const chips = el("div", "cc-chips");
  for (const [minutes, label] of SLEEP_OPTIONS) {
    const chip = el("button", `chip${activeSleep === minutes ? " is-on" : ""}`, label);
    makeFocusable(
      chip,
      {
        onFocus: () => sound.focus(),
        onActivate: () => {
          sound.select();
          setSleepTimer(minutes);
        },
      },
      `cc-sleep-${minutes}`,
    );
    chips.appendChild(chip);
  }
  node.appendChild(chips);
}

function timerNow(): string {
  if (!activeSleep) return "Off";
  const left = Math.max(0, sleepUntil - Date.now());
  const minutes = Math.floor(left / 60000);
  const seconds = Math.floor((left % 60000) / 1000);
  return `Sleeping in ${minutes}:${String(seconds).padStart(2, "0")}`;
}

function syncTimerText(): void {
  if (timerText) timerText.textContent = timerNow();
}

function setSleepTimer(minutes: number): void {
  clearSleepHandle();
  activeSleep = minutes;
  if (minutes > 0) {
    sleepUntil = Date.now() + minutes * 60_000;
    sleepHandle = window.setInterval(handleSleepTick, 1000);
    toast(`Sleeping in ${minutes} minutes`, "ok");
  } else {
    toast("Sleep timer off", "ok");
  }
  syncTimerText();
  const chips = document.querySelectorAll<HTMLElement>(".cc-chips .chip");
  chips.forEach((chip, index) => chip.classList.toggle("is-on", SLEEP_OPTIONS[index]?.[0] === minutes));
}

function handleSleepTick(): void {
  if (sleepUntil - Date.now() <= 0) {
    clearSleepHandle();
    activeSleep = 0;
    syncTimerText();
    toast("Sleeping…", "ok");
    void api.audioCommand("suspend").catch((error: unknown) => toast(String(error), "error"));
    return;
  }
  syncTimerText();
}

function clearSleepHandle(): void {
  if (sleepHandle !== null) {
    window.clearInterval(sleepHandle);
    sleepHandle = null;
  }
}

/* ── System tab ─────────────────────────────────────────────────────────── */
function fire(action: string): void {
  void api
    .audioCommand(action)
    .then((message) => {
      if (message) toast(message, "ok");
    })
    .catch((error: unknown) => toast(String(error), "error"));
}

function confirmPower(action: string, title: string, label: string, returnKey: string): void {
  showDialog({
    title,
    body: "Do you want to continue? The launcher will close right after.",
    actions: [
      { label: "Cancel", onSelect: () => undefined },
      { label, primary: true, onSelect: () => fire(action) },
    ],
    returnKey,
  });
}

async function rescanApps(): Promise<void> {
  toast("Rescanning apps…");
  try {
    await actions.refreshApps();
    toast(`${store.state.apps.length} apps found`, "ok");
    rerender();
  } catch (error) {
    toast(String(error), "error");
  }
}

function buildSystem(node: HTMLElement): void {
  node.appendChild(el("div", "cc-head", "System"));
  node.appendChild(el("div", "cc-sub", "Power and maintenance."));

  groupTitle(node, "Housekeeping");
  node.appendChild(
    actionRow(
      "Rescan installed apps",
      "Re-read every desktop entry on this machine.",
      "refresh",
      "cc-rescan",
      () => void rescanApps(),
    ),
  );

  groupTitle(node, "Power");
  node.appendChild(
    actionRow("Sleep now", "Suspend the machine.", "power", "cc-sleep", () => {
      toast("Sleeping…", "ok");
      fire("suspend");
    }),
  );
  node.appendChild(
    actionRow("Lock the screen", "", "lock", "cc-lock", () => fire("lock")),
  );
  node.appendChild(
    actionRow("Turn off the display", "", "eyeSlash", "cc-screen-off", () => fire("screen-off")),
  );

  groupTitle(node, "Shut Down");
  node.appendChild(
    actionRow("Log out", "", "logout", "cc-logout", () => confirmPower("logout", "Log out?", "Log Out", "cc-logout"), true),
  );
  node.appendChild(
    actionRow("Restart", "", "reboot", "cc-reboot", () => confirmPower("reboot", "Restart?", "Restart", "cc-reboot"), true),
  );
  node.appendChild(
    actionRow("Shut Down", "", "shutdown", "cc-shutdown", () => confirmPower("shutdown", "Shut Down?", "Shut Down", "cc-shutdown"), true),
  );
}

/* ── Tab + panel plumbing ───────────────────────────────────────────────── */
function buildTab(tab: CcTab): void {
  if (!content) return;
  content.replaceChildren();
  switch (tab) {
    case "profile":
      buildProfile(content);
      break;
    case "controls":
      buildControls(content);
      break;
    case "system":
      buildSystem(content);
      break;
  }
  focusEngine.registerZone("cc-content", content, 1);
}

function rerender(): void {
  buildTab(activeTab);
}

function showTab(tab: CcTab, focusContent: boolean): void {
  activeTab = tab;
  for (const [id, node] of tabNodes) node.classList.toggle("is-active", id === tab);
  buildTab(tab);
  if (focusContent) requestAnimationFrame(() => focusEngine.focusFirst("cc-content"));
}

/** Close the panel and give focus back to the active tab in the top bar. */
function closeControlCentre(): void {
  closeOverlay?.();
}

function onOutsidePointerDown(event: PointerEvent): void {
  if (ccRoot && !ccRoot.contains(event.target as Node)) closeControlCentre();
}

/** Open the tvOS style Control Centre (no-op while another overlay is open). */
export function openControlCentre(): void {
  if (hasOverlay()) return;
  activeTab = "controls";
  tabNodes.clear();
  content = null;

  openOverlay({
    layer: "control",
    className: "overlay--cc",
    returnKey: `tab-${store.state.tab}`,
    onClose: () => {
      document.removeEventListener("pointerdown", onOutsidePointerDown);
      ccRoot = null;
      content = null;
      closeOverlay = null;
    },
    build: (root, helpers) => {
      closeOverlay = helpers.close;

      const cc = el("div", "cc");
      const tabs = el("div", "cc-tabs");
      for (const def of TABS) {
        const item = el("button", `cc-tab${activeTab === def.id ? " is-active" : ""}`);
        item.appendChild(icon(def.iconName, 16));
        item.appendChild(el("span", undefined, def.label));
        makeFocusable(
          item,
          {
            onFocus: () => {
              sound.focus();
              if (activeTab !== def.id) showTab(def.id, false);
            },
            onActivate: () => {
              sound.select();
              showTab(def.id, true);
            },
          },
          `cc-tab-${def.id}`,
        );
        tabNodes.set(def.id, item);
        tabs.appendChild(item);
      }
      cc.appendChild(tabs);
      content = el("div", "cc-content");
      cc.appendChild(content);
      root.appendChild(cc);
      ccRoot = cc;
      focusEngine.registerZone("cc-tabs", tabs, 0);

      // Tapping the scrim beside the panel closes it, like a tvOS sheet.
      window.setTimeout(() => document.addEventListener("pointerdown", onOutsidePointerDown), 0);

      showTab(activeTab, false);
      requestAnimationFrame(() => focusEngine.focusKey(`cc-tab-${activeTab}`));
    },
  });
}