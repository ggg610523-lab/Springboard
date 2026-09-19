/**
 * TypeScript mirrors of the Rust structs. Field names match the camelCase
 * wire format produced by `serde(rename_all = "camelCase")`.
 */

export interface AppInfo {
  id: string;
  name: string;
  genericName: string | null;
  comment: string | null;
  exec: string;
  iconPath: string | null;
  iconName: string | null;
  categories: string[];
  keywords: string[];
  terminal: boolean;
  desktopFile: string;
  isFlatpak: boolean;
  isSnap: boolean;
  startupWmClass: string | null;
  noDisplay: boolean;
  group: string;
}

export interface UsageEntry {
  count: number;
  lastUsed: number;
}

export interface UsageStats {
  apps: Record<string, UsageEntry>;
}

export interface RowDef {
  id: string;
  title: string;
  source: string;
  appIds: string[];
}

export interface Settings {
  schema: number;

  confirmLaunch: boolean;
  hideOnLaunch: boolean;
  autostart: boolean;
  soundEffects: boolean;
  animations: boolean;
  parallax: boolean;
  doubleClickToOpen: boolean;
  fullscreenOnStart: boolean;
  alwaysOnTop: boolean;
  showClock: boolean;
  clock24h: boolean;
  showLabels: boolean;
  showHints: boolean;
  escapeQuits: boolean;

  // ── Always-On Display ──────────────────────────────────────────────────────
  /** Full screen ambient clock after a period of inactivity. */
  aodEnabled: boolean;
  /** Minutes of inactivity before the AOD fades in. */
  aodTimeoutMins: number;
  /** Dim intensity 0–100 while the AOD is shown. */
  aodDim: number;
  /** `clock`, `clock-weather`, `poster-wall` */
  aodStyle: string;

  theme: string;
  accent: string;
  backgroundStyle: string;
  backgroundImage: string | null;
  backgroundBlur: number;
  backgroundDim: number;
  tileSize: string;
  iconsPerRow: number;
  rowsPerPage: number;
  cornerRadius: number;
  showTopShelf: boolean;
  topShelfInterval: number;
  rowSpacing: number;
  labelStyle: string;
  showRowTitles: boolean;

  sortMode: string;
  groupByCategory: boolean;
  hiddenApps: string[];
  favorites: string[];
  pinnedApps: string[];
  rows: RowDef[];
  maxRecent: number;
  showNoDisplay: boolean;
  /** Reveal apps the user hid with the tile context menu. */
  showHidden: boolean;

  volume: number;
  muted: boolean;

  // ── Recommendations (IMDb) ────────────────────────────────────────────────
  /** Master switch for the recommendation engine. */
  mediaEnabled: boolean;
  /** Genre seeds in use; empty means every seed. */
  mediaGenres: string[];
  /** Show recommended titles on the Top Shelf. */
  mediaHero: boolean;
  /** How often the catalogue resyncs from IMDb. */
  mediaRefreshHours: number;
  /** Titles per recommendation shelf. */
  mediaShelfSize: number;
}

export interface SystemInfo {
  launcherVersion: string;
  appCount: number;
  configPath: string;
  hostname: string;
  os: string;
  desktop: string;
  sessionType: string;
  iconThemes: string[];
  terminal: string | null;
  hasPactl: boolean;
  hasGtkLaunch: boolean;
  hasFlatpak: boolean;
}

export interface DirEntryInfo {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

export interface DirListing {
  path: string;
  parent: string | null;
  entries: DirEntryInfo[];
}

export interface LaunchResult {
  id: string;
  name: string;
  ok: boolean;
  method: string;
  message: string;
}

/** One IMDb title that can be recommended (see `src-tauri/src/media.rs`). */
export interface MediaItem {
  id: string;
  title: string;
  year: string | null;
  /** `Movie`, `TV Series`, `TV Mini-Series`, ... */
  kind: string;
  stars: string | null;
  /** Remote Amazon/IMDb cover art URL. */
  poster: string | null;
  genre: string;
  /** IMDb popularity rank; lower is more popular. */
  rank: number;
}

/** Everything the recommendation engine learned from the user. */
export interface UserProfile {
  genres: Record<string, number>;
  liked: string[];
  disliked: string[];
  watched: string[];
  clicks: Record<string, number>;
  searches: string[];
  updated: number;
}

export interface MediaStatus {
  online: boolean;
  catalog: number;
  posters: number;
  posterBytes: number;
  feedbackEvents: number;
  lastSync: number;
  provider: string;
  cacheDir: string;
  seeds: string[];
}

export interface MediaFeedbackResult {
  recommendations: MediaItem[];
  profile: UserProfile;
  catalogSize: number;
}

/** A focusable target understood by the focus engine. */
export interface FocusTarget {
  el: HTMLElement;
  zone: string;
  /** Called when the target is focused by the focus engine. */
  onFocus?: () => void;
  /** Called on Enter / click. */
  onActivate?: () => void;
  /** Skip this element while navigating. */
  disabled?: () => boolean;
  /** Remembered position inside its zone for "return focus" behaviour. */
  key?: string;
}