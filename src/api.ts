import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppInfo,
  AppsScanned,
  AppTile,
  AudioCommandResult,
  DirListing,
  LaunchResult,
  MediaBootstrap,
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
  /**
   * Home screen tiles. `includeHidden` opts into `NoDisplay` entries; they are
   * filtered in Rust so the 72% of a typical scan the grid never shows does not
   * cross the IPC boundary at all.
   */
  listApps: (force = false, includeHidden = false) =>
    invoke<AppTile[]>("list_apps", { force, includeHidden }),
  rescanApps: (includeHidden = false) => invoke<AppTile[]>("rescan_apps", { includeHidden }),
  /** Full desktop-entry record, fetched only for the details sheet. */
  appDetails: (id: string) => invoke<AppInfo | null>("app_details", { id }),
  appsRevision: () => invoke<number>("apps_revision"),

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
  /** Applies the action and returns the new state, so no follow-up read is needed. */
  audioCommand: (action: string, value?: number) =>
    invoke<AudioCommandResult>("audio_command", { action, value: value ?? null }),

  quit: () => invoke<void>("quit_launcher"),

  onLaunchResult: (handler: (result: LaunchResult) => void): Promise<UnlistenFn> =>
    listen<LaunchResult>("launch-result", (event) => handler(event.payload)),
  /** Carries a revision only; refetch the tiles when it moves. */
  onAppsScanned: (handler: (payload: AppsScanned) => void): Promise<UnlistenFn> =>
    listen<AppsScanned>("apps-scanned", (event) => handler(event.payload)),

  // ── Recommendation engine ────────────────────────────────────────────────
  /** Catalogue + profile + first ranking + status in a single round trip. */
  mediaBootstrap: (limit?: number, salt?: number) =>
    invoke<MediaBootstrap>("media_bootstrap", { limit: limit ?? null, salt: salt ?? null }),
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
};

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