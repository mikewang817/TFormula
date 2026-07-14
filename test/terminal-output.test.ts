import { createRequire } from "node:module";
import type { Terminal as XtermTerminal } from "@xterm/headless";
import { describe, expect, it } from "vitest";
import {
  TerminalCellHoldback,
  TerminalControlGate,
  TerminalOutputTransformer
} from "../src/terminal-output.js";

const { Terminal } = createRequire(import.meta.url)("@xterm/headless") as {
  Terminal: typeof XtermTerminal;
};

function write(terminal: XtermTerminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

describe("TerminalControlGate", () => {
  it("releases plain text but retains a split control string until ST", () => {
    const gate = new TerminalControlGate();
    expect(gate.push("visible\x1b]0;half")).toBe("visible");
    expect(gate.hasPending).toBe(true);
    expect(gate.isGround).toBe(false);
    expect(gate.push(" title")).toBe("");
    expect(gate.push("\x1b\\after")).toBe("\x1b]0;half title\x1b\\after");
    expect(gate.hasPending).toBe(false);
    expect(gate.isGround).toBe(true);
  });

  it("never exposes a partial CSI, OSC, DCS, APC, or C1 control at any boundary", () => {
    const controls = [
      "\x1b[38;2;1;2;3m",
      "\x1b]0;window title\x07",
      "\x1bP1;2|payload\x1b\\",
      "\x1b_Gi=42;OK\x1b\\",
      "\u009b2J",
      "\u009d0;title\u009c",
      "\u009fGi=42;OK\u009c"
    ];
    const transcript = `before${controls.join("middle")}after`;
    for (let width = 1; width <= 11; width += 1) {
      const gate = new TerminalControlGate();
      let output = "";
      for (let offset = 0; offset < transcript.length; offset += width) {
        output += gate.push(transcript.slice(offset, offset + width));
      }
      expect(gate.hasPending, `width ${width}`).toBe(false);
      expect(output, `width ${width}`).toBe(transcript);
    }
  });

  it("keeps an entire split Kitty payload atomic relative to injected output", () => {
    const gate = new TerminalControlGate();
    const packet = `\x1b_Ga=t,m=0;${"QUJD".repeat(2_000)}\x1b\\`;
    const first = gate.push(packet.slice(0, 2_000));
    // At this point the caller may safely enqueue a TFormula transaction: the
    // real terminal has not seen the child's APC introducer at all.
    expect(first).toBe("");
    expect(gate.push(packet.slice(2_000))).toBe(packet);
  });

  it("releases cancelled and explicitly flushed controls byte-for-byte", () => {
    const gate = new TerminalControlGate();
    expect(gate.push("x\x1b]unterminated")).toBe("x");
    expect(gate.push("\x18y")).toBe("\x1b]unterminated\x18y");
    expect(gate.push("\x1b_Gpartial")).toBe("");
    expect(gate.flush()).toBe("\x1b_Gpartial");
    expect(gate.isGround).toBe(true);
  });

  it("can cancel a truncated child control before returning to the parent shell", () => {
    const gate = new TerminalControlGate();
    expect(gate.push("\x1b]open title")).toBe("");
    expect(gate.flush(true)).toBe("\x1b]open title\x18");
    expect(gate.isGround).toBe(true);
  });

  it("honors C1 anywhere transitions that restart an incomplete ESC or CSI", () => {
    for (const restarted of [
      "\x1b[31;\u009d0;title\u009c",
      "\x1b#\u009fGi=7;payload\u009c"
    ]) {
      const gate = new TerminalControlGate();
      const transition = restarted.search(/[\u009d\u009f]/u);
      expect(gate.push(restarted.slice(0, transition + 1))).toBe("");
      // ASCII in the OSC/APC payload must not be mistaken for the abandoned
      // CSI/ESC final byte.
      expect(gate.push(restarted.slice(transition + 1, -1))).toBe("");
      expect(gate.push(restarted.slice(-1))).toBe(restarted);
      expect(gate.isGround).toBe(true);
    }
  });

  it("treats ESC inside a control string as a new atomic escape sequence", () => {
    const gate = new TerminalControlGate();
    expect(gate.push("\x1b]open title\x1b[")).toBe("");
    expect(gate.isGround).toBe(false);
    expect(gate.push("2Jafter")).toBe("\x1b]open title\x1b[2Jafter");
    expect(gate.isGround).toBe(true);
  });

  it("treats a C1 introducer inside a control string as an atomic restart", () => {
    const gate = new TerminalControlGate();
    expect(gate.push("\x1bPpayload\u009b2")).toBe("");
    expect(gate.isGround).toBe(false);
    expect(gate.push("Jafter")).toBe("\x1bPpayload\u009b2Jafter");
    expect(gate.isGround).toBe(true);
  });
});

describe("TerminalOutputTransformer", () => {
  it("preserves ED 2 text and cursor semantics without forwarding ED 2", async () => {
    const transformer = new TerminalOutputTransformer();
    const transformed = transformer.push("\x1b[2J", true);
    expect(transformed.preservedEraseDisplayOffsets).toEqual([0]);
    expect(transformed.data).toBe("\x1b[0J\x1b[1J");
    expect(transformed.data).not.toContain("\x1b[2J");
    expect(transformed.data).not.toMatch(/\x1b[78]|\x1b\[[0-9;]*[HK]/u);

    const raw = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
    const rewritten = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
    try {
      const setup = "first\r\nsecond\r\nthird\x1b[2;4H";
      await write(raw, `${setup}\x1b[2J`);
      await write(rewritten, `${setup}${transformed.data}`);
      const rawLines = Array.from({ length: 4 }, (_, row) =>
        raw.buffer.active.getLine(row)?.translateToString(true) ?? ""
      );
      const rewrittenLines = Array.from({ length: 4 }, (_, row) =>
        rewritten.buffer.active.getLine(row)?.translateToString(true) ?? ""
      );
      expect(rewrittenLines).toEqual(rawLines);
      expect(rewritten.buffer.active.cursorX).toBe(raw.buffer.active.cursorX);
      expect(rewritten.buffer.active.cursorY).toBe(raw.buffer.active.cursorY);
    } finally {
      raw.dispose();
      rewritten.dispose();
    }
  });

  it("recognizes 7-bit and 8-bit ED 2 across every chunk boundary", () => {
    for (const sequence of ["before\x1b[2Jafter", "before\u009b2Jafter"]) {
      for (let split = 0; split <= sequence.length; split += 1) {
        const transformer = new TerminalOutputTransformer();
        const first = transformer.push(sequence.slice(0, split), true);
        const second = transformer.push(sequence.slice(split), true);
        expect(
          first.preservedEraseDisplayOffsets.length
            + second.preservedEraseDisplayOffsets.length,
          `${JSON.stringify(sequence)} split ${split}`
        )
          .toBe(1);
        expect(first.data + second.data, `${JSON.stringify(sequence)} split ${split}`)
          .toBe("before\x1b[0J\x1b[1Jafter");
        expect(transformer.flush(), `${JSON.stringify(sequence)} split ${split}`).toBe("");
      }
    }
  });

  it("uses the first ED parameter and leaves other erase modes untouched", () => {
    const transformer = new TerminalOutputTransformer();
    expect(transformer.push("\x1b[2;J\u009b3J", true)).toEqual({
      data: "\x1b[0J\x1b[1J\u009b3J",
      preservedEraseDisplayOffsets: [0]
    });
  });

  it("forwards ED 2 unchanged when image preservation is unsafe", () => {
    const transformer = new TerminalOutputTransformer();
    expect(transformer.push("\x1b[2J", false))
      .toEqual({ data: "\x1b[2J", preservedEraseDisplayOffsets: [] });
  });

  it("never rewrites plain ED-like text inside OSC or APC payload strings", () => {
    const transformer = new TerminalOutputTransformer();
    const transcript = [
      "\x1b]0;literal [2J title\x07",
      "\x1b_Gi=7;literal [2J response\x1b\\"
    ].join("");
    expect(transformer.push(transcript, true)).toEqual({
      data: transcript,
      preservedEraseDisplayOffsets: []
    });
  });

  it("rewrites ED 2 started by an ESC that aborts an OSC or APC string", async () => {
    for (const prefix of ["\x1b]0;title ", "\x1b_Gi=7;payload "]) {
      const input = `${prefix}\x1b[2Jafter`;
      for (let split = 0; split <= input.length; split += 1) {
        const transformer = new TerminalOutputTransformer();
        const first = transformer.push(input.slice(0, split), true);
        const second = transformer.push(input.slice(split), true);
        const transformed = first.data + second.data;
        expect(
          first.preservedEraseDisplayOffsets.length
            + second.preservedEraseDisplayOffsets.length,
          `${JSON.stringify(prefix)} split ${split}`
        ).toBe(1);
        expect(transformed).toBe(`${prefix}\x1b[0J\x1b[1Jafter`);

        const raw = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
        const rewritten = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
        try {
          const setup = "first\r\nsecond\r\nthird";
          await write(raw, setup + input);
          await write(rewritten, setup + transformed);
          const snapshot = (terminal: XtermTerminal) => ({
            lines: Array.from({ length: terminal.rows }, (_, row) =>
              terminal.buffer.active.getLine(row)?.translateToString(true) ?? ""
            ),
            cursorX: terminal.buffer.active.cursorX,
            cursorY: terminal.buffer.active.cursorY
          });
          expect(snapshot(rewritten)).toEqual(snapshot(raw));
        } finally {
          raw.dispose();
          rewritten.dispose();
        }
      }
    }
  });

  it("rewrites C1 ED 2 that aborts an OSC or DCS string", async () => {
    for (const prefix of ["\x1b]0;title ", "\x1bPpayload "]) {
      const input = `${prefix}\u009b2Jafter`;
      const transformer = new TerminalOutputTransformer();
      const transformed = transformer.push(input, true);
      expect(transformed.preservedEraseDisplayOffsets).toHaveLength(1);
      expect(transformed.data).toBe(`${prefix}\x1b[0J\x1b[1Jafter`);

      const raw = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
      const rewritten = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
      try {
        const setup = "first\r\nsecond\r\nthird";
        await write(raw, setup + input);
        await write(rewritten, setup + transformed.data);
        const snapshot = (terminal: XtermTerminal) => ({
          lines: Array.from({ length: terminal.rows }, (_, row) =>
            terminal.buffer.active.getLine(row)?.translateToString(true) ?? ""
          ),
          cursorX: terminal.buffer.active.cursorX,
          cursorY: terminal.buffer.active.cursorY
        });
        expect(snapshot(rewritten)).toEqual(snapshot(raw));
      } finally {
        raw.dispose();
        rewritten.dispose();
      }
    }
  });

  it("recognizes a real ED 2 after an earlier CSI is aborted by ESC", () => {
    const transformer = new TerminalOutputTransformer();
    expect(transformer.push("before\x1b[31;\x1b[2Jafter", true)).toEqual({
      data: "before\x1b[31;\x1b[0J\x1b[1Jafter",
      preservedEraseDisplayOffsets: [11]
    });
  });

  it("honors C1 restarts without treating OSC payload text as CSI finals", () => {
    const transformer = new TerminalOutputTransformer();
    const prefix = "\x1b[31;\u009d0;literal ESC[2J title\u009c";
    expect(transformer.push(`${prefix}\u009b2J`, true)).toEqual({
      data: `${prefix}\x1b[0J\x1b[1J`,
      preservedEraseDisplayOffsets: [prefix.length]
    });
  });

  it("does not close an Agent-owned synchronized-output frame", () => {
    const transformer = new TerminalOutputTransformer();
    const transformed = transformer.push("\x1b[?2026h\x1b[2J\x1b[?2026l", true);
    expect(transformed.preservedEraseDisplayOffsets).toEqual([8]);
    expect(transformed.data.match(/\x1b\[\?2026h/gu)).toHaveLength(1);
    expect(transformed.data.match(/\x1b\[\?2026l/gu)).toHaveLength(1);
  });

  it("rewrites ED 2 safely while origin mode is enabled", async () => {
    const transformer = new TerminalOutputTransformer();
    const transformed = transformer.push("\x1b[2;4r\x1b[?6h\x1b[2J", true);
    expect(transformed.preservedEraseDisplayOffsets).toHaveLength(1);
    expect(transformed.data).not.toContain("\x1b[2J");

    const raw = new Terminal({ cols: 10, rows: 5, allowProposedApi: true });
    const rewritten = new Terminal({ cols: 10, rows: 5, allowProposedApi: true });
    try {
      const setup = "one\r\ntwo\r\nthree\x1b[2;4r\x1b[?6h\x1b[2;3H";
      await write(raw, `${setup}\x1b[2JX`);
      await write(rewritten, `${setup}\x1b[0J\x1b[1JX`);
      const snapshot = (terminal: XtermTerminal) => ({
        lines: Array.from({ length: terminal.rows }, (_, row) =>
          terminal.buffer.active.getLine(row)?.translateToString(true) ?? ""
        ),
        cursorX: terminal.buffer.active.cursorX,
        cursorY: terminal.buffer.active.cursorY
      });
      expect(snapshot(rewritten)).toEqual(snapshot(raw));
    } finally {
      raw.dispose();
      rewritten.dispose();
    }
  });

  it("does not overwrite an Agent's saved cursor slot", async () => {
    const transformer = new TerminalOutputTransformer();
    const transformed = transformer.push("\x1b[2J", true);
    const raw = new Terminal({ cols: 20, rows: 8, allowProposedApi: true });
    const rewritten = new Terminal({ cols: 20, rows: 8, allowProposedApi: true });
    try {
      const setup = "\x1b[2;3H\x1b7\x1b[4;7H";
      const finish = "\x1b[1;1H\x1b8";
      await write(raw, `${setup}\x1b[2J${finish}`);
      await write(rewritten, `${setup}${transformed.data}${finish}`);
      expect(rewritten.buffer.active.cursorX).toBe(raw.buffer.active.cursorX);
      expect(rewritten.buffer.active.cursorY).toBe(raw.buffer.active.cursorY);
      expect(rewritten.buffer.active.cursorX).toBe(2);
      expect(rewritten.buffer.active.cursorY).toBe(1);
    } finally {
      raw.dispose();
      rewritten.dispose();
    }
  });

  it("preserves pending-wrap behavior at the right margin", async () => {
    const transformer = new TerminalOutputTransformer();
    const transformed = transformer.push("\x1b[2J", true);
    const raw = new Terminal({ cols: 5, rows: 3, allowProposedApi: true });
    const rewritten = new Terminal({ cols: 5, rows: 3, allowProposedApi: true });
    try {
      await write(raw, `12345\x1b[2JX`);
      await write(rewritten, `12345${transformed.data}X`);
      const lines = (terminal: XtermTerminal) => Array.from(
        { length: terminal.rows },
        (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? ""
      );
      expect(lines(rewritten)).toEqual(lines(raw));
      expect(rewritten.buffer.active.cursorX).toBe(raw.buffer.active.cursorX);
      expect(rewritten.buffer.active.cursorY).toBe(raw.buffer.active.cursorY);
    } finally {
      raw.dispose();
      rewritten.dispose();
    }
  });
});

describe("TerminalCellHoldback", () => {
  it("holds ordinary final cells but never escape-sequence final bytes", () => {
    const holdback = new TerminalCellHoldback();
    expect(holdback.push("\x1b[31mred")).toEqual({ data: "\x1b[31mre", held: "d" });
    expect(holdback.push("\x1b[0m")).toEqual({ data: "\x1b[0m" });
    expect(holdback.push("\x1b[2;3H")).toEqual({ data: "\x1b[2;3H" });
  });

  it("does not hold bytes inside split OSC or Kitty APC strings", () => {
    const holdback = new TerminalCellHoldback();
    expect(holdback.push("\x1b]0;title")).toEqual({ data: "\x1b]0;title" });
    expect(holdback.push("\x1b\\text")).toEqual({ data: "\x1b\\tex", held: "t" });
    expect(holdback.push("\x1b_Gi=1;OK")).toEqual({ data: "\x1b_Gi=1;OK" });
    expect(holdback.push("\x1b\\done")).toEqual({ data: "\x1b\\don", held: "e" });
  });

  it("keeps a restarted ESC sequence non-ground until its final byte", () => {
    const holdback = new TerminalCellHoldback();
    expect(holdback.push("\x1b\x1b[")).toEqual({ data: "\x1b\x1b[" });
    expect(holdback.isGround).toBe(false);
    expect(holdback.push("31m")).toEqual({ data: "31m" });
    expect(holdback.isGround).toBe(true);
  });

  it("honors C1 introducers from an in-progress escape sequence", () => {
    const holdback = new TerminalCellHoldback();
    expect(holdback.push("\x1b\u009b31")).toEqual({ data: "\x1b\u009b31" });
    expect(holdback.isGround).toBe(false);
    expect(holdback.push("m")).toEqual({ data: "m" });
    expect(holdback.isGround).toBe(true);
  });

  it("recognizes printable text after ESC aborts a control string", () => {
    const holdback = new TerminalCellHoldback();
    expect(holdback.push("\x1b]title\x1b[2JX")).toEqual({
      data: "\x1b]title\x1b[2J",
      held: "X"
    });
    expect(holdback.isGround).toBe(true);
  });

  it("holds a complete Unicode grapheme and reports wide terminal cells", () => {
    const holdback = new TerminalCellHoldback();
    expect(holdback.push("中文")).toEqual({
      data: "中",
      held: "文",
      heldColumns: 2
    });
    expect(holdback.push("status 🧑‍💻")).toEqual({
      data: "status ",
      held: "🧑‍💻",
      heldColumns: 2
    });
    expect(holdback.push("Cafe\u0301")).toEqual({
      data: "Caf",
      held: "e\u0301"
    });
  });

  it("does not invent a cursor delta for an emoji cluster continued by a later chunk", () => {
    const holdback = new TerminalCellHoldback();
    expect(holdback.push("abc👩")).toEqual({
      data: "abc",
      held: "👩",
      heldColumns: 2
    });
    // The first held cell has drained before the next PTY callback. ZWJ + laptop
    // extends that existing two-column cell; it is not a new two-column cell
    // which the pending-wrap cursor restore may subtract from cursorX.
    expect(holdback.push("\u200d💻")).toEqual({ data: "\u200d💻" });
  });

  it("retains grapheme lookbehind when ZWJ and its pictograph arrive separately", () => {
    const holdback = new TerminalCellHoldback();
    expect(holdback.push("👩")).toEqual({ held: "👩", data: "", heldColumns: 2 });
    expect(holdback.push("\u200d")).toEqual({ data: "\u200d" });
    expect(holdback.push("💻")).toEqual({ data: "💻" });
    // A later ordinary cell still gets the usual one-cell holdback.
    expect(holdback.push("x")).toEqual({ data: "", held: "x" });
  });

  it("does not hold a backward-joining emoji suffix split by SGR controls", () => {
    const holdback = new TerminalCellHoldback();
    expect(holdback.push("👩\x1b[31m\u200d💻")).toEqual({
      data: "👩\x1b[31m\u200d💻"
    });
  });

  it("holds the final grapheme together with trailing SGR controls", () => {
    const holdback = new TerminalCellHoldback();
    expect(holdback.push("\x1b[31m中文\x1b[0m")).toEqual({
      data: "\x1b[31m中",
      held: "文\x1b[0m",
      heldColumns: 2
    });
    expect(holdback.push("value\x1b[1m\x1b[0m")).toEqual({
      data: "valu",
      held: "e\x1b[1m\x1b[0m"
    });
  });

  it("holds the final wide grapheme with SGR and DEC 2026 suffixes", () => {
    const holdback = new TerminalCellHoldback();
    expect(holdback.push("\x1b[?2026h")).toEqual({ data: "\x1b[?2026h" });
    expect(holdback.push("中文\x1b[0m\x1b[?2026l")).toEqual({
      data: "中",
      held: "文\x1b[0m\x1b[?2026l",
      heldColumns: 2,
      heldSynchronizedOutputMode: true
    });
    expect(holdback.push("value\u009b?2026l")).toEqual({
      data: "valu",
      held: "e\u009b?2026l",
      heldSynchronizedOutputMode: false
    });
    expect(holdback.push("next\x1b[?2026h")).toEqual({
      data: "nex",
      held: "t\x1b[?2026h",
      heldSynchronizedOutputMode: false
    });
  });

  it("derives the pre-held sync mode from transitions earlier in the same chunk", () => {
    const holdback = new TerminalCellHoldback();
    expect(holdback.push("\x1b[?2026hvalue\x1b[?2026l")).toEqual({
      data: "\x1b[?2026hvalu",
      held: "e\x1b[?2026l",
      heldSynchronizedOutputMode: true
    });
  });

  it("tracks DEC 2026 after ESC aborts an OSC payload", () => {
    const holdback = new TerminalCellHoldback();
    expect(
      holdback.push("\x1b]0;literal \x1b[?2026h title\x07value\x1b[?2026l")
    ).toEqual({
      data: "\x1b]0;literal \x1b[?2026h title\x07valu",
      held: "e\x1b[?2026l",
      heldSynchronizedOutputMode: true
    });
  });

  it("never holds an isolated UTF-16 surrogate", () => {
    const holdback = new TerminalCellHoldback();
    expect(holdback.push("text\ud83e")).toEqual({ data: "text\ud83e" });
    expect(holdback.push("\uddea")).toEqual({ data: "\uddea" });
  });
});
