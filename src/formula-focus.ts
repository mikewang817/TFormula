export type FormulaFocusAction = "open" | "next" | "previous" | "close";

export interface FormulaFocusInputResult {
  residual: string;
  actions: FormulaFocusAction[];
}

/** Kitty keyboard protocol (CSI-u) encoding of a Ctrl-<key> prefix, if any. */
function csiUControlKey(prefix: string): string {
  const code = prefix.length === 1 ? prefix.charCodeAt(0) : -1;
  if (code < 0 || code >= 0x20) return "";
  let key = code + 0x40;
  if (key >= 0x41 && key <= 0x5a) key += 0x20;
  return `\x1b[${key};5u`;
}

/**
 * Streaming keyboard state machine for the proxy focus overlay. The configured
 * prefix is a single control character. Once focused, every key is consumed so
 * navigation and exit input can never leak into the Agent PTY.
 */
export class FormulaFocusInput {
  #active = false;
  // While focused, a bare ESC closes the overlay but CSI/SS3 key sequences
  // (arrows, function keys) are swallowed whole so their tails cannot leak.
  #escape: "" | "esc" | "csi" | "ss3" = "";
  readonly #csiUPrefix: string;

  constructor(readonly prefix: string) {
    // Agents that enable the Kitty keyboard protocol receive Ctrl-<key> as CSI-u.
    this.#csiUPrefix = csiUControlKey(prefix);
  }

  get active(): boolean {
    return this.#active;
  }

  setActive(active: boolean): void {
    this.#active = active;
    this.#escape = "";
  }

  handle(data: string): FormulaFocusInputResult {
    if (!data || !this.prefix) return { residual: data, actions: [] };
    if (this.#csiUPrefix) data = data.replaceAll(this.#csiUPrefix, this.prefix);
    let residual = "";
    const actions: FormulaFocusAction[] = [];
    for (const character of data) {
      if (!this.#active) {
        if (character !== this.prefix) {
          residual += character;
          continue;
        }
        this.#active = true;
        actions.push("open");
        continue;
      }
      if (this.#escape === "esc") {
        this.#escape = character === "[" ? "csi" : character === "O" ? "ss3" : "";
        if (!this.#escape) this.#close(actions);
        continue;
      }
      if (this.#escape === "csi") {
        if (character >= "@" && character <= "~") this.#escape = "";
        continue;
      }
      if (this.#escape === "ss3") {
        this.#escape = "";
        continue;
      }
      if (character === "\x1b") {
        this.#escape = "esc";
      } else if (character === this.prefix || character === "q") {
        this.#close(actions);
      } else if (character === "n" || character === "j" || character === "\t") {
        actions.push("next");
      } else if (character === "p" || character === "k") {
        actions.push("previous");
      }
      // Unknown keys are intentionally swallowed while focused.
    }
    // A key press arrives as one chunk, so an ESC ending the chunk is the Escape key.
    if (this.#escape === "esc") this.#close(actions);
    return { residual, actions };
  }

  #close(actions: FormulaFocusAction[]): void {
    this.#active = false;
    this.#escape = "";
    actions.push("close");
  }
}
