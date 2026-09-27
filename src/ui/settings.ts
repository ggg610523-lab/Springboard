import { api, formatSize, mediaGenreSeedsSync } from "../api";
import { focusEngine, makeFocusable } from "../focus/focus-engine";
import { sound } from "../sound";
import { actions, store } from "../state";
import type { MediaStatus, Settings } from "../types";
import { showDialog, showPicker } from "./dialog";
import { el, icon } from "./icons";
import { closeAllOverlays, openOverlay, toast } from "./overlay";
import { startHeroRotation } from "./hero";

interface NavDef {
  id: string;
  label: string;
  iconName: string;
}

const NAV: NavDef[] = [
  { id: "general", label: "General", iconName: "gear" },
  { id: "appearance", label: "Appearance", iconName: "panel" },
  { id: "shelves", label: "Shelves & Layout", iconName: "grid" },
  { id: "recommendations", label: "Recommendations", iconName: "sparkles" },
  { id: "sound", label: "Sound & System", iconName: "volume" },
  { id: "about", label: "About", iconName: "info" },
];

const THEMES: [string, string][] = [
  ["dark", "Dark"],
  ["midnight", "Midnight"],
  ["graphite", "Graphite"],
  ["light", "Light"],
];

const ACCENTS: [string, string][] = [
  ["#0a84ff", "Blue"],
  ["#bf5af2", "Purple"],
  ["#ff375f", "Pink"],
  ["#ff9f0a", "Orange"],
  ["#30d158", "Green"],
  ["#64d2ff", "Cyan"],
];

const SORT_MODES: [string, string][] = [
  ["category", "By category"],
  ["name", "Alphabetical"],
  ["usage", "Most used first"],
];

const TILE_SIZES: [string, string][] = [
  ["small", "Small"],
  ["medium", "Medium"],
  ["large", "Large"],
];

let activePanel = "general";

/** One tvOS toggle row bound to a boolean setting. */
function switchRow(
  label: string,
  hint: string | null,
  key: keyof Settings,
  onToggle?: () => void,
): HTMLElement {
  const row = el("div", "settings-row");
  const text = el("div", "settings-label");
  text.appendChild(el("span", undefined, label));
  if (hint) text.appendChild(el("span", "settings-hint", hint));
  row.appendChild(text);
  const toggle = el("div", `switch${store.state.settings[key] ? " is-on" : ""}`);
  row.appendChild(toggle);
  makeFocusable(
    row,
    {
      onFocus: () => sound.focus(),
      onActivate: () => {
        sound.toggle();
        const next = !store.state.settings[key];
        actions.patchSettings({ [key]: next } as Partial<Settings>);
        toggle.classList.toggle("is-on", next);
        onToggle?.();
      },
    },
    `set-${String(key)}`,
  );
  return row;
}

/** A tvOS value row that opens a picker sheet. */
function pickerRow<T extends string | number>(
  label: string,
  hint: string | null,
  key: keyof Settings,
  options: [T, string][],
  format?: (value: T) => string,
): HTMLElement {
  const row = el("div", "settings-row");
  const text = el("div", "settings-label");
  text.appendChild(el("span", undefined, label));
  if (hint) text.appendChild(el("span", "settings-hint", hint));
  row.appendChild(text);
  const current = store.state.settings[key] as T;
  const value = el("div", "settings-value", format ? format(current) : optionLabel(options, current));
  row.appendChild(value);
  makeFocusable(
    row,
    {
      onFocus: () => sound.focus(),
      onActivate: () => {
        sound.select();
        showPicker<T>({
          title: label,
          current,
          options: options.map(([val, text]) => ({ label: text, value: val })),
          onSelect: (next) => {
            actions.patchSettings({ [key]: next } as Partial<Settings>);
            value.textContent = format ? format(next) : optionLabel(options, next);
            if (key === "topShelfInterval") startHeroRotation();
          },
          returnKey: `set-${String(key)}`,
        });
      },
    },
    `set-${String(key)}`,
  );
  return row;
}

function optionLabel<T>(options: [T, string][], value: T): string {
  return options.find(([candidate]) => candidate === value)?.[1] ?? String(value);
}

/** A settings row whose value text is produced by a closure (live updates). */
function valueRow(label: string, text: () => string, key: string, onActivate: () => void): HTMLElement {
  const row = el("div", "settings-row");
  row.appendChild(el("div", "settings-label", label));
  const value = el("div", "settings-value", text());
  value.dataset.bind = key;
  row.appendChild(value);
  makeFocusable(
    row,
    {
      onFocus: () => sound.focus(),
      onActivate: () => onActivate(),
    },
    `set-${key}`,
  );
  return row;
}

/** A row with an inline slider (left/right adjusts, Enter resets). */
function sliderRow(
  label: string,
  key: "backgroundDim" | "backgroundBlur" | "rowSpacing" | "cornerRadius" | "volume",
  min: number,
  max: number,
  suffix: string,
): HTMLElement {
  const row = el("div", "settings-row");
  row.appendChild(el("div", "settings-label", label));
  const slider = el("div", "slider");
  const input = el("input") as HTMLInputElement;
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = "1";
  const paint = (): void => {
    const value = Number(input.value);
    input.style.setProperty("--fill", `${(((value - min) / (max - min)) * 100).toFixed(1)}%`);
  };
  input.value = String(store.state.settings[key]);
  paint();
  const readout = el("span", "slider__value", `${input.value}${suffix}`);
  input.addEventListener("input", () => {
    paint();
    readout.textContent = `${input.value}${suffix}`;
    actions.patchSettings({ [key]: Number(input.value) } as Partial<Settings>);
  });
  slider.appendChild(input);
  slider.appendChild(readout);
  row.appendChild(slider);
  makeFocusable(
    row,
    {
      onFocus: () => sound.focus(),
      onActivate: () => {
        sound.toggle();
      },
      onMove: (direction) => {
        if (direction !== "left" && direction !== "right") return false;
        const next = Math.min(max, Math.max(min, Number(input.value) + (direction === "right" ? 1 : -1)));
        if (next === Number(input.value)) return true;
        input.value = String(next);
        input.dispatchEvent(new Event("input"));
        return true;
      },
    },
    `set-${String(key)}`,
  );
  return row;
}

/** Multi-select chips for the recommendation genre seeds. */
function genreChips(parent: HTMLElement): void {
  const chips = el("div", "chips");
  const selected = new Set(store.state.settings.mediaGenres);
  for (const genre of mediaGenreSeedsSync()) {
    const chip = el("button", `chip${selected.has(genre) ? " is-on" : ""}`, genre);
    makeFocusable(
      chip,
      {
        onFocus: () => sound.focus(),
        onActivate: () => {
          sound.toggle();
          if (selected.has(genre)) {
            selected.delete(genre);
            chip.classList.remove("is-on");
          } else {
            selected.add(genre);
            chip.classList.add("is-on");
          }
          actions.patchSettings({ mediaGenres: [...selected] });
        },
      },
      `chip-${genre}`,
    );
    chips.appendChild(chip);
  }
  parent.appendChild(chips);
  focusEngine.registerZone("genre-chips", chips, 2);
}

/** Action row (Sync now, Reset profile, Rescan, Quit, …). */
function actionRow(
  label: string,
  hint: string | null,
  iconName: string,
  key: string,
  run: () => void | Promise<void>,
): HTMLElement {
  const row = el("div", "settings-row");
  const text = el("div", "settings-label");
  text.appendChild(el("span", undefined, label));
  if (hint) text.appendChild(el("span", "settings-hint", hint));
  row.appendChild(text);
  const value = el("div", "settings-value settings-value--action");
  value.appendChild(icon(iconName, 15));
  row.appendChild(value);
  makeFocusable(
    row,
    {
      onFocus: () => sound.focus(),
      onActivate: () => {
        sound.select();
        void run();
      },
    },
    `set-${key}`,
  );
  return row;
}

function statCard(label: string, value: string, note?: string): HTMLElement {
  const card = el("div", "stat-card");
  card.appendChild(el("div", "stat-card__label", label));
  card.appendChild(el("div", "stat-card__value", value));
  if (note) card.appendChild(el("div", "stat-card__note", note));
  return card;
}

function panelHeader(content: HTMLElement, title: string, sub: string): void {
  const head = el("div", "settings-content__head");
  head.appendChild(el("h2", undefined, title));
  content.appendChild(head);
  content.appendChild(el("p", "settings-content__sub", sub));
}

function groupTitle(content: HTMLElement, title: string): void {
  content.appendChild(el("div", "settings-group", title));
}

function panelGeneral(content: HTMLElement): void {
  panelHeader(content, "General", "Behaviour of the launcher window and the remote.");
  groupTitle(content, "Launch");
  content.appendChild(switchRow("Confirm before opening", "Show a dialog every time you open an app.", "confirmLaunch"));
  content.appendChild(switchRow("Hide after launch", "Minimise the launcher once an app starts.", "hideOnLaunch"));
  content.appendChild(switchRow("Start fullscreen", "Fill the screen on startup.", "fullscreenOnStart"));
  content.appendChild(switchRow("Keep on top", "Float above every other window.", "alwaysOnTop"));
  content.appendChild(switchRow("Escape quits the launcher", "Close the app with the back button.", "escapeQuits"));
  groupTitle(content, "Interface");
  content.appendChild(switchRow("Show the clock", "Display the time in the top bar.", "showClock", () => rerender()));
  content.appendChild(switchRow("24-hour clock", "Switch between 07:45 and 07:45 PM.", "clock24h"));
  content.appendChild(switchRow("Tile labels", "Show names under every tile.", "showLabels"));
  content.appendChild(switchRow("Remote hints", "Keyboard hints in the bottom bar.", "showHints"));
  content.appendChild(switchRow("Interface sounds", "tvOS style ticks and pops.", "soundEffects"));
  content.appendChild(switchRow("Animations", "Smooth tvOS motion.", "animations"));
  content.appendChild(switchRow("Parallax artwork", "Artwork drifts under the pointer.", "parallax"));
}

function panelAppearance(content: HTMLElement): void {
  panelHeader(content, "Appearance", "Theme, accent colour and the cinematic backdrop.");
  groupTitle(content, "Theme");
  content.appendChild(pickerRow("Theme", null, "theme", THEMES));
  const accentValue = { text: optionLabel(ACCENTS, store.state.settings.accent) };
  const accentRow = valueRow("Accent colour", () => accentValue.text, "set-accent", () => {
    sound.select();
    showPicker<string>({
      title: "Accent colour",
      current: store.state.settings.accent,
      options: ACCENTS.map(([value, text]) => ({ label: text, value })),
      onSelect: (next) => {
        actions.patchSettings({ accent: next });
        accentValue.text = optionLabel(ACCENTS, next);
      },
      returnKey: "set-accent",
    });
  });
  content.appendChild(accentRow);
  groupTitle(content, "Backdrop");
  content.appendChild(
    pickerRow("Backdrop", "Dynamic derives colours from what you focus.", "backgroundStyle", [
      ["dynamic", "Dynamic wash"],
      ["image", "Custom image"],
      ["solid", "Plain black"],
    ]),
  );
  content.appendChild(sliderRow("Backdrop blur", "backgroundBlur", 0, 120, "px"));
  content.appendChild(sliderRow("Backdrop dim", "backgroundDim", 0, 90, "%"));
  content.appendChild(
    actionRow("Choose backdrop image…", "Type any PNG or JPG path on this machine.", "folder", "backdrop", () => {
      showDialog({
        title: "Backdrop image",
        body: "Enter the absolute path of a PNG or JPG file:",
        actions: [
          { label: "Cancel", onSelect: () => undefined },
          {
            label: "Use image",
            primary: true,
            onSelect: () => {
              const input = document.querySelector<HTMLInputElement>("#backdrop-path-input");
              const path = input?.value.trim();
              if (!path) {
                toast("No path entered", "error");
                return;
              }
              actions.patchSettings({ backgroundImage: path, backgroundStyle: "image" });
              toast("Backdrop image set", "ok");
              rerender();
            },
          },
        ],
        render: (body) => {
          const input = document.createElement("input");
          input.id = "backdrop-path-input";
          input.type = "text";
          input.spellcheck = false;
          input.placeholder = "/home/you/Pictures/wallpaper.jpg";
          input.className = "dialog__input";
          body.appendChild(input);
        },
        returnKey: "set-backdrop",
      });
    }),
  );
  if (store.state.settings.backgroundImage) {
    content.appendChild(
      actionRow("Clear backdrop image", store.state.settings.backgroundImage, "close", "backdrop-clear", () => {
        actions.patchSettings({ backgroundImage: null, backgroundStyle: "dynamic" });
        rerender();
      }),
    );
  }
  groupTitle(content, "Tiles");
  content.appendChild(pickerRow("Tile size", null, "tileSize", TILE_SIZES));
  content.appendChild(sliderRow("Corner radius", "cornerRadius", 4, 28, "px"));
}

function panelShelves(content: HTMLElement): void {
  panelHeader(content, "Shelves & Layout", "What appears on the home screen and how it is sorted.");
  groupTitle(content, "Top Shelf");
  content.appendChild(switchRow("Show the Top Shelf", "The wide hero above every shelf.", "showTopShelf"));
  content.appendChild(
    pickerRow("Rotate every", "How long a Top Shelf pick stays on screen.", "topShelfInterval", [
      [5, "5 seconds"],
      [9, "9 seconds"],
      [15, "15 seconds"],
      [30, "30 seconds"],
    ]),
  );
  groupTitle(content, "Rows");
  content.appendChild(pickerRow("Sort apps", null, "sortMode", SORT_MODES));
  content.appendChild(switchRow("Group by category", "One shelf per desktop category.", "groupByCategory"));
  content.appendChild(switchRow("Show shelf titles", null, "showRowTitles"));
  content.appendChild(
    pickerRow("Apps per row", null, "iconsPerRow", [
      [5, "5"],
      [6, "6"],
      [7, "7"],
      [8, "8"],
      [9, "9"],
    ]),
  );
  content.appendChild(sliderRow("Row spacing", "rowSpacing", 12, 80, "px"));
  content.appendChild(
    pickerRow("Recent shelf size", null, "maxRecent", [
      [8, "8"],
      [12, "12"],
      [24, "24"],
      [32, "32"],
    ]),
  );
  groupTitle(content, "Library");
  content.appendChild(switchRow("Show hidden apps", "Dimmed tiles for apps you removed.", "showHidden"));
  content.appendChild(switchRow("Show NoDisplay entries", "System components most people never open.", "showNoDisplay"));
  content.appendChild(
    actionRow("Rescan installed apps", "Re-read every desktop entry on this machine.", "refresh", "rescan", async () => {
      toast("Rescanning apps…");
      await actions.refreshApps();
      toast(`${store.state.apps.length} apps found`, "ok");
      rerender();
    }),
  );
}

function panelRecommendations(content: HTMLElement): void {
  panelHeader(content, "Recommendations", "IMDb cover art ranked by what you actually open.");
  content.appendChild(
    switchRow("Enable recommendations", "Fetch a title catalogue from IMDb.", "mediaEnabled", () => {
      void actions.loadMedia();
      rerender();
    }),
  );
  content.appendChild(switchRow("Top Shelf picks", "Rotate recommended titles in the hero.", "mediaHero"));
  content.appendChild(
    pickerRow("Shelf size", "Posters per recommendation shelf.", "mediaShelfSize", [
      [6, "6"],
      [10, "10"],
      [14, "14"],
      [20, "20"],
    ]),
  );
  content.appendChild(
    pickerRow("Refresh catalogue every", null, "mediaRefreshHours", [
      [6, "6 hours"],
      [12, "12 hours"],
      [24, "24 hours"],
      [72, "3 days"],
    ]),
  );
  groupTitle(content, "Genres");
  content.appendChild(el("div", "settings-content__sub", "Empty means every genre. Select the seeds you care about."));
  genreChips(content);
  groupTitle(content, "Engine");
  content.appendChild(
    actionRow("Sync catalogue now", "Fetch the latest popular titles from IMDb.", "refresh", "sync", async () => {
      toast("Syncing with IMDb…");
      try {
        await actions.syncCatalog();
        toast("Catalogue synced", "ok");
        rerender();
      } catch (error) {
        toast(`Sync failed: ${String(error)}`, "error");
      }
    }),
  );
  content.appendChild(
    actionRow("Shuffle recommendations", "Re-roll the ranking jitter.", "shuffle", "reshuffle", async () => {
      await actions.reshuffle();
      toast("Recommendations shuffled", "ok");
      rerender();
    }),
  );
  content.appendChild(
    actionRow("Reset taste profile", "Forget every like, dislike and click.", "trash", "reset-profile", async () => {
      await actions.resetProfile();
      toast("Taste profile reset", "ok");
      rerender();
    }),
  );
  content.appendChild(
    actionRow("Clear poster cache", "Free the disk space used by cover art.", "trash", "clear-posters", async () => {
      const removed = await api.mediaClearPosters().catch(() => 0);
      toast(`Removed ${removed} cached posters`, "ok");
    }),
  );
  if (statusCache) {
    groupTitle(content, "Status");
    const grid = el("div", "settings-stats");
    grid.appendChild(
      statCard("Catalogue", `${statusCache.catalog} titles`, statusCache.online ? "IMDb reachable" : "Offline — cached copy"),
    );
    grid.appendChild(statCard("Poster cache", formatSize(statusCache.posterBytes), `${statusCache.posters} images on disk`));
    grid.appendChild(statCard("Feedback events", String(statusCache.feedbackEvents), "Likes, hides and clicks"));
    grid.appendChild(
      statCard("Genre seeds", `${statusCache.seeds.length} active`, statusCache.seeds.join(", ") || "all genres"),
    );
    content.appendChild(grid);
  }
}

function panelSound(content: HTMLElement): void {
  panelHeader(content, "Sound & System", "Output volume and desktop session helpers.");
  content.appendChild(sliderRow("Output volume", "volume", 0, 100, "%"));
  content.appendChild(
    actionRow("Mute / unmute", "Toggle the system mute state.", "volumeMute", "mute", async () => {
      const outcome = await api.audioCommand("volume-mute").catch((error: unknown) => `error: ${String(error)}`);
      toast(String(outcome), "ok");
    }),
  );
  groupTitle(content, "System");
  content.appendChild(actionRow("Lock screen", null, "lock", "lock", () => void api.audioCommand("lock")));
  content.appendChild(actionRow("Sleep", null, "sleep", "suspend", () => void api.audioCommand("suspend")));
  content.appendChild(actionRow("Restart", null, "reboot", "reboot", () => void api.audioCommand("reboot")));
  content.appendChild(actionRow("Shut down", null, "power", "shutdown", () => void api.audioCommand("shutdown")));
  content.appendChild(actionRow("Log out", null, "logout", "logout", () => void api.audioCommand("logout")));
}

function panelAbout(content: HTMLElement): void {
  const info = store.state.systemInfo;
  panelHeader(content, "About", "Everything the launcher knows about this machine.");
  const rows: [string, string][] = [
    ["Version", info?.launcherVersion ?? "1.0.0"],
    ["Apps discovered", String(info?.appCount ?? store.state.apps.length)],
    ["Hostname", info?.hostname ?? "—"],
    ["Operating system", info?.os ?? "—"],
    ["Desktop session", `${info?.desktop ?? "—"} (${info?.sessionType ?? "—"})`],
    ["Icon themes", info?.iconThemes.join(", ") || "—"],
    ["Terminal", info?.terminal ?? "—"],
    ["Flatpak support", info?.hasFlatpak ? "Available" : "Not found"],
    ["Config file", info?.configPath ?? "—"],
  ];
  const list = el("div", "info-rows");
  for (const [label, value] of rows) {
    const row = el("div", "info-row");
    row.appendChild(el("span", "info-row__label", label));
    row.appendChild(el("span", "info-row__value", value));
    list.appendChild(row);
  }
  content.appendChild(list);
  groupTitle(content, "Danger zone");
  content.appendChild(
    actionRow("Reset all settings", "Back to factory defaults; your profile is kept.", "trash", "reset-settings", () => {
      showDialog({
        title: "Reset all settings?",
        body: "Every preference returns to its default. Your IMDb taste profile is kept.",
        actions: [
          { label: "Cancel", onSelect: () => undefined },
          {
            label: "Reset",
            primary: true,
            onSelect: () => {
              void actions.resetSettings().then(() => {
                toast("Settings restored to defaults", "ok");
                rerender();
              });
            },
          },
        ],
      });
    }),
  );
  content.appendChild(actionRow("Quit the launcher", null, "power", "quit", () => void actions.quit()));
}

let statusCache: MediaStatus | null = null;
let statusRequested = false;

/** Fetch the engine status once per settings session (async fill). */
function requestStatus(): void {
  if (statusRequested) return;
  statusRequested = true;
  void api
    .mediaStatus()
    .then((status) => {
      statusCache = status;
      if (activePanel === "recommendations") rerender();
    })
    .catch(() => undefined);
}

function buildPanel(content: HTMLElement, id: string): void {
  switch (id) {
    case "general":
      panelGeneral(content);
      break;
    case "appearance":
      panelAppearance(content);
      break;
    case "shelves":
      panelShelves(content);
      break;
    case "recommendations":
      panelRecommendations(content);
      requestStatus();
      break;
    case "sound":
      panelSound(content);
      break;
    default:
      panelAbout(content);
  }
  focusEngine.registerZone("settings-content", content, 1);
}

/** Re-paint the open settings panel after a setting changed the chrome. */
function rerender(): void {
  const content = document.querySelector<HTMLElement>(".settings-content");
  if (!content) return;
  content.replaceChildren();
  buildPanel(content, activePanel);
  requestAnimationFrame(() => focusEngine.focusFirst("settings-content"));
}

/** The full tvOS Settings sheet: left nav, right panel, remote friendly. */
export function openSettings(): void {
  statusCache = null;
  statusRequested = false;
  closeAllOverlays();
  openOverlay({
    layer: "settings",
    className: "overlay--settings",
    build: (root) => {
      const panel = el("div", "panel");
      const nav = el("div", "settings-nav");
      nav.appendChild(el("div", "settings-nav__title", "Settings"));
      const content = el("div", "settings-content");

      const select = (id: string): void => {
        activePanel = id;
        nav.querySelectorAll<HTMLElement>(".settings-nav__item").forEach((item) => {
          item.classList.toggle("is-active", item.dataset.panel === id);
        });
        content.replaceChildren();
        buildPanel(content, id);
        requestAnimationFrame(() => focusEngine.focusFirst("settings-content"));
      };

      for (const def of NAV) {
        const item = el("div", `settings-nav__item${activePanel === def.id ? " is-active" : ""}`);
        item.dataset.panel = def.id;
        item.appendChild(icon(def.iconName, 17));
        item.appendChild(el("span", undefined, def.label));
        makeFocusable(
          item,
          {
            onFocus: () => sound.focus(),
            onActivate: () => {
              sound.select();
              select(def.id);
            },
          },
          `settings-nav-${def.id}`,
        );
        nav.appendChild(item);
      }

      buildPanel(content, activePanel);
      panel.appendChild(nav);
      panel.appendChild(content);
      root.appendChild(panel);
      focusEngine.registerZone("settings-nav", nav, 0);
    },
    returnKey: "tab-settings",
    onClose: () => {
      focusEngine.rebuild(`tab-${store.state.tab}`);
    },
  });
}

