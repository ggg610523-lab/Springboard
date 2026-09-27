/**
 * Deferred entry points for the heavy screens.
 *
 * Settings, Control Centre and Search are only reachable from a key press or a
 * tab, yet they were previously parsed and evaluated during boot as part of the
 * single frontend bundle. Each is now fetched on first use; the promise is
 * memoised so opening the same screen twice costs nothing.
 */

type SettingsModule = typeof import("./ui/settings");
type ControlModule = typeof import("./ui/control-centre");
type SearchModule = typeof import("./ui/search");

let settingsPromise: Promise<SettingsModule> | null = null;
let controlPromise: Promise<ControlModule> | null = null;
let searchPromise: Promise<SearchModule> | null = null;
/**
 * Resolved search module. `main.ts` needs it synchronously from the keydown
 * handler, but only while the search layer is active — which can only happen
 * after `openSearchLazy` has already resolved the import.
 */
let searchModule: SearchModule | null = null;

function loadSettings(): Promise<SettingsModule> {
  settingsPromise ??= import("./ui/settings");
  return settingsPromise;
}

function loadControlCentre(): Promise<ControlModule> {
  controlPromise ??= import("./ui/control-centre");
  return controlPromise;
}

/** Ensure the search chunk is loaded. */
export function loadSearch(): Promise<SearchModule> {
  searchPromise ??= import("./ui/search").then((module) => {
    searchModule = module;
    return module;
  });
  return searchPromise;
}

/** The loaded search module, or `null` while its chunk is still in flight. */
export function searchModuleSync(): SearchModule | null {
  return searchModule;
}

export function openSettingsLazy(): void {
  void loadSettings().then((module) => module.openSettings());
}

export function openControlCentreLazy(): void {
  void loadControlCentre().then((module) => module.openControlCentre());
}

export function openSearchLazy(): void {
  void loadSearch().then((module) => module.openSearch());
}
