import { TerminalCellHoldback } from "./terminal-output.js";

export interface OutputSlice {
  data: string;
  checkpoint: boolean;
}

/**
 * Splits a streaming PTY transcript at safe line or size boundaries. A
 * checkpoint lets the renderer place formulas before a large burst scrolls
 * them out of view, including output that soft-wraps without LF characters.
 * Control strings are never split by a checkpoint.
 */
export class OutputCheckpointSplitter {
  #lineInterval: number;
  #linesSinceCheckpoint = 0;
  #characterInterval = Number.POSITIVE_INFINITY;
  #charactersSinceCheckpoint = 0;
  readonly #controlTracker = new TerminalCellHoldback();
  readonly #graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

  constructor(lineInterval: number, characterInterval?: number) {
    this.#lineInterval = 1;
    this.setLineInterval(lineInterval);
    if (characterInterval !== undefined) this.setCharacterInterval(characterInterval);
  }

  setCharacterInterval(characterInterval: number): void {
    this.#characterInterval = Math.max(32, Math.floor(characterInterval));
  }

  setLineInterval(lineInterval: number): void {
    this.#lineInterval = Math.max(1, Math.floor(lineInterval));
  }

  push(data: string): OutputSlice[] {
    if (!data) return [];
    const slices: OutputSlice[] = [];
    let graphemeEnds: Set<number> | undefined;
    if (Number.isFinite(this.#characterInterval) && /[^\x00-\x7f]/u.test(data)) {
      graphemeEnds = new Set<number>();
      for (const segment of this.#graphemes.segment(data)) {
        graphemeEnds.add(segment.index + segment.segment.length);
      }
    }
    let sliceStart = 0;
    for (let index = 0; index < data.length; index += 1) {
      const character = data[index]!;
      const wasGround = this.#controlTracker.isGround;
      this.#controlTracker.track(character);
      this.#charactersSinceCheckpoint += 1;
      if (character === "\n" && this.#controlTracker.isGround) {
        this.#linesSinceCheckpoint += 1;
      }
      const lineBoundary = this.#linesSinceCheckpoint >= this.#lineInterval;
      const characterBoundary = this.#charactersSinceCheckpoint >= this.#characterInterval;
      const code = character.charCodeAt(0);
      const ordinaryText = code >= 0x20 && !(code >= 0x7f && code <= 0x9f);
      const completedControl = !wasGround && this.#controlTracker.isGround;
      const safeCharacterBoundary = ordinaryText || completedControl;
      // Never insert a checkpoint after a high surrogate. When it is paired,
      // the next iteration can checkpoint after the complete code point. This
      // also stays conservative for malformed or externally split UTF-16.
      const highSurrogate = code >= 0xd800 && code <= 0xdbff;
      // A PTY callback may end between a base character and a combining/ZWJ
      // continuation. Leave one callback of look-ahead before adding a
      // character-only checkpoint; a newline checkpoint is already a definite
      // terminal boundary.
      const callbackEnd = index + 1 === data.length;
      if ((!lineBoundary && (!characterBoundary || !safeCharacterBoundary))
        || !this.#controlTracker.isGround
        || highSurrogate
        || (!lineBoundary && callbackEnd && ordinaryText && !completedControl)
        || (graphemeEnds !== undefined && !graphemeEnds.has(index + 1))) continue;
      slices.push({ data: data.slice(sliceStart, index + 1), checkpoint: true });
      sliceStart = index + 1;
      this.#linesSinceCheckpoint = 0;
      this.#charactersSinceCheckpoint = 0;
    }
    if (sliceStart < data.length) slices.push({ data: data.slice(sliceStart), checkpoint: false });
    return slices;
  }
}
