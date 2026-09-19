import { el } from "./icons";
import { store } from "../state";

const HINTS: [string, string][] = [
  ["←↑→↓", "Navigate"],
  ["Enter", "Open"],
  ["I", "Info"],
  ["M", "Mute"],
  ["S", "Settings"],
  ["Esc", "Back"],
  ["Gamepad", "D-pad · A/B"],
];

/** The tvOS bottom bar: a remote control legend. */
export function renderHints(): void {
  const bar = document.getElementById("hints");
  if (!bar) return;
  if (!store.state.settings.showHints) {
    bar.replaceChildren();
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const fragment = document.createDocumentFragment();
  for (const [symbol, label] of HINTS) {
    const chip = el("span", "hint-chip");
    chip.appendChild(el("kbd", undefined, symbol));
    chip.appendChild(el("span", undefined, label));
    fragment.appendChild(chip);
  }
  bar.replaceChildren(fragment);
}