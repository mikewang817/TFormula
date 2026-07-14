import { TerminalCellHoldback } from "./terminal-output.js";

export interface OutputSlice {
  data: string;
  checkpoint: boolean;
}

interface TerminalMotion {
  start: number;
  lines?: number;
  cells?: number;
}

function positiveParameter(value: string | undefined): number {
  const parsed = Number(value || "1");
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(parsed));
}

/** Screen-expanding controls which can outrun a raw-character checkpoint. */
function terminalMotionAtEnd(value: string): TerminalMotion | undefined {
  const single = /\x1b([DEM])$/u.exec(value);
  if (single?.index !== undefined) {
    return { start: single.index, lines: 1 };
  }

  const csi = /(?:\x1b\[|\u009b)([0-9;]*)([LMSTb])$/u.exec(value);
  if (!csi || csi.index === undefined) return undefined;
  const amount = positiveParameter(csi[1]?.split(";", 1)[0]);
  return csi[2] === "b"
    ? { start: csi.index, cells: amount }
    : { start: csi.index, lines: amount };
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
      const c1Motion: TerminalMotion | undefined = wasGround && this.#controlTracker.isGround
        && (code === 0x84 || code === 0x85 || code === 0x8d)
        ? { start: index, lines: 1 }
        : undefined;
      const controlTailStart = Math.max(0, index + 1 - 256);
      const completedMotion = completedControl
        ? terminalMotionAtEnd(data.slice(controlTailStart, index + 1))
        : undefined;
      if (completedMotion) completedMotion.start += controlTailStart;
      const motion = c1Motion ?? completedMotion;
      if (motion) {
        const crossesLineBudget = motion.lines !== undefined
          && this.#linesSinceCheckpoint + motion.lines >= this.#lineInterval;
        const crossesCharacterBudget = motion.cells !== undefined
          && this.#charactersSinceCheckpoint + motion.cells >= this.#characterInterval;
        if (crossesLineBudget || crossesCharacterBudget) {
          // A single REP/scroll command can move thousands of cells despite
          // occupying only a few bytes. Scan the preceding mirror state before
          // the real terminal executes it. An empty slice is intentional when
          // the control begins a new PTY callback: it forms a barrier for text
          // returned by the preceding callback.
          slices.push({
            data: data.slice(sliceStart, Math.max(sliceStart, motion.start)),
            checkpoint: true
          });
          sliceStart = Math.max(sliceStart, motion.start);
          this.#linesSinceCheckpoint = 0;
          this.#charactersSinceCheckpoint = 0;
          continue;
        }
        this.#linesSinceCheckpoint += motion.lines ?? 0;
        this.#charactersSinceCheckpoint += motion.cells ?? 0;
      }
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
