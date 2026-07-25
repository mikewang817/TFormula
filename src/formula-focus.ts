export type FormulaFocusAction = "open" | "next" | "previous" | "close";

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
      if (character === this.prefix || character === "q" || character === "\x1b") {
        this.#active = false;
        actions.push("close");
      } else if (character === "n" || character === "j" || character === "\t") {
        actions.push("next");
      } else if (character === "p" || character === "k") {
        actions.push("previous");
      }
      // Unknown keys are intentionally swallowed while focused.
    }
    return { residual, actions };
  }
}
