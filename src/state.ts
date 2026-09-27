import { api } from "./api";
import type {
  AppTile,
  MediaItem,
  Settings,
  SystemInfo,
  UserProfile,
  UsageStats,
} from "./types";

export type TabId = "home" | "movies" | "shows" | "apps" | "search" | "settings";

export interface Shelf {
  id: string;
  title: string;
  /** Small badge shown next to the title, e.g. the genre or an engine name. */
  badge?: string;
  kind: "apps" | "media";
  apps: AppTile[];
  items: MediaItem[];
}

export interface StoreState {
  settings: Settings;
  apps: AppTile[];
  usage: UsageStats;
  catalog: MediaItem[];
  recommendations: MediaItem[];
  profile: UserProfile;
  systemInfo: SystemInfo | null;
  audio: { volume: number | null; muted: boolean | null };
  tab: TabId;
  scanning: boolean;
  syncing: boolean;
  lastSync: number;
  /** Bumped by "Shuffle" to re-roll the recommendation jitter. */
  salt: number;
  /** Revision of the app list currently held (see the `apps-scanned` event). */
  appsRevision: number;
  ready: boolean;
}

const EMPTY_SETTINGS: Settings = {
  schema: 1,
  confirmLaunch: false,
  hideOnLaunch: true,
  autostart: false,
  soundEffects: true,
  animations: true,
  parallax: true,
  doubleClickToOpen: false,
  fullscreenOnStart: false,
  alwaysOnTop: false,
  showClock: true,
  clock24h: true,
  showLabels: true,
  showHints: true,
  escapeQuits: false,
  aodEnabled: true,
  aodTimeoutMins: 5,
  aodDim: 65,
  aodStyle: "clock",
  theme: "dark",
  accent: "#0a84ff",
  backgroundStyle: "dynamic",
  backgroundImage: null,
  backgroundBlur: 60,
  backgroundDim: 55,
  tileSize: "medium",
  iconsPerRow: 7,
  rowsPerPage: 2,
  cornerRadius: 14,
  showTopShelf: true,
  topShelfInterval: 9,
  rowSpacing: 34,
  labelStyle: "auto",
  showRowTitles: true,
  sortMode: "category",
  groupByCategory: true,
  hiddenApps: [],
  favorites: [],
  pinnedApps: [],
  rows: [],
  maxRecent: 24,
  showNoDisplay: false,
  showHidden: false,
  volume: 50,
  muted: false,
  mediaEnabled: true,
  mediaGenres: [],
  mediaHero: true,
  mediaRefreshHours: 24,
  mediaShelfSize: 14,
};

class Store {
  state: StoreState = {
    settings: EMPTY_SETTINGS,
    apps: [],
    usage: { apps: {} },
    catalog: [],
    recommendations: [],
    profile: {
      genres: {},
      liked: [],
      disliked: [],
      watched: [],
      clicks: {},
      searches: [],
      updated: 0,
    },
    systemInfo: null,
    audio: { volume: null, muted: null },
    tab: "home",
    scanning: true,
    syncing: false,
    lastSync: 0,
    salt: 1,
    appsRevision: 0,
    ready: false,
  };

  private listeners = new Set<() => void>();
  /** Fires only when the settings object itself is replaced. */
  private settingsListeners = new Set<(settings: Settings) => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Watch for settings patches.
   *
   * Nothing else subscribes to the store, so settings used to stay invisible
   * until the next full repaint (a tab switch): theme, accent, labels, hints,
   * tile size… all looked dead until that point. This hook lets the shell
   * re-apply them the moment they change.
   */
  onSettingsChange(listener: (settings: Settings) => void): () => void {
    this.settingsListeners.add(listener);
    return () => this.settingsListeners.delete(listener);
  }

  notify(): void {
    for (const listener of this.listeners) listener();
  }

  set(patch: Partial<StoreState>): void {
    const settingsChanged = patch.settings !== undefined && patch.settings !== this.state.settings;
    Object.assign(this.state, patch);
    this.notify();
    if (settingsChanged) {
      for (const listener of this.settingsListeners) listener(this.state.settings);
    }
  }
}

/** Debounce handle for settings persistence. */
let saveTimer: number | null = null;

/** Single shared store instance for the whole app. */
export const store = new Store();
export { EMPTY_SETTINGS };

/**
 * Derived lookups, rebuilt only when their inputs change.
 *
 * Every helper below keys its cache on the *identity* of the store slices it
 * reads. `store.set` always swaps those objects, so reference equality is a
 * sound invalidation signal and no explicit bookkeeping is needed.
 */

let setsKey: Settings | null = null;
let hiddenSet = new Set<string>();
let favoriteSet = new Set<string>();

/** Membership sets for `settings.hiddenApps` / `settings.favorites`. */
export function settingsSets(settings: Settings = store.state.settings): {
  hidden: Set<string>;
  favorites: Set<string>;
} {
  if (setsKey !== settings) {
    setsKey = settings;
    hiddenSet = new Set(settings.hiddenApps);
    favoriteSet = new Set(settings.favorites);
  }
  return { hidden: hiddenSet, favorites: favoriteSet };
}

let mediaKey: readonly [MediaItem[], MediaItem[]] | null = null;
let mediaIndex = new Map<string, MediaItem>();

/**
 * `id → MediaItem` lookup across recommendations and the catalogue.
 *
 * Recommendations win on a collision, matching the previous
 * `[...recommendations, ...catalog].find(...)` order — but without allocating a
 * merged array on every focus change.
 */
export function mediaById(): Map<string, MediaItem> {
  const { recommendations, catalog } = store.state;
  if (!mediaKey || mediaKey[0] !== recommendations || mediaKey[1] !== catalog) {
    mediaKey = [recommendations, catalog];
    mediaIndex = new Map();
    for (const item of catalog) mediaIndex.set(item.id, item);
    for (const item of recommendations) mediaIndex.set(item.id, item);
  }
  return mediaIndex;
}

let appsByIdKey: AppTile[] | null = null;
let appsById = new Map<string, AppTile>();

/** `id → AppTile` lookup for the app list. */
export function appById(): Map<string, AppTile> {
  const { apps } = store.state;
  if (appsByIdKey !== apps) {
    appsByIdKey = apps;
    appsById = new Map();
    for (const app of apps) appsById.set(app.id, app);
  }
  return appsById;
}

let usageKey: UsageStats | null = null;
let usageCounts: Map<string, number> = new Map();
let usageRecent: Map<string, number> = new Map();

/** `id → launch count` / `id → last used` for the Most Used / Recent rows. */
export function usageMaps(): { counts: Map<string, number>; recent: Map<string, number> } {
  const { usage } = store.state;
  if (usageKey !== usage) {
    usageKey = usage;
    usageCounts = new Map();
    usageRecent = new Map();
    for (const [id, entry] of Object.entries(usage.apps)) {
      usageCounts.set(id, entry.count);
      usageRecent.set(id, entry.lastUsed);
    }
  }
  return { counts: usageCounts, recent: usageRecent };
}

let profileKey: UserProfile | null = null;
let likedSet = new Set<string>();
let dislikedSet = new Set<string>();
let watchedSet = new Set<string>();

/** Membership sets for the taste profile's liked / disliked / watched lists. */
export function profileSets(): {
  liked: Set<string>;
  disliked: Set<string>;
  watched: Set<string>;
} {
  const { profile } = store.state;
  if (profileKey !== profile) {
    profileKey = profile;
    likedSet = new Set(profile.liked);
    dislikedSet = new Set(profile.disliked);
    watchedSet = new Set(profile.watched);
  }
  return { liked: likedSet, disliked: dislikedSet, watched: watchedSet };
}

/** Switch the active tab (used by the top bar). */
export function selectTab(tab: TabId): void {
  store.set({ tab });
}

/** Derived helpers + Rust round trips. Kept out of the class for clarity. */
export const actions = {
  /** Load everything the launcher needs to paint the home screen. */
  async bootstrap(): Promise<void> {
    store.set({ scanning: true });
    const [settings, apps, usage, systemInfo, audio] = await Promise.all([
      api.getSettings().catch(() => EMPTY_SETTINGS),
      api.listApps().catch(() => [] as AppTile[]),
      api.getUsage().catch(() => ({ apps: {} })),
      api.getSystemInfo().catch(() => null),
      // Read the real mixer state: the saved `volume`/`muted` settings are
      // only a fallback, otherwise Control Centre opens showing a volume the
      // system does not actually have.
      api.getAudio().catch(() => [null, null] as [number | null, boolean | null]),
    ]);
    // Record the revision we actually hold, so the boot scan's `apps-scanned`
    // event refetches only if it produced a newer list.
    const appsRevision = await api.appsRevision().catch(() => 0);
    store.set({
      settings,
      apps,
      usage,
      systemInfo,
      appsRevision,
      audio: { volume: audio[0] ?? settings.volume, muted: audio[1] ?? settings.muted },
      scanning: false,
      ready: true,
    });
    void actions.loadMedia();
  },

  async refreshApps(): Promise<void> {
    store.set({ scanning: true });
    const [apps, appsRevision] = await Promise.all([
      api.listApps().catch(() => store.state.apps),
      api.appsRevision().catch(() => store.state.appsRevision),
    ]);
    store.set({ apps, appsRevision, scanning: false });
    const info = await api.getSystemInfo().catch(() => null);
    if (info) store.set({ systemInfo: info });
  },

  /**
   * Handle an `apps-scanned` event.
   *
   * The event carries a revision instead of the whole list, so a stale
   * notification costs nothing and the tiles are refetched at most once per
   * real change.
   */
  async refreshIfStale(revision: number): Promise<void> {
    if (revision <= store.state.appsRevision) return;
    await actions.refreshApps();
  },

  /**
   * Load the catalogue, the profile, the first ranking and the engine status.
   *
   * This used to be four separate invokes; it is now a single round trip.
   */
  async loadMedia(): Promise<void> {
    const { settings, salt } = store.state;
    if (!settings.mediaEnabled) return;
    const limit = Math.max(settings.mediaShelfSize * 3, 14);
    const payload = await api.mediaBootstrap(limit, salt).catch(() => null);
    if (!payload) return;
    store.set({
      catalog: payload.catalog,
      profile: payload.profile,
      recommendations: payload.recommendations,
      lastSync: payload.status?.lastSync ?? store.state.lastSync,
    });
  },

  /** Re-sync the catalogue from IMDb (genre seeds from Settings). */
  async syncCatalog(): Promise<void> {
    if (store.state.syncing) return;
    store.set({ syncing: true });
    try {
      const catalog = await api.mediaCatalog(true);
      store.set({ catalog });
      await actions.reshuffle();
      const status = await api.mediaStatus().catch(() => null);
      if (status) store.set({ lastSync: status.lastSync });
    } catch (error) {
      console.warn("catalogue sync failed", error);
      throw error;
    } finally {
      store.set({ syncing: false });
    }
  },

  /** Re-rank with a new jitter salt (the "Shuffle" button). */
  async reshuffle(): Promise<void> {
    const { settings, salt } = store.state;
    if (!settings.mediaEnabled) {
      store.set({ recommendations: [] });
      return;
    }
    const nextSalt = salt + 1;
    const recommendations = await api
      .mediaRecommendations(settings.mediaShelfSize * 3, nextSalt)
      .catch(() => store.state.recommendations);
    store.set({ recommendations, salt: nextSalt });
  },

  /** Teach the engine and refresh the shelves with the new ranking. */
  async feedback(item: MediaItem, action: string): Promise<void> {
    try {
      const result = await api.mediaFeedback(
        item,
        action,
        store.state.settings.mediaShelfSize * 3,
        store.state.salt,
      );
      store.set({
        recommendations: result.recommendations,
        profile: result.profile,
      });
      if (action === "like" && result.catalogSize > store.state.catalog.length) {
        const catalog = await api.mediaCatalog(false).catch(() => store.state.catalog);
        store.set({ catalog });
      }
    } catch (error) {
      console.warn("feedback failed", error);
    }
  },

  async resetProfile(): Promise<void> {
    const profile = await api.mediaResetProfile().catch(() => store.state.profile);
    store.set({ profile });
    await actions.reshuffle();
  },

  /** Apply a settings patch: optimistic locally, persisted in the backend. */
  patchSettings(patch: Partial<Settings>): void {
    const settings = { ...store.state.settings, ...patch };
    store.set({ settings });
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      void api
        .saveSettings(settings)
        .then((saved) => {
          // Skip the echo when the backend returned what we already hold, and
          // never clobber a newer patch that landed while the save was in
          // flight — both used to trigger a pointless full re-render.
          if (!saved || store.state.settings !== settings) return;
          if (JSON.stringify(saved) !== JSON.stringify(settings)) store.set({ settings: saved });
        })
        .catch((error) => console.error("saving settings failed", error));
    }, 220);
  },

  async resetSettings(): Promise<void> {
    const settings = await api.resetSettings().catch(() => EMPTY_SETTINGS);
    store.set({ settings });
  },

  async quit(): Promise<void> {
    await api.quit().catch(() => undefined);
  },
};