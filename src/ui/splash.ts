/**
 * Startup splash. The splash markup lives in index.html (black backdrop +
 * startup artwork) so it paints before any script runs; this module plays the
 * startup chime and holds the screen up for SPLASH_MS while the launcher
 * preloads its data, so the home screen is fully painted — and the media
 * catalogue fetched — before it appears.
 *
 * The chime uses a plain Audio element rather than the Web Audio synth so it
 * can fire before any user gesture without needing the context, ImageData, or
 * an unlocked AudioContext.
 */
const SPLASH_MS = 10_000;
const FADE_MS = 700;

/** Play the startup chime and resolve once the splash time has elapsed. */
export function startSplash(): Promise<void> {
  playChime();

  return new Promise((resolve) => {
    window.setTimeout(resolve, SPLASH_MS);
  });
}

/**
 * Play the chime. WebKitGTK often blocks media until the first user gesture,
 * so when the initial attempt is refused we queue it to fire on the first
 * pointer / key / gamepad interaction instead of giving up.
 */
function playChime(): void {
  const audio = new Audio("/activation.mp3");
  audio.volume = 0.65;
  audio.play().catch(() => {
    const unlock = (): void => {
      void audio.play().catch(() => undefined);
    };
    document.addEventListener("pointerup", unlock, { once: true });
    document.addEventListener("keydown", unlock, { once: true });
  });
}

/** Fade the splash out and remove it from the DOM. */
export function hideSplash(): void {
  const node = document.getElementById("splash");
  if (!node) return;
  node.style.pointerEvents = "none";
  node.classList.add("is-hidden");
  window.setTimeout(() => node.remove(), FADE_MS + 120);
}