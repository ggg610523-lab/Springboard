import { appTile, mediaTile } from "./tiles";
import { el } from "./icons";
import { focusEngine } from "../focus/focus-engine";
import { genreTint } from "../palette";
import { shelvesFor } from "../layout";
import { store, type Shelf } from "../state";

/**
 * Paint every shelf of the active tab into #rows. Tiles are keyed
 * (`tile-<shelf>-<id>`) so focus survives re-renders and tab switches.
 */
export function renderShelves(): void {
  const rows = document.getElementById("rows");
  if (!rows) return;

  const fragment = document.createDocumentFragment();
  for (const shelf of shelvesFor(store.state.tab) as Shelf[]) {
    const section = el("section", "shelf-section");
    section.dataset.row = shelf.id;

    if (store.state.settings.showRowTitles) {
      const title = el("div", "row-title");
      title.appendChild(el("span", undefined, shelf.title));
      const badge = el("span", "row-source", shelf.badge ?? "");
      if (shelf.kind === "media" && shelf.badge) {
        badge.style.color = genreTint(shelf.badge === "IMDb" ? "Drama" : shelf.badge);
      }
      title.appendChild(badge);
      title.appendChild(
        el("span", "row-count", String(shelf.kind === "apps" ? shelf.apps.length : shelf.items.length)),
      );
      section.appendChild(title);
    }

    if (shelf.kind === "apps" && shelf.apps.length === 0) {
      section.appendChild(el("div", "row-empty", "Nothing here yet."));
      fragment.appendChild(section);
      continue;
    }
    if (shelf.kind === "media" && shelf.items.length === 0) {
      section.appendChild(el("div", "row-empty", "Nothing here yet."));
      fragment.appendChild(section);
      continue;
    }

    const strip = el("div", "shelf");
    if (shelf.kind === "apps") {
      for (const app of shelf.apps) {
        strip.appendChild(appTile(app, `tile-${shelf.id}-${app.id}`));
      }
    } else {
      for (const item of shelf.items) {
        strip.appendChild(mediaTile(item, `tile-${shelf.id}-${item.id}`));
      }
    }
    section.appendChild(strip);
    focusEngine.registerZone(`shelf-${shelf.id}`, strip, 2 + fragment.childElementCount);
    fragment.appendChild(section);
  }

  rows.replaceChildren(fragment);
}