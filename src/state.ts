import { api, setAppIndex } from "./api";
import type {
  AppInfo,
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
  apps: AppInfo[];
  items: MediaItem[];
}

export interface StoreState {
  settings: Settings;
  apps: AppInfo[];
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
    ready: false,
  };

  private listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(): void {
    for (const listener of this.listeners) listener();
  }

  set(patch: Partial<StoreState>): void {
    Object.assign(this.state, patch);
    this.notify();
  }
}

/** Debounce handle for settings persistence. */
let saveTimer: number | null = null;

/** Single shared store instance for the whole app. */
export const store = new Store();
export { EMPTY_SETTINGS };

/** Switch the active tab (used by the top bar). */
export function selectTab(tab: TabId): void {
  store.set({ tab });
}

/** Derived helpers + Rust round trips. Kept out of the class for clarity. */
export const actions = {
  /** Load everything the launcher needs to paint the home screen. */
  async bootstrap(): Promise<void> {
    store.set({ scanning: true });
    const [settings, apps, usage, systemInfo] = await Promise.all([
      api.getSettings().catch(() => EMPTY_SETTINGS),
      api.listApps().catch(() => [] as AppInfo[]),
      api.getUsage().catch(() => ({ apps: {} })),
      api.getSystemInfo().catch(() => null),
    ]);
    setAppIndex(apps);
    store.set({
      settings,
      apps,
      usage,
      systemInfo,
      audio: { volume: settings.volume, muted: settings.muted },
      scanning: false,
      ready: true,
    });
    void actions.loadMedia();
  },

  async refreshApps(): Promise<void> {
    store.set({ scanning: true });
    const apps = await api.rescanApps().catch(() => store.state.apps);
    setAppIndex(apps);
    store.set({ apps, scanning: false, systemInfo: store.state.systemInfo });
    const info = await api.getSystemInfo().catch(() => null);
    if (info) store.set({ systemInfo: info });
  },

  /** Load the IMDb catalogue and the first set of recommendations. */
  async loadMedia(): Promise<void> {
    if (!store.state.settings.mediaEnabled) return;
    const catalog = await api.mediaCatalog(false).catch(() => [] as MediaItem[]);
    const profile = await api.mediaProfile().catch(() => store.state.profile);
    store.set({ catalog, profile });
    await actions.reshuffle();
    const status = await api.mediaStatus().catch(() => null);
    if (status) store.set({ lastSync: status.lastSync });
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
          if (saved) store.set({ settings: saved });
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