/**
 * Controller support (Xbox, PlayStation, Steam, Switch Pro, ...).
 *
 * The Web Gamepad API translates a standard controller into the same key
 * events the remote / keyboard already drive, so overlays, dialogs, sounds
 * and the Always-On Display behave identically regardless of input device:
 *
 *   D-pad / left stick  → navigate
 *   A (Cross)           → select (Enter)
 *   B (Circle)          → back (Esc)
 *   X (Square)          → context menu (long-press action)
 *   Y (Triangle)        → info (I)
 *   LB / RB             → previous / next tab
 *   LT / RT             → volume down / up (held to repeat)
 *   Select / View       → back (Esc)
 *   Menu / Options      → settings (S)
 *   L3                  → mute (M)
 *   R3                  → Control Centre (C)
 */
import { api } from "./api";
import { focusEngine } from "./focus/focus-engine";
import { store, type TabId } from "./state";
import { isAodActive } from "./ui/aod";

const DEADZONE = 0.5;
const REPEAT_DELAY = 420;
const REPEAT_RATE = 140;
/** Keep the AOD from arming while a stick or trigger is held. */
const MOTION_RATE = 4000;

const BTN = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  VIEW: 8,
  MENU: 9,
  L3: 10,
  R3: 11,
  DPAD_UP: 12,
  DPAD_DOWN: 13,
  DPAD_LEFT: 14,
  DPAD_RIGHT: 15,
} as const;

/** Trigger / dpad indexes handled as analog or directional input. */
const ANALOG_BUTTONS = new Set<number>([
  BTN.LT,
  BTN.RT,
  BTN.DPAD_UP,
  BTN.DPAD_DOWN,
  BTN.DPAD_LEFT,
  BTN.DPAD_RIGHT,
]);

type Dir = "up" | "down" | "left" | "right";
type Action = () => void;

const DIR_KEYS: Record<Dir, string> = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
};

/** Tabs the shoulder buttons cycle through (search/settings are overlays). */
const TABS: TabId[] = ["home", "movies", "shows", "apps"];

interface Repeat {
  since: number;
  lastRepeat: number;
}

const navRepeat: Repeat = { since: 0, lastRepeat: 0 };
const volRepeat: Record<"down" | "up", Repeat> = {
  down: { since: 0, lastRepeat: 0 },
  up: { since: 0, lastRepeat: 0 },
};

const heldButtons = new Set<number>();
let wasActive = false;
let lastMoveAt = 0;
let supported = false;

const isPressed = (gp: Gamepad, index: number): boolean => gp.buttons[index]?.pressed ?? false;

function keyDown(value: string): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
}

/** Pretend the pointer moved so the AOD arms / wakes like any other input. */
function notifyMotion(): void {
  document.dispatchEvent(new Event("pointermove", { bubbles: true }));
}

function dpadDir(gp: Gamepad): Dir | null {
  if (isPressed(gp, BTN.DPAD_UP)) return "up";
  if (isPressed(gp, BTN.DPAD_DOWN)) return "down";
  if (isPressed(gp, BTN.DPAD_LEFT)) return "left";
  if (isPressed(gp, BTN.DPAD_RIGHT)) return "right";
  return null;
}

function stickDir(gp: Gamepad): Dir | null {
  const x = gp.axes[0] ?? 0;
  const y = gp.axes[1] ?? 0;
  if (Math.abs(x) < DEADZONE && Math.abs(y) < DEADZONE) return null;
  if (Math.abs(x) >= Math.abs(y)) return x < 0 ? "left" : "right";
  return y < 0 ? "up" : "down";
}

function cycleTab(step: number): void {
  const current = TABS.indexOf(store.state.tab);
  if (current < 0) return;
  const next = TABS[(current + step + TABS.length) % TABS.length];
  if (!next) return;
  document.dispatchEvent(new CustomEvent<TabId>("launcher:tab", { detail: next, bubbles: true }));
}

function nudgeVolume(direction: 1 | -1): void {
  void api
    .audioCommand(direction === 1 ? "volume-up" : "volume-down")
    .then(() => api.getAudio())
    .then(([volume, muted]) => store.set({ audio: { volume, muted } }))
    .catch(() => undefined);
}

function updateRepeat(active: boolean, state: Repeat, now: number, fire: Action): void {
  if (!active) {
    state.since = 0;
    state.lastRepeat = 0;
    return;
  }
  if (state.since === 0) {
    state.since = now;
    fire();
  } else if (now - state.since > REPEAT_DELAY && now - state.lastRepeat > REPEAT_RATE) {
    state.lastRepeat = now;
    fire();
  }
}

function handleNewButton(index: number, pending: Action[]): void {
  switch (index) {
    case BTN.A:
      pending.push(() => keyDown("Enter"));
      break;
    case BTN.B:
    case BTN.VIEW:
      pending.push(() => keyDown("Backspace"));
      break;
    case BTN.X:
      pending.push(() => focusEngine.context());
      break;
    case BTN.Y:
      pending.push(() => keyDown("i"));
      break;
    case BTN.MENU:
      pending.push(() => keyDown("s"));
      break;
    case BTN.L3:
      pending.push(() => keyDown("m"));
      break;
    case BTN.R3:
      pending.push(() => keyDown("c"));
      break;
    case BTN.LB:
      pending.push(() => cycleTab(-1));
      break;
    case BTN.RB:
      pending.push(() => cycleTab(1));
      break;
    default:
      break;
  }
}

function process(gp: Gamepad, now: number, pending: Action[]): void {
  const dir = dpadDir(gp) ?? stickDir(gp);
  updateRepeat(dir !== null, navRepeat, now, () => {
    if (dir) pending.push(() => keyDown(DIR_KEYS[dir]));
  });
  updateRepeat(isPressed(gp, BTN.LT), volRepeat.down, now, () =>
    pending.push(() => nudgeVolume(-1)),
  );
  updateRepeat(isPressed(gp, BTN.RT), volRepeat.up, now, () => pending.push(() => nudgeVolume(1)));

  for (let i = 0; i < gp.buttons.length; i += 1) {
    if (ANALOG_BUTTONS.has(i)) continue;
    const pressed = gp.buttons[i]?.pressed ?? false;
    if (pressed && !heldButtons.has(i)) {
      heldButtons.add(i);
      handleNewButton(i, pending);
    } else if (!pressed && heldButtons.has(i)) {
      heldButtons.delete(i);
    }
  }
}

function anyActivity(gp: Gamepad): boolean {
  for (const button of gp.buttons) if (button.pressed) return true;
  return Math.abs(gp.axes[0] ?? 0) >= DEADZONE || Math.abs(gp.axes[1] ?? 0) >= DEADZONE;
}

function resetRepeats(): void {
  navRepeat.since = 0;
  navRepeat.lastRepeat = 0;
  volRepeat.down.since = 0;
  volRepeat.down.lastRepeat = 0;
  volRepeat.up.since = 0;
  volRepeat.up.lastRepeat = 0;
}

function poll(): void {
  requestAnimationFrame(poll);
  const pads = navigator.getGamepads();
  const pending: Action[] = [];
  const now = performance.now();
  let active = false;

  for (const gp of pads) {
    if (!gp || !gp.connected) continue;
    if (anyActivity(gp)) active = true;
    process(gp, now, pending);
  }
  if (!active) {
    wasActive = false;
    return;
  }

  if (!wasActive) {
    wasActive = true;
    const waking = isAodActive();
    notifyMotion();
    if (waking) {
      // The first press only wakes the ambient screen, like a real remote.
      lastMoveAt = now;
      resetRepeats();
      return;
    }
  } else if (now - lastMoveAt > MOTION_RATE) {
    notifyMotion();
  }
  lastMoveAt = now;
  for (const action of pending) action();
}

/** Start the controller polling loop; safe to call multiple times / in browsers without the API. */
export function initGamepad(): void {
  if (supported || typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") {
    return;
  }
  supported = true;
  requestAnimationFrame(poll);
}