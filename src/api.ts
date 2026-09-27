import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppInfo,
  DirListing,
  LaunchResult,
  MediaFeedbackResult,
  MediaItem,
  MediaStatus,
  Settings,
  SystemInfo,
  UsageStats,
  UserProfile,
} from "./types";

/** Thin typed wrappers around the Rust commands. */
export const api = {
  listApps: (force = false) => invoke<AppInfo[]>("list_apps", { force }),
  rescanApps: () => invoke<AppInfo[]>("rescan_apps"),

  launchApp: (id: string) => invoke<string>("launch_app", { id }),
  launchDesktopFile: (path: string) => invoke<string>("launch_desktop_file", { path }),

  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<Settings>("save_settings", { settings }),
  resetSettings: () => invoke<Settings>("reset_settings"),

  getUsage: () => invoke<UsageStats>("get_usage"),
  getSystemInfo: () => invoke<SystemInfo>("get_system_info"),

  iconUri: (icon: string) => invoke<string>("icon_uri", { icon }),

  openTarget: (target: string) => invoke<void>("open_target", { target }),
  listDirectory: (path: string, showHidden = false) =>
    invoke<DirListing>("list_directory", { path, showHidden }),
  homeDirectory: () => invoke<string>("home_directory"),

  getAudio: () => invoke<[number | null, boolean | null]>("get_audio"),
  audioCommand: (action: string, value?: number) =>
    invoke<string>("audio_command", { action, value: value ?? null }),

  quit: () => invoke<void>("quit_launcher"),

  onLaunchResult: (handler: (result: LaunchResult) => void): Promise<UnlistenFn> =>
    listen<LaunchResult>("launch-result", (event) => handler(event.payload)),
  onAppsScanned: (handler: (apps: AppInfo[]) => void): Promise<UnlistenFn> =>
    listen<AppInfo[]>("apps-scanned", (event) => handler(event.payload)),

  // ── Recommendation engine ────────────────────────────────────────────────
  mediaCatalog: (refresh = false) => invoke<MediaItem[]>("media_catalog", { refresh }),
  mediaRecommendations: (limit?: number, salt?: number) =>
    invoke<MediaItem[]>("media_recommendations", { limit: limit ?? null, salt: salt ?? null }),
  mediaSearch: (query: string, limit?: number) =>
    invoke<MediaItem[]>("media_search", { query, limit: limit ?? null }),
  mediaFeedback: (item: MediaItem, action: string, limit?: number, salt?: number) =>
    invoke<MediaFeedbackResult>("media_feedback", {
      item,
      action,
      limit: limit ?? null,
      salt: salt ?? null,
    }),
  mediaProfile: () => invoke<UserProfile>("media_profile"),
  mediaResetProfile: () => invoke<UserProfile>("media_reset_profile"),
  mediaStatus: () => invoke<MediaStatus>("media_status"),
  mediaGenreSeeds: () => invoke<string[]>("media_genre_seeds"),
  mediaClearPosters: () => invoke<number>("media_clear_posters"),
  mediaOpen: (id: string) => invoke<void>("media_open", { id }),

  /** Client side filter over the discovered apps (used by the Search screen). */
  searchApps: (query: string, limit = 24) => {
    const text = query.trim().toLowerCase();
    if (!text) return Promise.resolve([] as AppInfo[]);
    const matches = appIndex.filter((app) => app.name.toLowerCase().includes(text));
    return Promise.resolve(matches.slice(0, limit));
  },
};

/** Name index used by `searchApps`; kept fresh by the store actions. */
let appIndex: AppInfo[] = [];

/** Give the search helper the current app list (avoids a store import cycle). */
export function setAppIndex(apps: AppInfo[]): void {
  appIndex = apps;
}

/** Fallback genre seeds (matches the IMDb catalogue's common genres). */
const FALLBACK_GENRES = [
  "Action",
  "Adventure",
  "Animation",
  "Comedy",
  "Crime",
  "Documentary",
  "Drama",
  "Family",
  "Fantasy",
  "History",
  "Horror",
  "Mystery",
  "Romance",
  "Sci-Fi",
  "Thriller",
  "War",
  "Western",
];

let genreCache: string[] | null = null;

/**
 * Genre seeds for the Settings chips. Returns the cached list immediately and
 * refreshes it in the background so the next open shows the backend's list.
 */
export function mediaGenreSeedsSync(): string[] {
  void api
    .mediaGenreSeeds()
    .then((seeds) => {
      if (Array.isArray(seeds) && seeds.length) genreCache = seeds;
    })
    .catch(() => undefined);
  return genreCache ?? FALLBACK_GENRES;
}

/** Build the URL the webview uses to fetch a themed icon. */
export function iconUrl(iconName: string | null, filePath: string | null): string | null {
  const source = filePath ?? iconName;
  if (!source) return null;
  return `appicon://localhost/?n=${encodeURIComponent(source)}`;
}

/**
 * Cover-art URL. The Rust side proxies Amazon/IMDb through the `poster://`
 * scheme so images are cached on disk and keep working offline.
 */
export function posterUrl(item: Pick<MediaItem, "id" | "poster">): string | null {
  if (!item.poster) return null;
  return `poster://localhost/?id=${encodeURIComponent(item.id)}&u=${encodeURIComponent(item.poster)}`;
}

/** "2010 · Movie" style meta line. */
export function mediaMeta(item: MediaItem): string {
  return [item.year, item.kind].filter((part) => part && part.length > 0).join(" · ");
}

/** Human readable file size. */
export function formatSize(bytes: number): string {
  if (bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}