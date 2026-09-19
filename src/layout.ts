import { store, type Shelf, type TabId } from "./state";
import type { AppInfo, MediaItem, Settings } from "./types";

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
export function visibleApps(apps: AppInfo[], settings: Settings): AppInfo[] {
  const hidden = new Set(settings.hiddenApps);
  return apps.filter((app) => {
    if (!settings.showNoDisplay && app.noDisplay) return false;
    if (!settings.showHidden && hidden.has(app.id)) return false;
    return true;
  });
}

function sortByName(apps: AppInfo[]): AppInfo[] {
  return [...apps].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }),
  );
}

function byUsage(apps: AppInfo[], mode: "count" | "recent"): AppInfo[] {
  const usage = store.state.usage.apps;
  return [...apps].sort((a, b) => {
    const left = usage[a.id];
    const right = usage[b.id];
    const leftValue = mode === "count" ? left?.count ?? 0 : left?.lastUsed ?? 0;
    const rightValue = mode === "count" ? right?.count ?? 0 : right?.lastUsed ?? 0;
    if (rightValue !== leftValue) return rightValue - leftValue;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

function appShelf(id: string, title: string, badge: string, apps: AppInfo[]): Shelf {
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
  const { settings, catalog, recommendations, profile } = store.state;
  if (!settings.mediaEnabled) return [];
  const disliked = new Set(profile.disliked);
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

  for (const genre of topGenres(3)) {
    const items = rankSort(catalog.filter((item) => pass(item) && item.genre === genre)).slice(0, size);
    if (items.length >= 3) {
      shelves.push(mediaShelf(`${tab}-like-${genre}`, `Because you like ${genre}`, genre, items));
    }
  }

  const trending = rankSort(catalog.filter(pass)).slice(0, size);
  if (trending.length) {
    const title =
      tab === "movies"
        ? "Trending Movies on IMDb"
        : tab === "shows"
          ? "Trending Series on IMDb"
          : "Trending on IMDb";
    shelves.push(mediaShelf(`${tab}-trending`, title, "IMDb", trending));
  }

  const genres = [...new Set(catalog.filter(pass).map((item) => item.genre))];
  for (const genre of genres.slice(0, 6)) {
    const items = rankSort(catalog.filter((item) => pass(item) && item.genre === genre)).slice(0, size);
    if (items.length >= 3) {
      shelves.push(mediaShelf(`${tab}-${genre}`, genre, "IMDb", items));
    }
  }
  return shelves;
}

function appShelves(limitCategories: number): Shelf[] {
  const { settings, apps, usage } = store.state;
  const list = visibleApps(apps, settings);
  const shelves: Shelf[] = [];

  const favorites = settings.favorites
    .map((id) => list.find((app) => app.id === id))
    .filter((app): app is AppInfo => Boolean(app));
  if (favorites.length) {
    shelves.push(appShelf("favorites", "Favorites", "Pinned", favorites));
  }

  const recent = byUsage(list, "recent").filter((app) => (usage.apps[app.id]?.lastUsed ?? 0) > 0);
  if (recent.length) {
    shelves.push(appShelf("recent", "Recently Used", "Up Next", recent.slice(0, settings.maxRecent)));
  }

  const mostUsed = byUsage(list, "count").filter((app) => (usage.apps[app.id]?.count ?? 0) > 1);
  if (mostUsed.length >= 3) {
    shelves.push(appShelf("most-used", "Most Used", "Smart", mostUsed.slice(0, settings.maxRecent)));
  }

  if (!settings.groupByCategory) {
    shelves.push(appShelf("all", "All Apps", "Library", sortByName(list)));
    return shelves;
  }

  for (const row of settings.rows.filter((entry) => entry.source === "manual")) {
    const custom = row.appIds
      .map((id) => list.find((app) => app.id === id))
      .filter((app): app is AppInfo => Boolean(app));
    if (custom.length) shelves.push(appShelf(`custom-${row.id}`, row.title, "Custom", custom));
  }

  const groups = new Map<string, AppInfo[]>();
  for (const app of list) {
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
    shelves.push(appShelf(`cat-${category}`, category, `${categoryApps.length}`, sortByName(categoryApps)));
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

/** Local app matches for the search overlay. */
export function searchApps(query: string): AppInfo[] {
  const needle = query.trim().toLowerCase();
  if (needle.length < 1) return [];
  return visibleApps(store.state.apps, store.state.settings)
    .filter((app) => {
      const haystack = [app.name, app.genericName, app.comment, app.group, ...app.keywords]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    })
    .slice(0, 40);
}

/** Local cover-art matches so search feels instant before IMDb answers. */
export function searchCatalog(query: string): MediaItem[] {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return [];
  return store.state.catalog
    .filter((item) => item.title.toLowerCase().includes(needle))
    .slice(0, 24);
}