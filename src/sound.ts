/**
 * tvOS style interface sounds, synthesised with the Web Audio API so the
 * launcher ships without audio assets. The Apple TV remote click is a very
 * short filtered noise burst; selection is a slightly softer, lower click.
 */
class SoundEngine {
  private context: AudioContext | null = null;
  private enabled = true;
  private lastPlayed = 0;

  setEnabled(value: boolean): void {
    this.enabled = value;
  }

  private ensure(): AudioContext | null {
    if (!this.enabled) return null;
    try {
      if (!this.context) {
        const Ctor: typeof AudioContext =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        this.context = new Ctor();
      }
      if (this.context.state === "suspended") void this.context.resume();
      return this.context;
    } catch {
      this.enabled = false;
      return null;
    }
  }

  /** A click: band-passed noise with a very fast decay. */
  private click(frequency: number, duration: number, gain: number, q = 1.1): void {
    const ctx = this.ensure();
    if (!ctx) return;
    const now = performance.now();
    // Guard against machine-gun clicks while holding an arrow key.
    if (now - this.lastPlayed < 26) return;
    this.lastPlayed = now;

    const frames = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i += 1) {
      const decay = Math.pow(1 - i / frames, 2.6);
      data[i] = (Math.random() * 2 - 1) * decay;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const amp = ctx.createGain();
    amp.gain.value = gain;
    source.connect(filter).connect(amp).connect(ctx.destination);
    source.start();
  }

  /** Soft sine "pop" used for confirming a selection. */
  private tone(frequency: number, duration: number, gain: number, slideTo?: number): void {
    const ctx = this.ensure();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = "sine";
    const now = ctx.currentTime;
    osc.frequency.setValueAtTime(frequency, now);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, now + duration);
    amp.gain.setValueAtTime(0.0001, now);
    amp.gain.exponentialRampToValueAtTime(gain, now + 0.008);
    amp.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(amp).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  focus(): void {
    this.click(1750, 0.028, 0.05, 1.4);
  }

  select(): void {
    this.click(980, 0.05, 0.07, 0.8);
    this.tone(660, 0.09, 0.03);
  }

  toggle(): void {
    this.click(1350, 0.03, 0.05, 1.1);
  }

  back(): void {
    this.tone(520, 0.11, 0.035, 300);
  }

  launch(): void {
    this.tone(523.25, 0.16, 0.05);
    this.tone(783.99, 0.22, 0.035);
  }

  error(): void {
    this.tone(220, 0.2, 0.06, 160);
  }

  boot(): void {
    this.tone(392, 0.4, 0.04);
    this.tone(587.33, 0.5, 0.03);
  }
}

export const sound = new SoundEngine();