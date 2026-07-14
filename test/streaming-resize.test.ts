import { createRequire } from "node:module";
import type { ITerminalAddon, Terminal as XtermTerminal } from "@xterm/headless";
import { describe, expect, it } from "vitest";
import { FormulaScreen } from "../src/screen.js";

const { Terminal } = createRequire(import.meta.url)("@xterm/headless") as {
  Terminal: typeof XtermTerminal;
};
const { UnicodeGraphemesAddon } = createRequire(import.meta.url)(
  "@xterm/addon-unicode-graphemes"
) as {
  UnicodeGraphemesAddon: new () => ITerminalAddon;
};

type Operation = { write: string } | { resize: [number, number] };

const formula = "\\nabla\\times\\mathbf{B}=\\mu_0\\mathbf{J}"
  + "+\\mu_0\\varepsilon_0\\frac{\\partial\\mathbf{E}}{\\partial t}";

// Minimized from random seed 9. Every write callback completes before the
// following resize, so this is not an unawaited xterm write race.
const operations: Operation[] = [
  { write: "\x1b[2J\x1b[H\r\nframe 9 中文\r\n\\[\r\n\\nabla\\times\\mathbf{B}=\\mu_0\\mathbf" },
  { resize: [69, 18] },
  { write: "{J}+\\mu_0\\varepsilon_0\\frac{\\partial" },
  { resize: [168, 22] },
  { write: "\\mathbf{E}}{\\partial t}\r\n\\]\r\nexplanation" },
  { resize: [85, 16] }
];

const capabilities = {
  kittyGraphics: true,
  foreground: "#eaf2f1",
  background: "#282a3a",
  cell: { width: 9, height: 18, source: "cell-query" as const }
};

function logicalBufferText(terminal: XtermTerminal): string {
  const buffer = terminal.buffer.active;
  let text = "";
  for (let index = 0; index < buffer.length; index += 1) {
    const line = buffer.getLine(index);
    if (!line) continue;
    if (index > 0 && !line.isWrapped) text += "\n";
    text += line.translateToString(true);
  }
  return text;
}

async function writeTerminal(terminal: XtermTerminal, data: string): Promise<void> {
  await new Promise<void>((resolve) => terminal.write(data, resolve));
}

async function replay(terminal: XtermTerminal): Promise<void> {
  for (const operation of operations) {
    if ("write" in operation) await writeTerminal(terminal, operation.write);
    else terminal.resize(...operation.resize);
  }
}

function createTerminal(reflowCursorLine: boolean): XtermTerminal {
  const terminal = new Terminal({
    cols: 100,
    rows: 24,
    scrollback: 10_000,
    allowProposedApi: true,
    reflowCursorLine
  });
  terminal.loadAddon(new UnicodeGraphemesAddon());
  return terminal;
}

describe("streaming output during terminal resize", () => {
  // This is a dependency-level control: xterm 6.0.0 is expected to fail it.
  // FormulaScreen must compensate without waiting for the upstream fix.
  it.fails("documents raw xterm's cursor-line reflow overwrite", async () => {
    const terminal = createTerminal(true);
    try {
      await replay(terminal);
      expect(logicalBufferText(terminal)).toContain(`\\[\n${formula}\n\\]`);
    } finally {
      terminal.dispose();
    }
  });

  it("appends after a minimal wrapped ASCII line is widened", async () => {
    const screen = new FormulaScreen({
      cols: 100,
      rows: 24,
      capabilities: { ...capabilities, kittyGraphics: false },
      scale: 1,
      writeOuter: () => undefined
    });
    try {
      await screen.write("A".repeat(10));
      screen.resize(20, 24);
      await screen.write("B".repeat(15));
      expect(screen.terminal.buffer.active.cursorX).toBe(5);
      expect(screen.terminal.buffer.active.cursorY).toBe(1);

      screen.resize(168, 24);
      expect(screen.terminal.buffer.active.cursorX).toBe(25);
      expect(screen.terminal.buffer.active.cursorY).toBe(0);
      await screen.write("C".repeat(8));
      expect(logicalBufferText(screen.terminal)).toContain(
        "A".repeat(10) + "B".repeat(15) + "C".repeat(8)
      );
    } finally {
      screen.dispose();
    }
  });

  it("restores pending wrap at an exact wide-cell boundary", async () => {
    const screen = new FormulaScreen({
      cols: 100,
      rows: 24,
      capabilities: { ...capabilities, kittyGraphics: false },
      scale: 1,
      writeOuter: () => undefined
    });
    const prefix = "你".repeat(5);
    const body = "A".repeat(30);
    try {
      await screen.write(prefix);
      screen.resize(20, 24);
      await screen.write(body);
      expect(screen.terminal.buffer.active.type).toBe("normal");
      expect(screen.terminal.buffer.active.cursorX).toBe(20);
      expect(screen.terminal.buffer.active.cursorY).toBe(1);

      // Forty occupied cells become one exactly-full row. The private x=40
      // is the pending-wrap state; the next wide grapheme must start row two
      // instead of overwriting the middle of row one.
      screen.resize(40, 24);
      expect(screen.terminal.buffer.active.cursorX).toBe(40);
      expect(screen.terminal.buffer.active.cursorY).toBe(0);
      await screen.write("你Z");
      expect(logicalBufferText(screen.terminal)).toContain(`${prefix}${body}你Z`);
    } finally {
      screen.dispose();
    }
  });

  it("keeps FormulaScreen's mirror parseable across the same write/resize order", async () => {
    const output: string[] = [];
    const debug: string[] = [];
    const screen = new FormulaScreen({
      cols: 100,
      rows: 24,
      capabilities,
      scale: 1,
      writeOuter: (data) => output.push(String(data)),
      debug: (message) => debug.push(message)
    });
    try {
      for (const operation of operations) {
        if ("write" in operation) await screen.write(operation.write);
        else screen.resize(...operation.resize);
      }
      await screen.flushScan();
      expect(logicalBufferText(screen.terminal)).toContain(`\\[\n${formula}\n\\]`);
      expect(output.join("")).toContain("a=p");
      expect(debug).not.toContain("formula render skipped: MathJax could not parse the formula");
    } finally {
      screen.dispose();
    }
  });
});
