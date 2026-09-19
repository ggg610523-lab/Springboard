import { iconUrl, posterUrl } from "../api";
import { focusEngine, makeFocusable } from "../focus/focus-engine";
import { washFor } from "../palette";
import { sound } from "../sound";
import { actions, store } from "../state";
import type { AppInfo, MediaItem } from "../types";
import { el, icon } from "./icons";
import { launchApp, mediaFeedback, openAppMenu, openMedia } from "./tiles";
import { toast } from "./overlay";

interface HeroState {
  mode: "featured" | "app" | "media";
  app?: AppInfo;
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

function renderAppHero(container: HTMLElement, app: AppInfo): void {
  const hero = el("div", "hero");
  const art = el("div", "hero-art hero-art--app");
  const src = iconUrl(app.iconName, app.iconPath);
  if (src) {
    const img = el("img");
    img.src = src;
    img.alt = app.name;
    art.appendChild(img);
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
  if (app.terminal) meta.appendChild(el("span", "hero-badge", "Terminal"));
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
  document.body.style.setProperty("--wash-a", wash.a);
  document.body.style.setProperty("--wash-b", wash.b);
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
    const img = el("img");
    img.src = src;
    img.alt = item.title;
    img.addEventListener("error", () => {
      img.remove();
      art.appendChild(fallbackPoster(item));
    });
    art.appendChild(img);
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
  document.body.style.setProperty("--wash-a", wash.a);
  document.body.style.setProperty("--wash-b", wash.b);
  backdrop(src);
  focusEngine.registerZone("topshelf", actionsRow, 1);
}

function renderMediaHero(container: HTMLElement, item: MediaItem): void {
  const hero = el("div", "hero");
  const art = el("div", "hero-art");
  const src = posterUrl(item);
  if (src) {
    const img = el("img");
    img.src = src;
    img.alt = item.title;
    img.addEventListener("error", () => {
      img.remove();
      art.appendChild(fallbackPoster(item));
    });
    art.appendChild(img);
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
  document.body.style.setProperty("--wash-a", wash.a);
  document.body.style.setProperty("--wash-b", wash.b);
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
  if (!store.state.settings.showTopShelf) {
    container.replaceChildren();
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
  container.replaceChildren(...next.childNodes);
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
    const item = [...store.state.recommendations, ...store.state.catalog].find(
      (entry) => entry.id === mediaId,
    );
    if (item) {
      if (state.mode === "media" && state.item?.id === item.id) return;
      state.mode = "media";
      state.item = item;
      state.app = undefined;
      renderHero();
    }
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
    const inHero = focusEngine.focused?.closest("#top-shelf") != null;
    if (!inHero) return;
    state.index = (state.index + 1) % items.length;
    renderHero();
  }, seconds * 1000);
}