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

/**
 * Screen-expanding controls which can outrun a raw-character checkpoint.
 *
 * This is called only when the terminal parser has just completed a control.
 * Walk backwards from its final byte instead of allocating a tail string and
 * running two regular expressions for every SGR/cursor control in a TUI.
 */
function terminalMotionEndingAt(value: string, end: number): TerminalMotion | undefined {
  const final = value.charCodeAt(end);
  if (final === 0x44 || final === 0x45 || final === 0x4d) {
    if (end > 0 && value.charCodeAt(end - 1) === 0x1b) {
      return { start: end - 1, lines: 1 };
    }
  }
  if (final !== 0x4c && final !== 0x4d && final !== 0x53
    && final !== 0x54 && final !== 0x62) return undefined;

  // Preserve the old bounded-tail behavior while avoiding the tail copy.
  const minimum = Math.max(0, end + 1 - 256);
  let cursor = end - 1;
  while (cursor >= minimum) {
    const code = value.charCodeAt(cursor);
    if ((code >= 0x30 && code <= 0x39) || code === 0x3b) cursor -= 1;
    else break;
  }

  let start: number;
  let parametersStart: number;
  if (cursor >= minimum && value.charCodeAt(cursor) === 0x9b) {
    start = cursor;
    parametersStart = cursor + 1;
  } else if (cursor - 1 >= minimum
    && value.charCodeAt(cursor) === 0x5b
    && value.charCodeAt(cursor - 1) === 0x1b) {
    start = cursor - 1;
    parametersStart = cursor + 1;
  } else return undefined;

  let firstParameterEnd = parametersStart;
  while (firstParameterEnd < end && value.charCodeAt(firstParameterEnd) !== 0x3b) {
    firstParameterEnd += 1;
  }
  const amount = positiveParameter(value.slice(parametersStart, firstParameterEnd));
  return final === 0x62
    ? { start, cells: amount }
    : { start, lines: amount };
}

function startsTrackedControl(code: number): boolean {
  return code === 0x1b || code === 0x90 || code === 0x98 || code === 0x9b
    || code === 0x9d || code === 0x9e || code === 0x9f;
}

type CheckpointControlState = "ground" | "escape" | "csi" | "osc" | "string";

/**
 * Minimal ECMA-48 parser used only to find safe checkpoint boundaries.
 * TerminalCellHoldback additionally tracks graphemes, cell widths, and DEC
 * synchronized output. Invoking that general parser once per UTF-16 unit was
 * the dominant splitter cost for ANSI-heavy output; none of that extra state
 * affects whether a control has completed.
 */
class CheckpointControlTracker {
  #state: CheckpointControlState = "ground";
  #atomicStart: number | undefined;

  get isGround(): boolean {
    return this.#state === "ground";
  }

  startChunk(): void {
    // Offsets are relative to the current push. The production control gate
    // releases complete controls, but keep parser state correct for direct
    // callers that stream an incomplete sequence across pushes.
    if (this.#state !== "ground") this.#atomicStart = undefined;
  }

  #finish(): number | undefined {
    const start = this.#atomicStart;
    this.#state = "ground";
    this.#atomicStart = undefined;
    return start;
  }

  track(code: number, index: number): number | undefined {
    if (this.#state === "ground" && startsTrackedControl(code)) {
      this.#atomicStart = index;
    }
    // CAN and SUB cancel every escape/control string in progress.
    if (code === 0x18 || code === 0x1a) {
      return this.#finish();
    }

    // C1 introducers restart an in-progress ESC/CSI. String-state restarts
    // are handled below because OSC has its additional BEL terminator.
    if (this.#state !== "osc" && this.#state !== "string") {
      if (code === 0x9b) {
        this.#state = "csi";
        return undefined;
      }
      if (code === 0x9d) {
        this.#state = "osc";
        return undefined;
      }
      if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
        this.#state = "string";
        return undefined;
      }
      if (code === 0x9c) {
        return this.#finish();
      }
    }

    if (this.#state === "ground") {
      if (code === 0x1b) this.#state = "escape";
      return undefined;
    }

    if (this.#state === "escape") {
      if (code === 0x1b) this.#state = "escape";
      else if (code === 0x5b) this.#state = "csi";
      else if (code === 0x5d) this.#state = "osc";
      else if (code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) {
        this.#state = "string";
      // C0 controls execute without completing the surrounding ESC.
      } else if (code < 0x20 || code === 0x7f) return undefined;
      else if (code > 0x2f) return this.#finish();
      return undefined;
    }

    if (this.#state === "csi") {
      if (code === 0x1b) this.#state = "escape";
      else if (code >= 0x40 && code <= 0x7e) return this.#finish();
      return undefined;
    }

    if (this.#state === "osc" || this.#state === "string") {
      if ((this.#state === "osc" && code === 0x07) || code === 0x9c) {
        return this.#finish();
      } else if (code === 0x1b) this.#state = "escape";
      else if (code === 0x9b) this.#state = "csi";
      else if (code === 0x9d) this.#state = "osc";
      else if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
        this.#state = "string";
      }
    }
    return undefined;
  }
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
  readonly #controlTracker = new CheckpointControlTracker();
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
    let graphemeSegments: ReturnType<Intl.Segmenter["segment"]> | undefined;
    let containingGraphemeEnd = 0;
    let sliceStart = 0;
    this.#controlTracker.startChunk();
    let parserGround = this.#controlTracker.isGround;
    for (let index = 0; index < data.length; index += 1) {
      const code = data.charCodeAt(index);
      const wasGround = parserGround;
      // Ordinary ground-state text cannot change the terminal control parser.
      // Avoid invoking even the lightweight parser for every UTF-16 unit in
      // normal output.
      let completedControlStart: number | undefined;
      if (!parserGround || startsTrackedControl(code)) {
        completedControlStart = this.#controlTracker.track(code, index);
        parserGround = this.#controlTracker.isGround;
      }
      this.#charactersSinceCheckpoint += 1;
      if (code === 0x0a && parserGround) {
        this.#linesSinceCheckpoint += 1;
      }
      const lineBoundary = this.#linesSinceCheckpoint >= this.#lineInterval;
      const characterBoundary = this.#charactersSinceCheckpoint >= this.#characterInterval;
      const ordinaryText = code >= 0x20 && !(code >= 0x7f && code <= 0x9f);
      const completedControl = !wasGround && parserGround;
      const c1Motion: TerminalMotion | undefined = wasGround && parserGround
        && (code === 0x84 || code === 0x85 || code === 0x8d)
        ? { start: index, lines: 1 }
        : undefined;
      const completedMotion = completedControl
        ? terminalMotionEndingAt(data, index)
        : undefined;
      if (completedMotion && completedControlStart !== undefined) {
        // An ESC/C1 restart can abort an OSC/APC and finish as a motion CSI.
        // Keep that entire atomic control together instead of checkpointing
        // while the real terminal is still inside the abandoned string.
        completedMotion.start = Math.min(completedMotion.start, completedControlStart);
      }
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
        || !parserGround
        || highSurrogate
        // xterm can attach a trailing ZWJ to the next pictograph even where
        // Intl.Segmenter reports a boundary. Delay until the following safe
        // character so a checkpoint never exposes that transient cell state.
        || (!lineBoundary && code === 0x200d)
        || (!lineBoundary && callbackEnd && ordinaryText && !completedControl)) continue;
      if (!lineBoundary) {
        const end = index + 1;
        const after = data.charCodeAt(end);
        // With ASCII on both sides, only CRLF can cross this boundary; CR is
        // not an eligible checkpoint and LF is a definite line boundary.
        if ((code > 0x7f && end < data.length) || after > 0x7f) {
          graphemeSegments ??= this.#graphemes.segment(data);
          // Cache the end of a long combining sequence so subsequent units
          // reject in O(1) after the budget has already been reached.
          if (end < containingGraphemeEnd) continue;
          const containing = graphemeSegments.containing(end - 1);
          if (!containing) continue;
          containingGraphemeEnd = containing.index + containing.segment.length;
          if (containingGraphemeEnd !== end) continue;
        }
      }
      slices.push({ data: data.slice(sliceStart, index + 1), checkpoint: true });
      sliceStart = index + 1;
      this.#linesSinceCheckpoint = 0;
      this.#charactersSinceCheckpoint = 0;
    }
    if (sliceStart < data.length) slices.push({ data: data.slice(sliceStart), checkpoint: false });
    return slices;
  }
}
