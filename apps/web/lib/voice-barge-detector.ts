/**
 * Live voice, cutting in: is the person speaking over the agent? A local guess from the microphone's
 * loudness alone, made in short windows so playback can pause within a fraction of a second. The host
 * makes the real decision (a cough or "mm-hm" is not an interruption); this only buys the pause.
 *
 * The microphone is echo-cancelled, so the agent's own voice should not reach it. What does reach it
 * is the room: a fan, a keyboard, a click. So the threshold rides above a floor the detector learns
 * from the quiet windows (it climbs slowly and falls fast, so steady noise raises the bar and does not
 * trip it), and loudness has to be sustained for `sustainMs` to count, so a click (a few ms) cannot.
 */

export type BargeDetectorOptions = {
  /** Never trigger below this RMS (full scale is 1), whatever the floor says. About -38 dBFS. */
  minRms?: number;
  /** The bar is this many times the floor. */
  ratio?: number;
  /** Loud this long, in ms, counts as speech. */
  sustainMs?: number;
  /** Quiet this long, in ms, ends it, so the next burst can trigger again. */
  quietMs?: number;
  /** How fast the floor learns a quiet room at the start, in ms. */
  warmupMs?: number;
};

export const BARGE_SUSTAIN_MS = 120;

export class BargeDetector {
  private readonly minRms: number;
  private readonly ratio: number;
  private readonly sustainMs: number;
  private readonly quietMs: number;
  private readonly warmupMs: number;
  private floorValue = 0;
  private heardMs = 0;
  private loudMs = 0;
  private quietRun = 0;
  private active = false;

  constructor(options: BargeDetectorOptions = {}) {
    this.minRms = options.minRms ?? 0.012;
    this.ratio = options.ratio ?? 3;
    this.sustainMs = options.sustainMs ?? BARGE_SUSTAIN_MS;
    this.quietMs = options.quietMs ?? 300;
    this.warmupMs = options.warmupMs ?? 400;
  }

  /** The room's quiet level as learned so far. */
  get floor(): number {
    return this.floorValue;
  }

  /** The bar a window has to clear to count as loud. */
  get threshold(): number {
    return Math.max(this.minRms, this.floorValue * this.ratio);
  }

  /** Speech is going on now: loudness has been sustained and has not yet been quiet for `quietMs`. */
  get speaking(): boolean {
    return this.active;
  }

  /**
   * One window's RMS and its length in ms. Returns true on the window where speech begins, once per
   * burst: it does not fire again until `quietMs` of quiet has ended the burst.
   */
  push(rms: number, windowMs: number): boolean {
    const level = Number.isFinite(rms) && rms > 0 ? rms : 0;
    const loud = level > this.threshold;
    // Learn the room from windows that are not loud. The first moments set the floor outright; after
    // that it falls to a quieter room at once and rises to a noisier one only slowly.
    if (!loud || this.heardMs < this.warmupMs) {
      const learning = this.heardMs < this.warmupMs ? 0.3 : level < this.floorValue ? 0.3 : 0.02;
      this.floorValue = this.heardMs === 0 ? level : this.floorValue + (level - this.floorValue) * learning;
    }
    this.heardMs += windowMs;
    if (this.heardMs <= this.warmupMs) {
      // Still learning the room: whatever it sounds like now is its floor, not speech.
      return false;
    }
    if (loud) {
      this.quietRun = 0;
      this.loudMs += windowMs;
      if (!this.active && this.loudMs >= this.sustainMs) {
        this.active = true;
        return true;
      }
      return false;
    }
    // A quiet window takes back what a loud one added, twice as fast, so the gaps between syllables
    // do not reset the count but a single loud window is gone within a few quiet ones.
    this.loudMs = Math.max(0, this.loudMs - windowMs * 2);
    this.quietRun += windowMs;
    if (this.active && this.quietRun >= this.quietMs) {
      this.active = false;
      this.loudMs = 0;
    }
    return false;
  }

  reset(): void {
    this.floorValue = 0;
    this.heardMs = 0;
    this.loudMs = 0;
    this.quietRun = 0;
    this.active = false;
  }
}
