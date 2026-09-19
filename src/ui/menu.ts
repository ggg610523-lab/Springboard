import { focusEngine, makeFocusable } from "../focus/focus-engine";
import { sound } from "../sound";
import { el, icon } from "./icons";

export interface MenuOption {
  icon: string;
  label: string;
  action: () => void;
  danger?: boolean;
}

let openMenu: { node: HTMLElement; close: () => void } | null = null;

/** Close the popover menu, if one is open. */
export function closeMenu(): boolean {
  if (!openMenu) return false;
  openMenu.close();
  return true;
}

/**
 * A positioned popover menu, used for tvOS style long-press actions on tiles.
 * Lives in its own focus layer so the engine treats it like a modal sheet.
 */
export function showActionMenu(
  anchor: HTMLElement,
  options: MenuOption[],
  returnKey?: string,
): void {
  closeMenu();

  const menu = el("div", "context-menu");
  const rect = anchor.getBoundingClientRect();
  const layer = "menu";
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    menu.classList.remove("is-open");
    focusEngine.popLayer(layer);
    window.setTimeout(() => {
      menu.remove();
      focusEngine.rebuild(returnKey);
      if (openMenu?.node === menu) openMenu = null;
    }, 170);
  };

  options.forEach((option, index) => {
    const row = el("div", `context-item${option.danger ? " context-item--danger" : ""}`);
    row.appendChild(icon(option.icon, 16));
    row.appendChild(el("span", undefined, option.label));
    makeFocusable(
      row,
      {
        onFocus: () => sound.focus(),
        onActivate: () => {
          sound.select();
          close();
          option.action();
        },
      },
      `menu-${index}`,
    );
    menu.appendChild(row);
  });

  const container = document.getElementById("overlays") ?? document.body;
  container.appendChild(menu);

  const width = 268;
  const height = menu.offsetHeight || options.length * 46 + 18;
  const left = Math.min(
    Math.max(16, rect.left + rect.width / 2 - width / 2),
    window.innerWidth - width - 16,
  );
  const top = Math.min(rect.bottom + 10, window.innerHeight - height - 16);
  menu.style.left = `${left}px`;
  menu.style.top = `${Math.max(16, top)}px`;

  focusEngine.pushLayer(layer);
  focusEngine.registerZone("menu-zone", menu, 1, layer);
  requestAnimationFrame(() => {
    menu.classList.add("is-open");
    focusEngine.rebuild("menu-0");
    focusEngine.focusKey("menu-0").valueOf();
  });

  const onPointerDown = (event: PointerEvent): void => {
    if (!menu.contains(event.target as Node)) {
      document.removeEventListener("pointerdown", onPointerDown);
      close();
    }
  };
  window.setTimeout(() => document.addEventListener("pointerdown", onPointerDown), 0);

  openMenu = { node: menu, close };
}