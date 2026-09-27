import {
  profileSets,
  settingsSets,
  store,
  usageMaps,
  type Shelf,
  type TabId,
} from "./state";
import type { AppTile, MediaItem, Settings } from "./types";

/** Preferred order for category rows; everything else follows alphabetically. */
const CATEGORY_ORDER = [
  "Internet",
  "Productivity",
  "Entertainment",
  "Music",
  "Graphics",
  "Games",
  "Developer",
  "Social",
  "System",
  "Utilities",
  "Education",
  "Science",
  "Other",
];

function categoryRank(name: string): number {
  const index = CATEGORY_ORDER.indexOf(name);
  return index === -1 ? CATEGORY_ORDER.length : index;
}

/** Apps the launcher should show right now. */
export function visibleApps(apps: AppTile[], settings: Settings): AppTile[] {
  const { hidden } = settingsSets(settings);
  return apps.filter((app) => {
    if (!settings.showNoDisplay && app.noDisplay) return false;
    if (!settings.showHidden && hidden.has(app.id)) return false;
    return true;
  });
}

function sortByName(apps: AppTile[]): AppTile[] {
  return [...apps].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }),
  );
}

/** Sort by launch count or recency using the cached usage maps. */
function byUsage(apps: AppTile[], mode: "count" | "recent"): AppTile[] {
  const maps = usageMaps();
  const usage = mode === "count" ? maps.counts : maps.recent;
  return [...apps].sort((a, b) => {
    const leftValue = usage.get(a.id) ?? 0;
    const rightValue = usage.get(b.id) ?? 0;
    if (rightValue !== leftValue) return rightValue - leftValue;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

function appShelf(id: string, title: string, badge: string, apps: AppTile[]): Shelf {
  return { id, title, badge, kind: "apps", apps, items: [] };
}

function mediaShelf(id: string, title: string, badge: string, items: MediaItem[]): Shelf {
  return { id, title, badge, kind: "media", apps: [], items };
}

const MOVIE_KINDS = ["Movie", "TV Movie"];
const SHOW_KINDS = ["TV Series", "TV Mini-Series"];

function matchesKind(item: MediaItem, kinds: string[]): boolean {
  return kinds.some((kind) => item.kind === kind);
}

function rankSort(items: MediaItem[]): MediaItem[] {
  return [...items].sort((a, b) => a.rank - b.rank);
}

/** Genres the profile currently likes most, strongest first. */
export function topGenres(limit = 3): string[] {
  return Object.entries(store.state.profile.genres)
    .filter(([, weight]) => weight > 0.3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([genre]) => genre);
}

/**
 * Media shelves for one tab. `kindFilter` narrows to films or series; `null`
 * mixes both, which is what the Apple TV app does on "Watch Now".
 */
function mediaShelves(tab: TabId, kindFilter: string[] | null): Shelf[] {
  const { settings, catalog, recommendations } = store.state;
  if (!settings.mediaEnabled) return [];
  const disliked = profileSets().disliked;
  const size = Math.max(6, settings.mediaShelfSize);
  const pass = (item: MediaItem): boolean =>
    !disliked.has(item.id) && (!kindFilter || matchesKind(item, kindFilter));

  const shelves: Shelf[] = [];
  const picks = recommendations.filter(pass).slice(0, size);
  if (picks.length) {
    shelves.push(
      mediaShelf(
        `${tab}-picks`,
        tab === "home" ? "Top Picks for You" : `Top Picks · ${tab === "movies" ? "Movies" : "TV"}`,
        "For You",
        picks,
      ),
    );
  }

  // Filter and rank the catalogue once, then bucket by genre. The previous
  // version re-filtered and re-sorted the whole catalogue for every shelf.
  const passing = rankSort(catalog.filter(pass));
  const byGenre = new Map<string, MediaItem[]>();
  for (const item of passing) {
    const bucket = byGenre.get(item.genre);
    if (bucket) bucket.push(item);
    else byGenre.set(item.genre, [item]);
  }

  for (const genre of topGenres(3)) {
    const items = (byGenre.get(genre) ?? []).slice(0, size);
    if (items.length >= 3) {
      shelves.push(mediaShelf(`${tab}-like-${genre}`, `Because you like ${genre}`, genre, items));
    }
  }

  const trending = passing.slice(0, size);
  if (trending.length) {
    const title =
      tab === "movies"
        ? "Trending Movies on IMDb"
        : tab === "shows"
          ? "Trending Series on IMDb"
          : "Trending on IMDb";
    shelves.push(mediaShelf(`${tab}-trending`, title, "IMDb", trending));
  }

  for (const genre of [...byGenre.keys()].slice(0, 6)) {
    const items = (byGenre.get(genre) ?? []).slice(0, size);
    if (items.length >= 3) {
      shelves.push(mediaShelf(`${tab}-${genre}`, genre, "IMDb", items));
    }
  }
  return shelves;
}

function sortApps(apps: AppTile[], mode: string): AppTile[] {
  if (mode === "name") return sortByName(apps);
  if (mode === "usage") return byUsage(apps, "count");
  // Default: sort alphabetically within whatever grouping is active.
  return sortByName(apps);
}

function appShelves(limitCategories: number): Shelf[] {
  const { settings, apps } = store.state;
  const { counts, recent: recentMap } = usageMaps();
  const list = visibleApps(apps, settings);
  // Waydroid (Android) apps live on their own row, separate from Linux apps.
  const android = list.filter((app) => app.isWaydroid);
  const linux = list.filter((app) => !app.isWaydroid);
  const shelves: Shelf[] = [];

  if (android.length) {
    shelves.push(appShelf("android", "Android Apps", "Waydroid", sortApps(android, settings.sortMode)));
  }

  // Index the Linux apps once; the favourites and custom rows used to run a
  // linear `find` over the list for every configured id.
  const linuxById = new Map<string, AppTile>();
  for (const app of linux) linuxById.set(app.id, app);

  const favorites = settings.favorites
    .map((id) => linuxById.get(id))
    .filter((app): app is AppTile => Boolean(app));
  if (favorites.length) {
    shelves.push(appShelf("favorites", "Favorites", "Pinned", favorites));
  }

  const recent = byUsage(linux, "recent").filter((app) => (recentMap.get(app.id) ?? 0) > 0);
  if (recent.length) {
    shelves.push(appShelf("recent", "Recently Used", "Up Next", recent.slice(0, settings.maxRecent)));
  }

  const mostUsed = byUsage(linux, "count").filter((app) => (counts.get(app.id) ?? 0) > 1);
  if (mostUsed.length >= 3) {
    shelves.push(appShelf("most-used", "Most Used", "Smart", mostUsed.slice(0, settings.maxRecent)));
  }

  if (!settings.groupByCategory) {
    shelves.push(appShelf("all", "All Apps", "Library", sortApps(linux, settings.sortMode)));
    return shelves;
  }

  for (const row of settings.rows.filter((entry) => entry.source === "manual")) {
    const custom = row.appIds
      .map((id) => linuxById.get(id))
      .filter((app): app is AppTile => Boolean(app));
    if (custom.length) shelves.push(appShelf(`custom-${row.id}`, row.title, "Custom", custom));
  }

  const groups = new Map<string, AppTile[]>();
  for (const app of linux) {
    const key = app.group || "Other";
    const bucket = groups.get(key);
    if (bucket) bucket.push(app);
    else groups.set(key, [app]);
  }
  const ordered = [...groups.entries()].sort((a, b) => {
    const rank = categoryRank(a[0]) - categoryRank(b[0]);
    return rank !== 0 ? rank : b[1].length - a[1].length;
  });
  let shown = 0;
  for (const [category, categoryApps] of ordered) {
    if (limitCategories > 0 && shown >= limitCategories) break;
    shelves.push(
      appShelf(`cat-${category}`, category, `${categoryApps.length}`, sortApps(categoryApps, settings.sortMode)),
    );
    shown += 1;
  }
  return shelves;
}

/** All shelves for a tab, in the order they appear on screen. */
export function shelvesFor(tab: TabId): Shelf[] {
  switch (tab) {
    case "home":
      return [...mediaShelves("home", null), ...appShelves(4)];
    case "movies":
      return mediaShelves("movies", MOVIE_KINDS);
    case "shows":
      return mediaShelves("shows", SHOW_KINDS);
    case "apps":
      return appShelves(0);
    default:
      return [];
  }
}

let indexKey: AppTile[] | null = null;
let indexSettings: Settings | null = null;
let haystacks = new Map<string, string>();
let indexedApps: AppTile[] = [];

/**
 * Lowercased search text per app.
 *
 * The old helper rebuilt `[...fields].filter(Boolean).join(" ").toLowerCase()`
 * for every app on every keystroke; this keeps one haystack per app and only
 * rebuilds when the app list or the visibility settings change.
 */
function appSearchIndex(): { index: Map<string, string>; apps: AppTile[] } {
  const { apps, settings } = store.state;
  if (indexKey !== apps || indexSettings !== settings) {
    indexKey = apps;
    indexSettings = settings;
    indexedApps = visibleApps(apps, settings);
    haystacks = new Map();
    for (const app of indexedApps) {
      haystacks.set(
        app.id,
        [app.name, app.genericName, app.comment, app.group, ...app.keywords]
          .filter(Boolean)
          .join(" ")
          .toLowerCase(),
      );
    }
  }
  return { index: haystacks, apps: indexedApps };
}

/** Local app matches for the search overlay. */
export function searchApps(query: string): AppTile[] {
  const needle = query.trim().toLowerCase();
  if (needle.length < 1) return [];
  const { index, apps } = appSearchIndex();
  const out: AppTile[] = [];
  for (const app of apps) {
    if (index.get(app.id)?.includes(needle)) {
      out.push(app);
      if (out.length >= 40) break;
    }
  }
  return out;
}

let catalogKey: MediaItem[] | null = null;
let catalogLower: [string, MediaItem][] = [];

/** Lowercased catalogue titles, rebuilt only when the catalogue changes. */
function catalogIndex(): [string, MediaItem][] {
  const { catalog } = store.state;
  if (catalogKey !== catalog) {
    catalogKey = catalog;
    catalogLower = catalog.map((item): [string, MediaItem] => [item.title.toLowerCase(), item]);
  }
  return catalogLower;
}

/** Local cover-art matches so search feels instant before IMDb answers. */
export function searchCatalog(query: string): MediaItem[] {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return [];
  const out: MediaItem[] = [];
  for (const [title, item] of catalogIndex()) {
    if (title.includes(needle)) {
      out.push(item);
      if (out.length >= 24) break;
    }
  }
  return out;
}