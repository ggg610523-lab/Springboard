import { iconUrl, posterUrl } from "../api";
import { focusEngine, makeFocusable } from "../focus/focus-engine";
import { setBodyWash, washFor } from "../palette";
import { sound } from "../sound";
import { actions, mediaById, store } from "../state";
import type { AppTile, MediaItem } from "../types";
import { el, icon } from "./icons";
import { launchApp, mediaFeedback, openAppMenu, openMedia } from "./tiles";
import { toast } from "./overlay";

interface HeroState {
  mode: "featured" | "app" | "media";
  app?: AppTile;
  item?: MediaItem;
  index: number;
  /** True while focus lives inside the hero, so the content stays put. */
  pinned: boolean;
}

const state: HeroState = { mode: "featured", index: 0, pinned: false };
let rotateTimer: number | null = null;

function featuredItems(): MediaItem[] {
  const { settings, recommendations } = store.state;
  return recommendations.slice(0, Math.max(6, settings.mediaShelfSize));
}

function backdrop(url: string | null): void {
  const layer = document.getElementById("backdrop-image");
  if (!layer) return;
  if (url) {
    layer.style.backgroundImage = `url("${url}")`;
    layer.classList.add("is-visible");
  } else {
    layer.classList.remove("is-visible");
  }
}

function topGenreLabel(): string {
  const entries = Object.entries(store.state.profile.genres).sort((a, b) => b[1] - a[1]);
  return entries.length ? `mostly ${entries[0][0]}` : "your taste profile";
}

function fallbackPoster(item: MediaItem): HTMLElement {
  const node = el("div", "poster-fallback");
  const wash = washFor(item.genre || item.title);
  node.style.setProperty("--wash-a", wash.a);
  node.style.setProperty("--wash-b", wash.b);
  node.appendChild(el("span", undefined, item.title));
  return node;
}

/**
 * Reusable hero artwork, keyed by URL.
 *
 * The Top Shelf rebuilds its subtree on every focus change and every rotation
 * tick; making a fresh `<img>` for a poster WebKit had already decoded forced
 * a re-decode each time. Art is stashed by URL when the subtree is swapped
 * and moved back in when the same title comes around, so the 9s rotation loop
 * reuses the same handful of nodes forever. The error listener is attached
 * once at creation and resolves its fallback from `parentElement` at fire
 * time — a URL always maps to the same title, so the closure stays valid.
 */
const artPool = new Map<string, HTMLImageElement>();
const ART_POOL_LIMIT = 8;

function takeArt(src: string, alt: string, buildFallback: () => HTMLElement): HTMLImageElement {
  const hit = artPool.get(src);
  if (hit) {
    artPool.delete(src);
    hit.remove();
    hit.alt = alt;
    return hit;
  }
  const img = el("img");
  img.dataset.artKey = src;
  img.src = src;
  img.alt = alt;
  img.decoding = "async";
  img.addEventListener("error", () => {
    const parent = img.parentElement;
    img.remove();
    if (parent && !parent.firstElementChild) parent.appendChild(buildFallback());
  });
  return img;
}

function stashArt(img: HTMLImageElement): void {
  const key = img.dataset.artKey;
  if (!key) return;
  img.remove();
  // Re-insert to mark it as the most recently used; Map preserves order, so
  // eviction below drops the least recently stashed artwork first.
  artPool.delete(key);
  artPool.set(key, img);
  while (artPool.size > ART_POOL_LIMIT) {
    const oldest = artPool.keys().next();
    if (oldest.done) break;
    artPool.delete(oldest.value);
  }
}

function pill(
  label: string,
  iconName: string | null,
  variant: "primary" | "normal" | "ghost",
  key: string,
  action: () => void,
): HTMLElement {
  const button = el(
    "button",
    `btn${variant === "primary" ? " btn--primary" : variant === "ghost" ? " btn--ghost" : ""}`,
  );
  if (iconName) button.appendChild(icon(iconName, 16));
  button.appendChild(el("span", undefined, label));
  makeFocusable(
    button,
    {
      onFocus: () => {
        sound.focus();
        state.pinned = true;
      },
      onBlur: () => {
        window.setTimeout(() => {
          if (!focusEngine.focused?.closest("#top-shelf")) state.pinned = false;
        }, 0);
      },
      onActivate: () => {
        sound.select();
        action();
      },
    },
    key,
  );
  return button;
}

function metaLine(item: MediaItem): HTMLElement {
  const meta = el("div", "hero-meta");
  meta.appendChild(el("span", "hero-badge", item.kind));
  if (item.year) meta.appendChild(el("span", undefined, item.year));
  if (item.stars) {
    meta.appendChild(el("span", "dot"));
    meta.appendChild(el("span", undefined, item.stars));
  }
  return meta;
}

function renderAppHero(container: HTMLElement, app: AppTile): void {
  const hero = el("div", "hero");
  const art = el("div", "hero-art hero-art--app");
  const src = iconUrl(app.iconName, app.iconPath);
  if (src) {
    art.appendChild(
      takeArt(src, app.name, () => el("div", "tile-art__fallback", app.name.slice(0, 2).toUpperCase())),
    );
  } else {
    art.appendChild(el("div", "tile-art__fallback", app.name.slice(0, 2).toUpperCase()));
  }
  hero.appendChild(art);

  const info = el("div", "hero-info");
  info.appendChild(el("div", "hero-eyebrow", app.group || "Application"));
  info.appendChild(el("h1", "hero-title", app.name));

  const meta = el("div", "hero-meta");
  meta.appendChild(
    el("span", "hero-badge", app.isFlatpak ? "Flatpak" : app.isSnap ? "Snap" : "Native"),
  );
  if (app.genericName) meta.appendChild(el("span", undefined, app.genericName));
  const usage = store.state.usage.apps[app.id];
  if (usage && usage.count > 0) {
    meta.appendChild(el("span", "dot"));
    meta.appendChild(el("span", undefined, `Opened ${usage.count}×`));
  }
  info.appendChild(meta);
  if (app.comment) info.appendChild(el("p", "hero-blurb", app.comment));

  const favorite = store.state.settings.favorites.includes(app.id);
  const actionsRow = el("div", "hero-actions");
  actionsRow.appendChild(pill("Open", "play", "primary", "hero-open", () => launchApp(app)));
  actionsRow.appendChild(
    pill(favorite ? "Favorited" : "Add to Favorites", "star", "normal", "hero-favorite", () => {
      const favorites = favorite
        ? store.state.settings.favorites.filter((id) => id !== app.id)
        : [...store.state.settings.favorites, app.id];
      actions.patchSettings({ favorites });
      toast(
        favorite ? `${app.name} removed from Favorites` : `${app.name} added to Favorites`,
        "ok",
      );
      renderHero();
    }),
  );
  actionsRow.appendChild(pill("More", "info", "ghost", "hero-more", () => openAppMenu(app, actionsRow)));
  info.appendChild(actionsRow);
  hero.appendChild(info);
  container.appendChild(hero);

  const wash = washFor(app.id);
  setBodyWash(wash.a, wash.b);
  backdrop(src);
  focusEngine.registerZone("topshelf", actionsRow, 1);
}

function renderFeatured(container: HTMLElement, items: MediaItem[], index: number): void {
  const item = items[index % items.length];
  if (!item) {
    renderBrandHero(container);
    return;
  }
  const hero = el("div", "hero");
  const art = el("div", "hero-art");
  const src = posterUrl(item);
  if (src) {
    art.appendChild(takeArt(src, item.title, () => fallbackPoster(item)));
  } else {
    art.appendChild(fallbackPoster(item));
  }
  hero.appendChild(art);

  const info = el("div", "hero-info");
  info.appendChild(el("div", "hero-eyebrow", "Top Shelf · Recommended for you"));
  info.appendChild(el("h1", "hero-title", item.title));
  info.appendChild(metaLine(item));
  const taste = topGenreLabel();
  info.appendChild(
    el(
      "p",
      "hero-blurb",
      `Cover art and metadata come straight from IMDb. ${
        taste === "your taste profile" ? "" : `Your taste profile is ${taste}. `
      }Press ↓ to browse the shelves, or search for any title.`,
    ),
  );

  const actionsRow = el("div", "hero-actions");
  actionsRow.appendChild(pill("View on IMDb", "external", "primary", "hero-open", () => openMedia(item)));
  actionsRow.appendChild(
    pill("More Like This", "heart", "normal", "hero-like", () =>
      mediaFeedback(item, "like", "You'll see more like this"),
    ),
  );
  actionsRow.appendChild(
    pill("Shuffle", "shuffle", "ghost", "hero-shuffle", () => {
      void actions.reshuffle().then(() => toast("Recommendations shuffled", "ok"));
    }),
  );
  actionsRow.appendChild(
    pill("Not Interested", "ban", "ghost", "hero-hide", () =>
      mediaFeedback(item, "hide", "You'll see less of this"),
    ),
  );
  info.appendChild(actionsRow);
  hero.appendChild(info);
  container.appendChild(hero);

  if (items.length > 1) {
    const dots = el("div", "hero-dots");
    items.forEach((_, dotIndex) => {
      dots.appendChild(el("span", `hero-dot${dotIndex === index % items.length ? " is-active" : ""}`));
    });
    container.appendChild(dots);
  }

  const wash = washFor(item.genre || item.title);
  setBodyWash(wash.a, wash.b);
  backdrop(src);
  focusEngine.registerZone("topshelf", actionsRow, 1);
}

function renderMediaHero(container: HTMLElement, item: MediaItem): void {
  const hero = el("div", "hero");
  const art = el("div", "hero-art");
  const src = posterUrl(item);
  if (src) {
    art.appendChild(takeArt(src, item.title, () => fallbackPoster(item)));
  } else {
    art.appendChild(fallbackPoster(item));
  }
  hero.appendChild(art);

  const profile = store.state.profile;
  const liked = profile.liked.includes(item.id);
  const disliked = profile.disliked.includes(item.id);
  const watched = profile.watched.includes(item.id);

  const info = el("div", "hero-info");
  info.appendChild(el("div", "hero-eyebrow", item.genre ? `${item.genre} · IMDb Pick` : "IMDb Pick"));
  info.appendChild(el("h1", "hero-title", item.title));
  const meta = metaLine(item);
  if (watched) meta.appendChild(el("span", "hero-badge", "Watched"));
  if (liked) meta.appendChild(el("span", "hero-badge", "Liked"));
  info.appendChild(meta);
  info.appendChild(
    el(
      "p",
      "hero-blurb",
      `Cover art from IMDb, ranked by the launcher's taste engine: popularity plus what you keep coming back to (${topGenreLabel()}).`,
    ),
  );

  const actionsRow = el("div", "hero-actions");
  actionsRow.appendChild(pill("View on IMDb", "external", "primary", "hero-open", () => openMedia(item)));
  actionsRow.appendChild(
    pill(liked ? "Unlike" : "More Like This", "heart", "normal", "hero-like", () => {
      mediaFeedback(
        item,
        liked ? "hide" : "like",
        liked ? "Removed from Top Picks" : "You'll see more like this",
      );
      renderHero();
    }),
  );
  actionsRow.appendChild(
    pill(watched ? "Unwatched" : "Mark Watched", "check", "ghost", "hero-watched", () => {
      mediaFeedback(item, "watched", watched ? "Marked as unwatched" : "Marked as watched");
      renderHero();
    }),
  );
  actionsRow.appendChild(
    pill(disliked ? "Unblock" : "Not Interested", "ban", "ghost", "hero-hide", () => {
      mediaFeedback(item, "hide", disliked ? "Title unblocked" : "You'll see less of this");
      renderHero();
    }),
  );
  actionsRow.appendChild(
    pill("Shuffle", "shuffle", "ghost", "hero-shuffle", () => {
      void actions.reshuffle().then(() => toast("Recommendations shuffled", "ok"));
    }),
  );
  info.appendChild(actionsRow);
  hero.appendChild(info);
  container.appendChild(hero);

  const wash = washFor(item.genre || item.title);
  setBodyWash(wash.a, wash.b);
  backdrop(src);
  focusEngine.registerZone("topshelf", actionsRow, 1);
}

function renderBrandHero(container: HTMLElement): void {
  const hero = el("div", "hero");
  const art = el("div", "hero-art hero-art--app");
  art.appendChild(el("div", "tile-art__fallback", "tv"));
  hero.appendChild(art);

  const info = el("div", "hero-info");
  info.appendChild(el("div", "hero-eyebrow", "Welcome"));
  info.appendChild(el("h1", "hero-title", "Your apps, on the big screen"));
  const meta = el("div", "hero-meta");
  meta.appendChild(el("span", "hero-badge", `${store.state.apps.length} apps found`));
  meta.appendChild(el("span", "hero-badge", store.state.systemInfo?.desktop ?? "Desktop"));
  info.appendChild(meta);
  info.appendChild(
    el(
      "p",
      "hero-blurb",
      "Every installed application is discovered from your desktop entries and launched for real. Sync IMDb to fill the shelves with cover art, or open Settings to tune the look.",
    ),
  );

  const actionsRow = el("div", "hero-actions");
  actionsRow.appendChild(
    pill("Open Settings", "gear", "primary", "hero-settings", () => {
      document.dispatchEvent(new CustomEvent("launcher:open-settings"));
    }),
  );
  actionsRow.appendChild(
    pill("Sync IMDb Art", "refresh", "normal", "hero-sync", () => {
      void actions
        .syncCatalog()
        .then(() => toast("Cover art library synced", "ok"))
        .catch((error: unknown) => toast(String(error), "error"));
    }),
  );
  info.appendChild(actionsRow);
  hero.appendChild(info);
  container.appendChild(hero);
  backdrop(null);
  focusEngine.registerZone("topshelf", actionsRow, 1);
}

/** Full re-render of the Top Shelf for the current state. */
export function renderHero(): void {
  const container = document.getElementById("top-shelf");
  if (!container) return;
  const focused = focusEngine.focused;
  const hadFocus = focused ? container.contains(focused) : false;
  const focusKey = focused ? focusEngine.handlersFor(focused)?.key : undefined;
  if (!store.state.settings.showTopShelf) {
    container.replaceChildren();
    if (hadFocus) focusEngine.rebuild(focusKey);
    return;
  }
  const next = el("div", "topshelf-inner");
  if (state.mode === "app" && state.app) {
    renderAppHero(next, state.app);
  } else if (state.mode === "media" && state.item) {
    renderMediaHero(next, state.item);
  } else {
    const items = featuredItems();
    if (items.length) renderFeatured(next, items, state.index);
    else renderBrandHero(next);
  }
  // Park the outgoing artwork in the reuse pool before it is detached.
  for (const img of container.querySelectorAll<HTMLImageElement>("img")) stashArt(img);
  container.replaceChildren(...next.childNodes);
  // The pills inside the hero were rebuilt: put the remote back on the same
  // one instead of dropping focus on the floor.
  if (hadFocus) focusEngine.rebuild(focusKey);
}

/** Keep the Top Shelf in sync with whatever tile is focused. */
export function setHeroForElement(element: HTMLElement | null): void {
  if (element?.closest("#top-shelf")) {
    state.pinned = true;
    return;
  }
  const appId = element?.dataset.appId;
  if (appId) {
    const app = store.state.apps.find((entry) => entry.id === appId);
    if (app) {
      if (state.mode === "app" && state.app?.id === app.id) return;
      state.mode = "app";
      state.app = app;
      state.item = undefined;
      renderHero();
      return;
    }
  }
  const mediaId = element?.dataset.mediaId;
  if (mediaId) {
    // Cached id → item map; avoids merging two arrays on every focus change.
    const item = mediaById().get(mediaId);
    if (item) {
      if (state.mode === "media" && state.item?.id === item.id) return;
      state.mode = "media";
      state.item = item;
      state.app = undefined;
      renderHero();
      return;
    }
  }
  // Focus sits on the tab bar (or nowhere): hand the Top Shelf back to the
  // featured carousel. It used to stay frozen on the last tile's hero for the
  // rest of the session, so the rotation only ever ran at boot.
  if (state.mode !== "featured") {
    state.mode = "featured";
    state.app = undefined;
    state.item = undefined;
    state.pinned = false;
    renderHero();
  }
}

/** Force the Top Shelf back to the featured rotation. */
export function resetHeroToFeatured(): void {
  state.mode = "featured";
  state.pinned = false;
  renderHero();
}

/** Restart the automatic Top Shelf carousel (Settings → Top Shelf interval). */
export function startHeroRotation(): void {
  if (rotateTimer !== null) {
    window.clearInterval(rotateTimer);
    rotateTimer = null;
  }
  if (!store.state.settings.showTopShelf) return;
  const seconds = Math.max(3, store.state.settings.topShelfInterval);
  rotateTimer = window.setInterval(() => {
    const items = featuredItems();
    if (state.mode !== "featured" || items.length < 2) return;
    // Only cycle while the hero is *not* the focused region. The old check was
    // inverted: it rotated exactly while the remote sat on the hero's pills
    // (rebuilding the content underneath the focused element) and froze the
    // featured row while you were browsing the top bar — the one moment the
    // featured hero is on screen and should be moving.
    if (focusEngine.focused?.closest("#top-shelf")) return;
    state.index = (state.index + 1) % items.length;
    renderHero();
  }, seconds * 1000);
}