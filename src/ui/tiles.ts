import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, iconUrl, mediaMeta, posterUrl } from "../api";
import { focusEngine, makeFocusable } from "../focus/focus-engine";
import { setBodyWash, washFor } from "../palette";
import { sound } from "../sound";
import { actions, profileSets, settingsSets, store } from "../state";
import type { AppTile, MediaItem } from "../types";
import { el, icon } from "./icons";
import { showDialog, showPicker, nextZoneId } from "./dialog";
import { showActionMenu } from "./menu";
import { openOverlay, toast } from "./overlay";

/**
 * Parallax the artwork slightly while the pointer travels over a tile.
 *
 * One delegated listener for the whole document instead of a
 * `pointermove`/`pointerleave` pair per tile (~62 tiles × 2 listeners that were
 * torn down and recreated on every re-render).
 */
let parallaxWired = false;
let parallaxArt: HTMLElement | null = null;

function wireParallax(): void {
  if (parallaxWired) return;
  parallaxWired = true;
  document.addEventListener(
    "pointermove",
    (event) => {
      if (!store.state.settings.parallax) return;
      const target = event.target instanceof Element ? event.target : null;
      const art = target?.closest<HTMLElement>(".tile-art") ?? null;
      if (art !== parallaxArt) {
        // Reset the artwork we just left so it settles back flat.
        parallaxArt?.style.setProperty("--px", "0px");
        parallaxArt?.style.setProperty("--py", "0px");
        parallaxArt = art;
      }
      if (!art) return;
      const rect = art.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const x = ((event.clientX - rect.left) / rect.width - 0.5) * 12;
      const y = ((event.clientY - rect.top) / rect.height - 0.5) * 12;
      art.style.setProperty("--px", `${x.toFixed(2)}px`);
      art.style.setProperty("--py", `${y.toFixed(2)}px`);
    },
    { passive: true },
  );
}

/** Build the rounded artwork square: image on top of a gradient fallback. */
function artWithImage(src: string | null, fallback: HTMLElement | null, alt: string): HTMLElement {
  const art = el("div", "tile-art");
  if (fallback) art.appendChild(fallback);
  if (src) {
    const img = el("img");
    img.src = src;
    img.alt = alt;
    img.loading = "lazy";
    img.decoding = "async";
    img.addEventListener("error", () => {
      img.remove();
      if (!fallback) art.appendChild(el("div", "tile-art__fallback", initialsOf(alt)));
    });
    img.addEventListener("load", () => {
      if (fallback && fallback.classList.contains("poster-fallback")) fallback.remove();
    });
    art.appendChild(img);
  }
  wireParallax();
  return art;
}

const initialsCache = new Map<string, string>();

function initialsOf(name: string): string {
  const cached = initialsCache.get(name);
  if (cached !== undefined) return cached;
  const words = name.replace(/[^\p{L}\p{N} ]+/gu, " ").split(/\s+/).filter(Boolean);
  let value: string;
  if (!words.length) value = "?";
  else if (words.length === 1) value = words[0].slice(0, 2).toUpperCase();
  else value = `${words[0][0]}${words[1][0]}`.toUpperCase();
  initialsCache.set(name, value);
  return value;
}

function tileBadge(iconName: string, extraClass = ""): HTMLElement {
  const node = el("div", `tile-badge${extraClass ? ` ${extraClass}` : ""}`);
  node.appendChild(icon(iconName, 12));
  return node;
}

/** Paint the backdrop wash for the focused item. */
function setWash(seed: string): void {
  const { a, b } = washFor(seed);
  setBodyWash(a, b);
}

/** Launch a real application, honouring the confirm/hide settings. */
export function launchApp(app: AppTile): void {
  const settings = store.state.settings;
  const run = (): void => {
    sound.launch();
    void api
      .launchApp(app.id)
      .then(() => {
        const apps = { ...store.state.usage.apps };
        const entry = apps[app.id] ?? { count: 0, lastUsed: 0 };
        apps[app.id] = { count: entry.count + 1, lastUsed: Math.floor(Date.now() / 1000) };
        store.set({ usage: { apps } });
        toast(`Opening ${app.name}`, "ok");
        if (settings.hideOnLaunch) {
          window.setTimeout(() => {
            void getCurrentWindow().hide();
          }, 850);
        }
      })
      .catch((error: unknown) => {
        sound.error();
        toast(String(error), "error");
      });
  };

  if (settings.confirmLaunch) {
    showDialog({
      title: `Open ${app.name}?`,
      body: app.comment ?? app.genericName ?? "This will start the application.",
      actions: [
        { label: "Cancel", onSelect: () => undefined },
        { label: "Open", primary: true, onSelect: run },
      ],
      returnKey: `tile-${app.id}`,
    });
    return;
  }
  run();
}

/** One app tile, styled like a tvOS home screen icon. */
export function appTile(app: AppTile, focusKey: string): HTMLElement {
  const tile = el("button", "tile");
  tile.dataset.appId = app.id;
  const src = iconUrl(app.iconName, app.iconPath);
  const fallback = el("div", "tile-art__fallback", initialsOf(app.name));
  tile.appendChild(artWithImage(src, fallback, app.name));

  const isFavorite = settingsSets().favorites.has(app.id);
  const isHidden = settingsSets().hidden.has(app.id);
  if (isFavorite || isHidden) {
    const badges = el("div", "tile-badges");
    if (isFavorite) badges.appendChild(tileBadge("star", "tile-badge--like"));
    if (isHidden) badges.appendChild(tileBadge("eyeSlash"));
    tile.appendChild(badges);
  }

  if (store.state.settings.showLabels) {
    tile.appendChild(el("div", "tile-label", app.name));
  }
  if (isHidden) tile.classList.add("is-hidden-app");

  makeFocusable(
    tile,
    {
      onFocus: () => {
        sound.focus();
        setWash(app.id);
      },
      onActivate: () => launchApp(app),
      onContext: () => openAppMenu(app, tile),
    },
    focusKey,
  );
  return tile;
}

/** Learn from a poster interaction and confirm it visually. */
export function mediaFeedback(item: MediaItem, action: string, label: string): void {
  sound.toggle();
  void actions.feedback(item, action).then(() => toast(label, "ok"));
}

/** One IMDb poster tile. */
export function mediaTile(item: MediaItem, focusKey: string): HTMLElement {
  const tile = el("button", "tile tile--poster");
  tile.dataset.mediaId = item.id;
  const src = posterUrl(item);
  const { a, b } = washFor(item.genre || item.title);
  const fallback = el("div", "poster-fallback");
  fallback.style.setProperty("--wash-a", a);
  fallback.style.setProperty("--wash-b", b);
  fallback.appendChild(el("span", undefined, item.title));
  tile.appendChild(artWithImage(src, fallback, item.title));

  const liked = profileSets().liked.has(item.id);
  const watched = profileSets().watched.has(item.id);
  if (liked || watched) {
    const badges = el("div", "tile-badges");
    if (liked) badges.appendChild(tileBadge("heart", "tile-badge--like"));
    if (watched) badges.appendChild(tileBadge("check"));
    tile.appendChild(badges);
  }

  if (store.state.settings.showLabels) {
    tile.appendChild(el("div", "tile-label", item.title));
    tile.appendChild(el("div", "tile-sub", mediaMeta(item)));
  }

  makeFocusable(
    tile,
    {
      onFocus: () => {
        sound.focus();
        setWash(item.genre || item.title);
      },
      onActivate: () => openMedia(item),
      onContext: () => openMediaMenu(item, tile),
    },
    focusKey,
  );
  return tile;
}

/** Open the IMDb page and record the click for the recommendation engine. */
export function openMedia(item: MediaItem): void {
  sound.select();
  void api.mediaOpen(item.id).catch((error: unknown) => {
    sound.error();
    toast(String(error), "error");
  });
  void actions.feedback(item, "click");
}

/** A streaming provider a poster can be searched on. */
export interface StreamingService {
  id: string;
  name: string;
  icon: string;
  /** Search URL for a title (opened in the desktop browser). */
  url: (title: string) => string;
}

/** "Play on…" targets shown for every IMDb title. */
export const STREAMING_SERVICES: StreamingService[] = [
  {
    id: "netflix",
    name: "Netflix",
    icon: "play",
    url: (title) => `https://www.netflix.com/search?q=${encodeURIComponent(title)}`,
  },
  {
    id: "prime",
    name: "Amazon Prime Video",
    icon: "film",
    url: (title) => `https://www.amazon.com/s?k=${encodeURIComponent(title)}&i=instant-video`,
  },
  {
    id: "disney",
    name: "Disney+",
    icon: "star",
    url: (title) => `https://www.disneyplus.com/search/${encodeURIComponent(title)}`,
  },
  {
    id: "apple",
    name: "Apple TV+",
    icon: "tv",
    url: (title) => `https://tv.apple.com/search?term=${encodeURIComponent(title)}`,
  },
  {
    id: "youtube",
    name: "YouTube",
    icon: "external",
    url: (title) => `https://www.youtube.com/results?search_query=${encodeURIComponent(title)}`,
  },
];

/** Search a title on a streaming service using the desktop's default handler. */
export function openStreaming(item: MediaItem, service: StreamingService): void {
  const url = service.url(item.title);
  sound.select();
  void api.openTarget(url).catch((error: unknown) => {
    sound.error();
    toast(`Could not open ${service.name}: ${String(error)}`, "error");
  });
}

/** The tvOS style picker listing the streaming services for a title. */
export function playOnPicker(item: MediaItem, returnKey?: string): void {
  showPicker({
    title: "Play on…",
    subtitle: item.title,
    options: STREAMING_SERVICES.map((service) => ({
      label: service.name,
      value: service.id,
    })),
    current: "",
    onSelect: (id) => {
      const service = STREAMING_SERVICES.find((entry) => entry.id === id);
      if (service) openStreaming(item, service);
    },
    returnKey,
  });
}

/** tvOS long-press menu for an app tile. */
export function openAppMenu(app: AppTile, anchor: HTMLElement): void {
  const settings = store.state.settings;
  const favorite = settingsSets().favorites.has(app.id);
  const hidden = settingsSets().hidden.has(app.id);
  showActionMenu(
    anchor,
    [
      { icon: "play", label: "Open", action: () => launchApp(app) },
      {
        icon: "star",
        label: favorite ? "Remove from Favorites" : "Add to Favorites",
        action: () => {
          const favorites = favorite
            ? settings.favorites.filter((id) => id !== app.id)
            : [...settings.favorites, app.id];
          actions.patchSettings({ favorites });
          toast(favorite ? `${app.name} removed from Favorites` : `${app.name} added to Favorites`, "ok");
        },
      },
      {
        icon: "arrowUp",
        label: "Move to Front",
        action: () => {
          const favorites = [app.id, ...settings.favorites.filter((id) => id !== app.id)];
          actions.patchSettings({ favorites });
          toast(`${app.name} pinned first`, "ok");
        },
      },
      {
        icon: hidden ? "eye" : "eyeSlash",
        label: hidden ? "Unhide App" : "Hide from Home",
        action: () => {
          const hiddenApps = hidden
            ? settings.hiddenApps.filter((id) => id !== app.id)
            : [...settings.hiddenApps, app.id];
          actions.patchSettings({ hiddenApps, showHidden: hidden ? settings.showHidden : true });
          toast(hidden ? `${app.name} is visible again` : `${app.name} hidden from Home`, "ok");
        },
      },
      { icon: "info", label: "App Info", action: () => showAppInfo(app) },
      {
        icon: "folder",
        label: "Open .desktop Folder",
        action: () => {
          // The lean tile record has no `desktopFile`; fetch it on demand.
          void api
            .appDetails(app.id)
            .then((details) => {
              if (!details) {
                toast("Could not locate the .desktop file", "error");
                return;
              }
              const dir = details.desktopFile.replace(/\/[^/]+$/, "");
              return api.openTarget(dir);
            })
            .catch(() => toast("Could not open the folder", "error"));
        },
      },
    ],
    `tile-${app.id}`,
  );
}

/** tvOS long-press menu for a poster. */
export function openMediaMenu(item: MediaItem, anchor: HTMLElement): void {
  const liked = profileSets().liked.has(item.id);
  const disliked = profileSets().disliked.has(item.id);
  const watched = profileSets().watched.has(item.id);
  showActionMenu(
    anchor,
    [
      { icon: "external", label: "Open on IMDb", action: () => openMedia(item) },
      {
        icon: "play",
        label: "Play on…",
        action: () => playOnPicker(item, `media-${item.id}`),
      },
      {
        icon: "heart",
        label: liked ? "Remove Like" : "More Like This",
        action: () =>
          mediaFeedback(
            item,
            liked ? "hide" : "like",
            liked ? "Removed from Top Picks" : "You'll see more like this",
          ),
      },
      {
        icon: "check",
        label: watched ? "Mark as Unwatched" : "Mark as Watched",
        action: () => mediaFeedback(item, "watched", watched ? "Marked as unwatched" : "Marked as watched"),
      },
      {
        icon: "ban",
        label: disliked ? "Unblock Title" : "Not Interested",
        action: () => mediaFeedback(item, "hide", disliked ? "Title unblocked" : "You'll see less of this"),
      },
      {
        icon: "shuffle",
        label: "Shuffle Recommendations",
        action: () => {
          void actions.reshuffle().then(() => toast("Recommendations shuffled", "ok"));
        },
      },
    ],
    `media-${item.id}`,
  );
}

/** Read-only info sheet listing everything the desktop entry exposes. */
/**
 * Details sheet for an app.
 *
 * The tile record is lean, so the heavyweight desktop-entry fields (Exec,
 * categories, terminal, …) are fetched on demand — one local IPC call for a
 * screen the user opens deliberately.
 */
export function showAppInfo(app: AppTile): void {
  void api
    .appDetails(app.id)
    .catch(() => null)
    .then((details) => {
      const rows: [string, string][] = [
        ["Name", app.name],
        ["Generic name", app.genericName ?? "—"],
        ["Description", app.comment ?? "—"],
        ["Category", app.group],
        ["Exec", details?.exec ?? "—"],
        ["Desktop file", details?.desktopFile ?? "—"],
        ["Icon", app.iconPath ?? app.iconName ?? "—"],
        ["Source", app.isFlatpak ? "Flatpak" : app.isSnap ? "Snap" : "Native package"],
        ["Terminal", details?.terminal ? "Yes" : "No"],
        ["Window class", details?.startupWmClass ?? "—"],
        ["Categories", details?.categories.join(", ") || "—"],
        ["Keywords", app.keywords.join(", ") || "—"],
      ];
      paintAppInfo(app, rows);
    });
}

function paintAppInfo(app: AppTile, rows: [string, string][]): void {
  openOverlay({
    layer: "info",
    className: "overlay--info",
    returnKey: `tile-${app.id}`,
    build: (root, helpers) => {
      const card = el("div", "dialog");
      card.appendChild(el("h2", undefined, app.name));
      const list = el("div", "info-rows");
      for (const [label, value] of rows) {
        const row = el("div", "info-row");
        row.appendChild(el("span", "info-row__label", label));
        row.appendChild(el("span", "info-row__value", value));
        list.appendChild(row);
      }
      card.appendChild(list);
      const actions2 = el("div", "dialog__actions");
      const closeButton = el("button", "btn btn--primary", "Done");
      makeFocusable(
        closeButton,
        {
          onFocus: () => sound.focus(),
          onActivate: () => {
            sound.select();
            helpers.close();
          },
        },
        "info-close",
      );
      actions2.appendChild(closeButton);
      card.appendChild(actions2);
      root.appendChild(card);
      focusEngine.registerZone(nextZoneId("info-actions"), actions2, 1);
      requestAnimationFrame(() => focusEngine.focusKey("info-close"));
    },
  });
}