export type FormulaFocusAction = "open" | "next" | "previous" | "close";

// Internal tokens emitted by FocusKeyDecoder for Up/Down. They cannot be
// produced by ordinary text input, so letters such as n/j/p/k never become
// accidental focus commands.
export const FOCUS_NEXT = "\x0e";
export const FOCUS_PREVIOUS = "\x10";

export interface FormulaFocusInputResult {
  residual: string;
  actions: FormulaFocusAction[];
}

/**
 * Streaming keyboard state machine for the proxy focus overlay. The configured
 * prefix is a single control character. Once focused, every key is consumed so
 * navigation and exit input can never leak into the Agent PTY.
 */
export class FormulaFocusInput {
  #active = false;

  constructor(readonly prefix: string) {}

  get active(): boolean {
    return this.#active;
  }

  setActive(active: boolean): void {
    this.#active = active;
  }

  handle(data: string): FormulaFocusInputResult {
    if (!data || !this.prefix) return { residual: data, actions: [] };
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
      if (character === "\x1b") {
        this.#active = false;
        actions.push("close");
      } else if (character === FOCUS_NEXT) {
        actions.push("next");
      } else if (character === FOCUS_PREVIOUS) {
        actions.push("previous");
      }
      // Unknown keys are intentionally swallowed while focused.
    }
    return { residual, actions };
  }
}
