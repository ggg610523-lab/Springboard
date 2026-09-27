import { focusEngine, makeFocusable } from "../focus/focus-engine";
import { sound } from "../sound";
import { el, icon } from "./icons";
import { openOverlay } from "./overlay";

interface DialogAction {
  label: string;
  primary?: boolean;
  onSelect: () => void;
}

interface DialogOptions {
  title: string;
  body?: string;
  actions: DialogAction[];
  /** Key that regains focus when the dialog closes. */
  returnKey?: string;
  /** Extra content (e.g. a text input) rendered under the body text. */
  render?: (body: HTMLElement) => void;
}

/** A tvOS style alert: centred card, one or two pill buttons. */
export function showDialog(options: DialogOptions): void {
  openOverlay({
    layer: "dialog",
    returnKey: options.returnKey,
    build: (root, helpers) => {
      const card = el("div", "dialog");
      card.appendChild(el("h2", undefined, options.title));
      if (options.body) card.appendChild(el("p", undefined, options.body));
      if (options.render) {
        const extra = el("div", "dialog__extra");
        options.render(extra);
        card.appendChild(extra);
      }
      const actions = el("div", "dialog__actions");
      options.actions.forEach((action, index) => {
        const button = el(
          "button",
          `btn${action.primary ? " btn--primary" : " btn--ghost"}`,
          action.label,
        );
        makeFocusable(
          button,
          {
            onFocus: () => sound.focus(),
            onActivate: () => {
              sound.select();
              helpers.close();
              action.onSelect();
            },
          },
          `dialog-action-${index}`,
        );
        actions.appendChild(button);
      });
      card.appendChild(actions);
      root.appendChild(card);
      focusEngine.registerZone("dialog-actions", actions, 1);
    },
  });
}

interface PickerOption<T> {
  label: string;
  value: T;
  note?: string;
}

interface PickerOptions<T> {
  title: string;
  subtitle?: string;
  options: PickerOption<T>[];
  current: T;
  onSelect: (value: T) => void;
  returnKey?: string;
}

/** A tvOS style list picker used by Settings rows. */
export function showPicker<T>(options: PickerOptions<T>): void {
  openOverlay({
    layer: "picker",
    returnKey: options.returnKey,
    build: (root, helpers) => {
      const card = el("div", "picker");
      const head = el("div", "picker__head", options.title);
      if (options.subtitle) head.appendChild(el("span", undefined, options.subtitle));
      card.appendChild(head);

      const list = el("div", "picker__list");
      options.options.forEach((option, index) => {
        const row = el("div", `picker__item${option.value === options.current ? " is-current" : ""}`);
        row.appendChild(el("span", undefined, option.label));
        if (option.note) {
          const note = el("span", "settings-hint", option.note);
          row.appendChild(note);
        }
        const check = icon("check", 18);
        check.classList.add("picker__check");
        row.appendChild(check);
        makeFocusable(
          row,
          {
            onFocus: () => sound.focus(),
            onActivate: () => {
              sound.select();
              helpers.close();
              options.onSelect(option.value);
            },
          },
          `picker-${index}`,
        );
        list.appendChild(row);
      });
      card.appendChild(list);
      root.appendChild(card);
      focusEngine.registerZone("picker-list", list, 1);

      // Start on the currently selected entry.
      const currentIndex = Math.max(
        0,
        options.options.findIndex((option) => option.value === options.current),
      );
      requestAnimationFrame(() => focusEngine.focusKey(`picker-${currentIndex}`));
    },
  });
}