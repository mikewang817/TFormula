import { FOCUS_NEXT, FOCUS_PREVIOUS } from "./formula-focus.js";

/**
 * Translate only TFormula's focus keys from Kitty/CSI-u keyboard reports.
 * OpenCode enables enhanced keyboard input in Ghostty, so Ctrl-\ arrives as
 * ESC [ 92 ; 5 u rather than the legacy C0 byte 0x1c. All unrelated reports
 * are passed to the child unchanged, including sequences split across reads.
 */
export class FocusKeyDecoder {
  #tail = "";

  constructor(readonly shortcuts: ReadonlySet<string>) {}

  get hasPending(): boolean {
    return this.#tail.length > 0;
  }

  flush(): string {
    const tail = this.#tail;
    this.#tail = "";
    return tail;
  }

  push(data: string, focused: boolean): string {
    const input = this.#tail + data;
    this.#tail = "";
    let output = "";
    for (let index = 0; index < input.length;) {
      const char = input[index]!;
      if (char !== "\x1b" && char !== "\u009b") {
        output += char;
        index += 1;
        continue;
      }
      const csi = char === "\u009b" || input[index + 1] === "[";
      if (char === "\x1b" && index + 1 >= input.length) {
        this.#tail = input.slice(index);
        break;
      }
      if (!csi) {
        output += char;
        index += 1;
        continue;
      }
      const start = index + (char === "\u009b" ? 1 : 2);
      let end = start;
      while (end < input.length && end - start < 128
        && !/[\x40-\x7e]/u.test(input[end]!)) end += 1;
      if (end >= input.length && end - start < 128) {
        this.#tail = input.slice(index);
        break;
      }
      if (end - start >= 128) {
        output += input.slice(index, end);
        index = end;
        continue;
      }
      const sequence = input.slice(index, end + 1);
      output += this.#decode(sequence, input[end]!, input.slice(start, end), focused);
      index = end + 1;
    }
    return output;
  }

  #decode(sequence: string, final: string, parameters: string, focused: boolean): string {
    if (final === "A") return focused ? FOCUS_PREVIOUS : sequence;
    if (final === "B") return focused ? FOCUS_NEXT : sequence;
    if (final !== "u") return focused ? "" : sequence;
    // Kitty primary codepoint, optional shifted/base codepoints, modifier mask
    // (+1), optional press/repeat/release type, optional associated text.
    const match = /^(\d+)(?::\d*){0,2}(?:;(\d+)(?::([123]))?)?(?:;[\d:]+)?$/u.exec(parameters);
    if (!match) return focused ? "" : sequence;
    const codepoint = Number(match[1]);
    const modifiers = Number(match[2] ?? "1") - 1;
    const event = Number(match[3] ?? "1");
    if (!Number.isSafeInteger(codepoint) || codepoint > 0x10ffff
      || !Number.isSafeInteger(modifiers)) return focused ? "" : sequence;

    // CapsLock and NumLock describe keyboard state, not extra shortcut keys.
    // Ghostty reported Ctrl-F with NumLock on as CSI 102;133u (132 = Ctrl|Num).
    const lockModifiers = 64 | 128;
    const ctrl = (modifiers & 4) !== 0;
    const otherModifiers = modifiers & ~(1 | 4 | lockModifiers); // Shift is allowed.
    const shortcut = ctrl && otherModifiers === 0 && codepoint >= 32 && codepoint < 127
      ? String.fromCharCode(codepoint & 0x1f)
      : "";
    if (shortcut && this.shortcuts.has(shortcut)) return event === 1 ? shortcut : "";
    if (!focused) return sequence;
    if (event === 3) return "";
    if (modifiers & ~(1 | lockModifiers)) return "";
    if (codepoint === 27) return "\x1b";
    return "";
  }
}
