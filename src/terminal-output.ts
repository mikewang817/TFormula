import stringWidth from "string-width";

export interface TransformedTerminalOutput {
  data: string;
  /** Byte offsets where a rewritten ED 2 starts in `data`. */
  preservedEraseDisplayOffsets: number[];
}

function textOnlyEraseDisplay(): string {
  // Ghostty 1.3.1 deletes every Kitty image in the active screen for ED 2.
  // ED 0 followed by ED 1 clears the same cells without touching Kitty image
  // storage. Both controls leave the cursor, pending-wrap state, origin mode,
  // and the application's one-slot saved cursor untouched. In particular, do
  // not implement this with DECSC/DECRC: that would overwrite a TUI's save.
  return "\x1b[0J\x1b[1J";
}

/**
 * Rewrites ED 2 into equivalent text-only erases. Ghostty couples ED 2 to
 * deleting all Kitty image pins, including scrollback pins that cannot be
 * recreated when a user later scrolls locally. ED 0/1 leave those pins intact.
 */
export class TerminalOutputTransformer {
  #state: "ground" | "escape" | "csi" | "osc" | "string" = "ground";
  #pending = "";

  push(
    input: string,
    preserveImages: boolean
  ): TransformedTerminalOutput {
    // PTY traffic is overwhelmingly plain text. When no control introducer is
    // present and no sequence is pending, the parser state cannot change and
    // the input can be forwarded without a per-code-unit loop or copy.
    if (this.#state === "ground"
      && input.indexOf("\x1b") < 0
      && !/[\u0090\u0098\u009b\u009d\u009e\u009f]/u.test(input)) {
      return { data: input, preservedEraseDisplayOffsets: [] };
    }
    let output = "";
    const preservedEraseDisplayOffsets: number[] = [];

    const releasePending = (): void => {
      output += this.#pending;
      this.#pending = "";
    };
    const restartWith = (character: string, state: "escape" | "csi"): void => {
      output += this.#pending.slice(0, -1);
      this.#pending = character;
      this.#state = state;
    };

    for (let index = 0; index < input.length; index += 1) {
      const character = input[index]!;
      const code = input.charCodeAt(index);

      if (this.#state === "ground") {
        if (code === 0x1b) {
          this.#pending = character;
          this.#state = "escape";
        } else if (code === 0x9b) {
          this.#pending = character;
          this.#state = "csi";
        } else {
          output += character;
          if (code === 0x9d) this.#state = "osc";
          else if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
            this.#state = "string";
          }
        }
        continue;
      }

      if (this.#state === "osc" || this.#state === "string") {
        if (code === 0x18 || code === 0x1a || code === 0x9c
          || (this.#state === "osc" && code === 0x07)) {
          output += character;
          this.#state = "ground";
        } else if (code === 0x1b) {
          // ESC aborts the current control string and starts a fresh escape
          // sequence. ESC \\ is therefore parsed as an ordinary ST, while
          // ESC [ starts a real CSI that must still be inspected for ED 2.
          this.#pending = character;
          this.#state = "escape";
        } else if (code === 0x9b) {
          this.#pending = character;
          this.#state = "csi";
        } else if (code === 0x9d) {
          output += character;
          this.#state = "osc";
        } else if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
          output += character;
          this.#state = "string";
        } else output += character;
        continue;
      }

      this.#pending += character;

      if (code === 0x18 || code === 0x1a) {
        this.#state = "ground";
        releasePending();
        continue;
      }

      // C1 controls restart an in-progress ESC/CSI rather than becoming its
      // parameter or final byte. Keep the abandoned bytes unchanged, then
      // continue parsing the new control in its own state.
      if (code === 0x9b) {
        restartWith(character, "csi");
        continue;
      }
      if (code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
        output += this.#pending;
        this.#pending = "";
        this.#state = code === 0x9d ? "osc" : "string";
        continue;
      }
      if (code === 0x9c) {
        this.#state = "ground";
        releasePending();
        continue;
      }

      if (this.#state === "escape") {
        if (code === 0x1b) restartWith(character, "escape");
        else if (character === "[") this.#state = "csi";
        else if (character === "]") {
          releasePending();
          this.#state = "osc";
        } else if (/[P_X^]/u.test(character)) {
          releasePending();
          this.#state = "string";
        // C0 controls execute without completing the ESC sequence.
        } else if (code >= 0x20 && code !== 0x7f && code > 0x2f) {
          this.#state = "ground";
          releasePending();
        }
        continue;
      }

      if (this.#state === "csi") {
        if (code === 0x1b) {
          restartWith(character, "escape");
          continue;
        }
        if (code < 0x40 || code > 0x7e) continue;

        const sequence = this.#pending;
        const introducerLength = sequence.startsWith("\x1b[") ? 2 : 1;
        // Executable C0 bytes do not participate in CSI parameters, but CAN
        // and SUB have already cancelled the sequence above.
        const parameters = sequence.slice(introducerLength, -1)
          .replace(/[\x00-\x17\x19\x1c-\x1f\x7f]/gu, "");
        const eraseParameter = character === "J" && /^[0-9;]*$/u.test(parameters)
          ? parameters.split(";", 1)[0]
          : undefined;
        if (preserveImages
          && eraseParameter !== undefined
          && Number(eraseParameter || "0") === 2) {
          preservedEraseDisplayOffsets.push(output.length);
          output += textOnlyEraseDisplay();
        } else {
          output += sequence;
        }
        this.#pending = "";
        this.#state = "ground";
      }
    }

    return { data: output, preservedEraseDisplayOffsets };
  }

  flush(): string {
    const tail = this.#pending;
    this.#pending = "";
    this.#state = "ground";
    return tail;
  }
}

export const terminalOutputInternals = { textOnlyEraseDisplay };

type ControlState = "ground" | "escape" | "csi" | "osc" | "string";

/**
 * Keeps an incomplete child control sequence off the real terminal until its
 * final byte arrives. TFormula may inject Kitty APC commands between PTY data
 * events; without this gate, an image can land inside an OSC, DCS, or APC that
 * the child happened to split across events. The injected ST would then close
 * the child's string and expose the remaining PNG payload as ordinary Base64.
 *
 * Only the current incomplete control is retained. Ordinary text before its
 * introducer is returned immediately, and completed controls are released
 * byte-for-byte without interpretation or rewriting.
 */
export class TerminalControlGate {
  #state: ControlState = "ground";
  #pending = "";

  get isGround(): boolean {
    return this.#state === "ground";
  }

  get hasPending(): boolean {
    return this.#pending.length > 0;
  }

  push(data: string): string {
    if (!data) return "";
    if (this.#state === "ground"
      && data.indexOf("\x1b") < 0
      && !/[\u0090\u0098\u009b\u009d\u009e\u009f]/u.test(data)) return data;
    let output = "";
    let plainStart = this.#state === "ground" ? 0 : undefined;

    const releasePending = (): void => {
      output += this.#pending;
      this.#pending = "";
    };

    for (let index = 0; index < data.length; index += 1) {
      const character = data[index]!;
      const code = data.charCodeAt(index);

      if (this.#state === "ground") {
        const sevenBitControl = code === 0x1b;
        const eightBitControl = code === 0x90
          || code === 0x98
          || code === 0x9b
          || code === 0x9d
          || code === 0x9e
          || code === 0x9f;
        if (!sevenBitControl && !eightBitControl) continue;
        if (plainStart !== undefined && plainStart < index) output += data.slice(plainStart, index);
        this.#pending = character;
        plainStart = undefined;
        if (code === 0x1b) this.#state = "escape";
        else if (code === 0x9b) this.#state = "csi";
        else if (code === 0x9d) this.#state = "osc";
        else this.#state = "string";
        continue;
      }

      this.#pending += character;

      // CAN and SUB cancel every escape/control string in progress. The bytes
      // are still forwarded exactly; cancellation only determines when it is
      // safe for a later TFormula transaction to follow them.
      if (code === 0x18 || code === 0x1a) {
        this.#state = "ground";
        releasePending();
        plainStart = index + 1;
        continue;
      }

      // C1 introducers are "anywhere" transitions. The string-specific branch
      // below handles the same restarts while an OSC/DCS/APC is active.
      if (this.#state !== "osc"
        && this.#state !== "string") {
        if (code === 0x9b) {
          this.#state = "csi";
          continue;
        }
        if (code === 0x9d) {
          this.#state = "osc";
          continue;
        }
        if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
          this.#state = "string";
          continue;
        }
        if (code === 0x9c) {
          this.#state = "ground";
          releasePending();
          plainStart = index + 1;
          continue;
        }
      }

      if (this.#state === "escape") {
        if (code === 0x1b) this.#state = "escape";
        else if (character === "[") this.#state = "csi";
        else if (character === "]") this.#state = "osc";
        else if (/[P_X^]/u.test(character)) this.#state = "string";
        // C0 controls execute without completing the ESC sequence.
        else if (code < 0x20 || code === 0x7f) continue;
        else if (code >= 0x30 && code <= 0x7e) {
          this.#state = "ground";
          releasePending();
          plainStart = index + 1;
        }
        continue;
      }

      if (this.#state === "csi") {
        if (code === 0x1b) this.#state = "escape";
        else if (code >= 0x40 && code <= 0x7e) {
          this.#state = "ground";
          releasePending();
          plainStart = index + 1;
        }
        continue;
      }

      if (this.#state === "osc" || this.#state === "string") {
        if ((this.#state === "osc" && code === 0x07) || code === 0x9c) {
          this.#state = "ground";
          releasePending();
          plainStart = index + 1;
        } else if (code === 0x1b) {
          // Keep the complete aborted string plus the new ESC atomic until
          // the replacement escape sequence itself reaches a final byte.
          this.#state = "escape";
        } else if (code === 0x9b) {
          this.#state = "csi";
        } else if (code === 0x9d) {
          this.#state = "osc";
        } else if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
          this.#state = "string";
        }
        continue;
      }
    }

    if (this.#state === "ground" && plainStart !== undefined && plainStart < data.length) {
      output += data.slice(plainStart);
    }
    return output;
  }

  /**
   * Return an incomplete suffix during teardown. When `cancel` is true, append
   * CAN so the parent shell never inherits an open OSC/DCS/APC parser state.
   */
  flush(cancel = false): string {
    const pending = this.#pending && cancel ? `${this.#pending}\x18` : this.#pending;
    this.#pending = "";
    this.#state = "ground";
    return pending;
  }
}

/**
 * Holds one final printable grapheme only when it is known to be ordinary
 * terminal text, never a CSI/OSC/APC final byte. The proxy can preview that
 * cell in the mirror and, if it creates pending-wrap, place images before
 * forwarding it to the real terminal. Parser state is retained across PTY
 * chunks.
 */
export interface HeldTerminalCell {
  data: string;
  held?: string;
  heldColumns?: number;
  /**
   * DEC synchronized-output mode in the real terminal before held is sent.
   * Present only when held itself contains a ?2026 transition, so the mirror
   * has already moved to a different mode while the real terminal has not.
   */
  heldSynchronizedOutputMode?: boolean;
}

interface SynchronizedOutputTransition {
  end: number;
  enabled: boolean;
}

interface ConsumedTerminalText {
  textRunStart?: number;
  /** Bounds of the last run parsed as printable ground-state text. */
  lastPrintableRunStart?: number;
  lastPrintableRunEnd?: number;
  /** Absolute offset of the final printable grapheme when it starts in this chunk. */
  lastGraphemeStart?: number;
  /** Whether that grapheme extends a cell from an earlier chunk or text run. */
  lastPrintableJoinsEarlier: boolean;
  synchronizedOutputModeBefore: boolean;
  synchronizedOutputTransitions: SynchronizedOutputTransition[];
}

export class TerminalCellHoldback {
  #state: ControlState = "ground";
  #csiParameters = "";
  #synchronizedOutputMode = false;
  readonly #graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  /**
   * Last printable terminal grapheme after the previous push has fully drained.
   *
   * Intl.Segmenter operates on one string at a time. Remembering this suffix is
   * therefore essential when a PTY callback splits a cluster after an emoji,
   * ZWJ, regional indicator, or base character. The value represents terminal
   * text, not bytes currently held by this object: callers write `held` before
   * invoking push again.
   */
  #trailingGrapheme = "";

  get isGround(): boolean {
    return this.#state === "ground";
  }

  /**
   * Advance only the control parser. The checkpoint splitter calls this for
   * individual UTF-16 units and does not need grapheme segmentation/width.
   */
  track(data: string): void {
    this.#consume(data, false);
  }

  #consume(data: string, collectPrintable = true): ConsumedTerminalText {
    let textRunStart: number | undefined;
    let lastPrintableRunStart: number | undefined;
    let lastPrintableRunEnd: number | undefined;
    let lastGraphemeStart: number | undefined;
    let lastPrintableJoinsEarlier = false;
    const synchronizedOutputModeBefore = this.#synchronizedOutputMode;
    const synchronizedOutputTransitions: SynchronizedOutputTransition[] = [];

    // Segment one contiguous printable run at a time. The previous
    // implementation allocated an object for every code point, rebuilt the
    // entire chunk, and segmented its final run a second time. Retaining only
    // the preceding grapheme is sufficient to decide the next boundary and
    // makes ordinary PTY output linear with very little allocation.
    const finishTextRun = (end: number): void => {
      if (textRunStart === undefined) return;
      if (collectPrintable) {
        lastPrintableRunStart = textRunStart;
        lastPrintableRunEnd = end;
        const previousGrapheme = this.#trailingGrapheme;
        const previousLength = this.#trailingGrapheme.length;
        const currentRun = data.slice(textRunStart, end);
        const combined = this.#trailingGrapheme + currentRun;
        const last = this.#graphemes.segment(combined).containing(combined.length - 1);
        if (last) {
          this.#trailingGrapheme = last.segment;
          // xterm is more permissive than Intl.Segmenter around malformed or
          // non-standard ZWJ chains. A positive-width cluster ending in ZWJ
          // absorbs a following emoji even when Intl reports a boundary at the
          // PTY callback. That emoji changes an existing cell rather than
          // advancing by its standalone width, so it is unsafe to hold alone.
          const xtermJoinsTrailingZwj = previousLength > 0
            && previousGrapheme.endsWith("\u200d")
            && last.index === previousLength
            && /^\p{Extended_Pictographic}/u.test(last.segment);
          // A callback that itself begins with `ZWJ + pictograph` also extends
          // the preceding xterm cell even when the remembered grapheme is an
          // ordinary ASCII base and Intl keeps both sides separate.
          const leadingZwjPictograph = /^(\u200d+)\p{Extended_Pictographic}/u.exec(currentRun);
          const xtermJoinsLeadingZwj = previousLength > 0
            && leadingZwjPictograph !== null
            // Only suppress holding when the final candidate is the joining
            // pictograph itself. A later ordinary cell is independent and is
            // still valuable as the pending-wrap preview cell.
            && last.index === previousLength + leadingZwjPictograph[1]!.length;
          lastPrintableJoinsEarlier = last.index < previousLength
            || xtermJoinsTrailingZwj
            || xtermJoinsLeadingZwj;
          lastGraphemeStart = lastPrintableJoinsEarlier
            ? undefined
            : textRunStart + last.index - previousLength;
        }
      }
      textRunStart = undefined;
    };

    for (let index = 0; index < data.length; index += 1) {
      const code = data.codePointAt(index)!;
      const codeUnits = code > 0xffff ? 2 : 1;

      if (this.#state === "ground"
        && code >= 0x20
        && !(code >= 0x7f && code <= 0x9f)
        && !(code >= 0xd800 && code <= 0xdfff)) {
        textRunStart ??= index;
        index += codeUnits - 1;
        continue;
      }

      // Any non-printing byte ends the current text run. xterm's grapheme
      // provider also starts a fresh print cluster after parser controls,
      // including SGR and cursor motion, so no lookbehind may cross one.
      finishTextRun(index);
      if (collectPrintable) this.#trailingGrapheme = "";

      // CAN and SUB cancel any escape/control string in progress.
      if (code === 0x18 || code === 0x1a) {
        this.#state = "ground";
        this.#csiParameters = "";
        continue;
      }

      // C1 introducers are "anywhere" transitions. The string-specific branch
      // below handles the same restarts while an OSC/DCS/APC is active.
      if (this.#state !== "osc"
        && this.#state !== "string") {
        if (code === 0x9b) {
          this.#state = "csi";
          this.#csiParameters = "";
          continue;
        }
        if (code === 0x9d) {
          this.#state = "osc";
          this.#csiParameters = "";
          continue;
        }
        if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
          this.#state = "string";
          this.#csiParameters = "";
          continue;
        }
        if (code === 0x9c) {
          this.#state = "ground";
          this.#csiParameters = "";
          continue;
        }
      }

      if (this.#state === "ground") {
        if (code === 0x1b) this.#state = "escape";
        continue;
      }

      if (this.#state === "escape") {
        // A fresh ESC restarts the escape sequence. Treating it as a generic
        // C0 byte would incorrectly return to ground and allow a checkpoint
        // immediately after the following [ (in the middle of a CSI).
        if (code === 0x1b) {
          this.#state = "escape";
          this.#csiParameters = "";
        }
        else if (data[index] === "[") {
          this.#state = "csi";
          this.#csiParameters = "";
        }
        else if (data[index] === "]") this.#state = "osc";
        else if (/[P_X^]/u.test(data[index]!)) this.#state = "string";
        // C0 controls are executed without cancelling the surrounding ESC
        // sequence. CAN and SUB were handled above and do cancel it.
        else if (code < 0x20 || code === 0x7f) continue;
        else if (code > 0x2f) {
          this.#state = "ground";
          this.#csiParameters = "";
        }
        continue;
      }

      if (this.#state === "csi") {
        if (code === 0x1b) {
          this.#state = "escape";
          this.#csiParameters = "";
        }
        else if (code >= 0x40 && code <= 0x7e) {
          if (this.#csiParameters === "?2026" && (code === 0x68 || code === 0x6c)) {
            this.#synchronizedOutputMode = code === 0x68;
            synchronizedOutputTransitions.push({
              end: index + 1,
              enabled: this.#synchronizedOutputMode
            });
          }
          this.#state = "ground";
          this.#csiParameters = "";
        } else if (code >= 0x20 && code <= 0x3f) {
          this.#csiParameters += data[index]!;
        }
        continue;
      }

      if (this.#state === "osc" || this.#state === "string") {
        if (this.#state === "osc" && code === 0x07) this.#state = "ground";
        else if (code === 0x9c) this.#state = "ground";
        else if (code === 0x1b) this.#state = "escape";
        else if (code === 0x9b) {
          this.#state = "csi";
          this.#csiParameters = "";
        }
        else if (code === 0x9d) this.#state = "osc";
        else if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
          this.#state = "string";
        }
        continue;
      }
    }

    const trailingTextRunStart = textRunStart;
    finishTextRun(data.length);
    return {
      textRunStart: trailingTextRunStart,
      lastPrintableRunStart,
      lastPrintableRunEnd,
      lastGraphemeStart,
      lastPrintableJoinsEarlier,
      synchronizedOutputModeBefore,
      synchronizedOutputTransitions
    };
  }

  #holdLastGrapheme(
    data: string,
    textRunStart: number,
    textRunEnd: number,
    consumed: ConsumedTerminalText
  ): HeldTerminalCell {
    const text = data.slice(textRunStart, textRunEnd);
    const segments = this.#graphemes.segment(text);
    let lastGraphemeStart = consumed.lastGraphemeStart !== undefined
      && consumed.lastGraphemeStart >= textRunStart
      && consumed.lastGraphemeStart < textRunEnd
      ? consumed.lastGraphemeStart - textRunStart
      : undefined;
    if (lastGraphemeStart === undefined) {
      lastGraphemeStart = segments.containing(text.length - 1)?.index ?? 0;
    }
    // xterm attaches a leading standalone ZWJ to a following pictograph. Hold
    // that prefix as well; otherwise previewing only the pictograph can change
    // an existing one-column placeholder into a two-column cell and make the
    // pending-wrap cursor delta smaller than `string-width` reports.
    let unsafeLeadingZeroWidth = false;
    while (lastGraphemeStart > 0) {
      const previous = segments.containing(lastGraphemeStart - 1);
      if (!previous) break;
      const forward = text.slice(lastGraphemeStart);
      if (stringWidth(previous.segment) > 0) {
        // `X ZWJ + emoji` is one xterm cell but two Intl graphemes. Holding
        // only the emoji would report two columns even though adding it to the
        // already-written X advances the cursor by just one.
        if (previous.segment.endsWith("\u200d")
          && /^\p{Extended_Pictographic}/u.test(forward)) {
          unsafeLeadingZeroWidth = true;
        }
        break;
      }
      if (!/^\u200d+$/u.test(previous.segment)
        || !/\p{Extended_Pictographic}/u.test(forward)) {
        unsafeLeadingZeroWidth = true;
        break;
      }
      lastGraphemeStart = previous.index;
    }
    const grapheme = text.slice(lastGraphemeStart);
    // Never hand a Writable one half of malformed UTF-16: each write encodes
    // strings independently and would turn that half into U+FFFD.
    if (/[\ud800-\udfff]/u.test(grapheme)) return { data };
    // The last printable token is only a suffix of a grapheme whose base cell
    // was already written. Sending the whole chunk keeps mirror and real cursor
    // state identical; there is no positive cell delta that CUP can restore.
    if (consumed.lastPrintableJoinsEarlier) return { data };
    // xterm gives most isolated zero-width clusters (for example a combining
    // mark after SGR) a one-column placeholder. `string-width` intentionally
    // reports zero, so no reliable cursor delta exists for that prefix.
    if (unsafeLeadingZeroWidth) return { data };
    const heldColumns = stringWidth(grapheme);
    if (heldColumns <= 0) return { data };
    const heldStart = textRunStart + lastGraphemeStart;
    const result = { data: data.slice(0, heldStart), held: data.slice(heldStart) };
    let heldSynchronizedOutputMode: boolean | undefined;
    if (consumed.synchronizedOutputTransitions.some((transition) => transition.end > heldStart)) {
      heldSynchronizedOutputMode = consumed.synchronizedOutputModeBefore;
      for (const transition of consumed.synchronizedOutputTransitions) {
        if (transition.end > heldStart) break;
        heldSynchronizedOutputMode = transition.enabled;
      }
    }
    return {
      ...result,
      ...(heldColumns === 1 ? {} : { heldColumns }),
      ...(heldSynchronizedOutputMode === undefined
        ? {}
        : { heldSynchronizedOutputMode })
    };
  }

  push(data: string): HeldTerminalCell {
    if (!data) return { data };
    if (this.#state === "ground"
      && (this.#trailingGrapheme === "" || /^[\x00-\x7f]$/u.test(this.#trailingGrapheme))
      && data.indexOf("\x1b") < 0
      && !/[^\x00-\x7f]/u.test(data)) {
      let lastPrintable = data.length - 1;
      while (lastPrintable >= 0) {
        const code = data.charCodeAt(lastPrintable);
        if (code >= 0x20 && code !== 0x7f) break;
        lastPrintable -= 1;
      }
      if (lastPrintable === data.length - 1) {
        this.#trailingGrapheme = data[lastPrintable]!;
        return { data: data.slice(0, -1), held: data.slice(-1) };
      }
      this.#trailingGrapheme = "";
      return { data };
    }
    const consumed = this.#consume(data);
    const { textRunStart } = consumed;
    if (this.#state === "ground" && textRunStart !== undefined) {
      return this.#holdLastGrapheme(
        data,
        textRunStart,
        data.length,
        consumed
      );
    }
    if (this.#state === "ground") {
      // SGR and DEC synchronized-output toggles change presentation state but
      // neither moves the cursor nor clears pending wrap. Keep a preceding
      // final cell together with these trailing controls so the real terminal
      // is still one cell behind the mirror during a scan.
      const zeroCellSuffix = /(?:(?:\x1b\[|\u009b)(?:[0-?]*[ -/]*m|\?2026[hl]))+$/u.exec(data);
      if (zeroCellSuffix?.index
        && consumed.lastPrintableRunStart !== undefined
        && consumed.lastPrintableRunEnd === zeroCellSuffix.index) {
        return this.#holdLastGrapheme(
          data,
          consumed.lastPrintableRunStart,
          zeroCellSuffix.index,
          consumed
        );
      }
    }
    return { data };
  }
}
