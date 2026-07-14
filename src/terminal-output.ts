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
  #state: "ground" | "escape" | "csi" | "osc" | "string" | "string-escape" = "ground";
  #stringState: "osc" | "string" = "string";
  #pending = "";

  push(
    input: string,
    preserveImages: boolean
  ): TransformedTerminalOutput {
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
        output += character;
        if (code === 0x18 || code === 0x1a || code === 0x9c
          || (this.#state === "osc" && code === 0x07)) {
          this.#state = "ground";
        } else if (code === 0x1b) {
          this.#stringState = this.#state;
          this.#state = "string-escape";
        }
        continue;
      }

      if (this.#state === "string-escape") {
        output += character;
        if (code === 0x18 || code === 0x1a || code === 0x9c || character === "\\") {
          this.#state = "ground";
        } else if (code !== 0x1b) {
          this.#state = this.#stringState;
        }
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

type ControlState = "ground" | "escape" | "csi" | "osc" | "string" | "string-escape";

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
  #stringState: "osc" | "string" = "string";
  #pending = "";

  get isGround(): boolean {
    return this.#state === "ground";
  }

  get hasPending(): boolean {
    return this.#pending.length > 0;
  }

  push(data: string): string {
    if (!data) return "";
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

      // C1 introducers are "anywhere" transitions outside payload strings.
      // In particular, a C1 OSC/APC can abort an incomplete ESC or CSI. If we
      // kept parsing the old CSI, its first ASCII payload letter would look
      // like a final byte and we could release while the real terminal is
      // still inside the newly opened string.
      if (this.#state !== "osc"
        && this.#state !== "string"
        && this.#state !== "string-escape") {
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
          this.#stringState = this.#state;
          this.#state = "string-escape";
        }
        continue;
      }

      if (this.#state === "string-escape") {
        if (character === "\\" || code === 0x9c) {
          this.#state = "ground";
          releasePending();
          plainStart = index + 1;
        } else if (code !== 0x1b) {
          this.#state = this.#stringState;
        }
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
  synchronizedOutputModeBefore: boolean;
  synchronizedOutputTransitions: SynchronizedOutputTransition[];
}

export class TerminalCellHoldback {
  #state: ControlState = "ground";
  #stringState: "osc" | "string" = "string";
  #csiParameters = "";
  #synchronizedOutputMode = false;
  readonly #graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

  get isGround(): boolean {
    return this.#state === "ground";
  }

  /**
   * Advance only the control parser. The checkpoint splitter calls this for
   * individual UTF-16 units and does not need grapheme segmentation/width.
   */
  track(data: string): void {
    this.#consume(data);
  }

  #consume(data: string): ConsumedTerminalText {
    let textRunStart: number | undefined;
    const synchronizedOutputModeBefore = this.#synchronizedOutputMode;
    const synchronizedOutputTransitions: SynchronizedOutputTransition[] = [];
    for (let index = 0; index < data.length; index += 1) {
      const code = data.codePointAt(index)!;
      const codeUnits = code > 0xffff ? 2 : 1;

      // CAN and SUB cancel any escape/control string in progress.
      if (code === 0x18 || code === 0x1a) {
        this.#state = "ground";
        this.#csiParameters = "";
        textRunStart = undefined;
        continue;
      }

      // C1 introducers are "anywhere" transitions in the VT parser (outside
      // payload strings). Handling them only from ground can expose the bytes
      // after a restarted/aborted escape sequence as ordinary text.
      if (this.#state !== "osc"
        && this.#state !== "string"
        && this.#state !== "string-escape") {
        if (code === 0x9b) {
          this.#state = "csi";
          this.#csiParameters = "";
          textRunStart = undefined;
          continue;
        }
        if (code === 0x9d) {
          this.#state = "osc";
          this.#csiParameters = "";
          textRunStart = undefined;
          continue;
        }
        if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
          this.#state = "string";
          this.#csiParameters = "";
          textRunStart = undefined;
          continue;
        }
        if (code === 0x9c) {
          this.#state = "ground";
          this.#csiParameters = "";
          textRunStart = undefined;
          continue;
        }
      }

      if (this.#state === "ground") {
        if (code === 0x1b) this.#state = "escape";
        else if (code >= 0x20
          && !(code >= 0x7f && code <= 0x9f)
          && !(code >= 0xd800 && code <= 0xdfff)) {
          textRunStart ??= index;
          index += codeUnits - 1;
          continue;
        }
        textRunStart = undefined;
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
        else if (code < 0x20 || code === 0x7f) {
          textRunStart = undefined;
          continue;
        }
        else if (code > 0x2f) {
          this.#state = "ground";
          this.#csiParameters = "";
        }
        textRunStart = undefined;
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
        textRunStart = undefined;
        continue;
      }

      if (this.#state === "osc" || this.#state === "string") {
        if (this.#state === "osc" && code === 0x07) this.#state = "ground";
        else if (code === 0x9c) this.#state = "ground";
        else if (code === 0x1b) {
          this.#stringState = this.#state;
          this.#state = "string-escape";
        }
        textRunStart = undefined;
        continue;
      }

      if (this.#state === "string-escape") {
        if (data[index] === "\\" || code === 0x9c) this.#state = "ground";
        else if (code !== 0x1b) this.#state = this.#stringState;
        textRunStart = undefined;
      }
    }
    return {
      textRunStart,
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
    let lastGraphemeStart = 0;
    for (const segment of this.#graphemes.segment(text)) {
      lastGraphemeStart = segment.index;
    }
    const grapheme = text.slice(lastGraphemeStart);
    // Never hand a Writable one half of malformed UTF-16: each write encodes
    // strings independently and would turn that half into U+FFFD.
    if (/[\ud800-\udfff]/u.test(grapheme)) return { data };
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
    const consumed = this.#consume(data);
    const { textRunStart } = consumed;
    if (this.#state === "ground" && textRunStart !== undefined) {
      return this.#holdLastGrapheme(data, textRunStart, data.length, consumed);
    }
    if (this.#state === "ground") {
      // SGR and DEC synchronized-output toggles change presentation state but
      // neither moves the cursor nor clears pending wrap. Keep a preceding
      // final cell together with these trailing controls so the real terminal
      // is still one cell behind the mirror during a scan.
      const zeroCellSuffix = /(?:(?:\x1b\[|\u009b)(?:[0-?]*[ -/]*m|\?2026[hl]))+$/u.exec(data);
      if (zeroCellSuffix?.index) {
        const beforeControls = data.slice(0, zeroCellSuffix.index);
        const textSuffix = /[^\x00-\x1f\x7f-\x9f]+$/u.exec(beforeControls);
        if (textSuffix?.index !== undefined) {
          return this.#holdLastGrapheme(
            data,
            textSuffix.index,
            zeroCellSuffix.index,
            consumed
          );
        }
      }
    }
    return { data };
  }
}
