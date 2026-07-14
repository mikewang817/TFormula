import { describe, expect, it } from "vitest";
import { OutputCheckpointSplitter } from "../src/output-checkpoints.js";

describe("OutputCheckpointSplitter", () => {
  it("retains its line count across PTY chunks and splits only after newlines", () => {
    const splitter = new OutputCheckpointSplitter(3);
    expect(splitter.push("one\ntwo\n")).toEqual([
      { data: "one\ntwo\n", checkpoint: false }
    ]);
    expect(splitter.push("three\nfour\n")).toEqual([
      { data: "three\n", checkpoint: true },
      { data: "four\n", checkpoint: false }
    ]);
  });

  it("adapts its checkpoint interval after a terminal resize", () => {
    const splitter = new OutputCheckpointSplitter(8);
    splitter.push("one\ntwo\n");
    splitter.setLineInterval(3);
    expect(splitter.push("three\nrest")).toEqual([
      { data: "three\n", checkpoint: true },
      { data: "rest", checkpoint: false }
    ]);
  });

  it("adds bounded checkpoints to long output without newlines", () => {
    const splitter = new OutputCheckpointSplitter(100, 32);
    const data = "x".repeat(75);
    const slices = splitter.push(data);
    expect(slices).toEqual([
      { data: "x".repeat(32), checkpoint: true },
      { data: "x".repeat(32), checkpoint: true },
      { data: "x".repeat(11), checkpoint: false }
    ]);
    expect(slices.map((slice) => slice.data).join("")).toBe(data);
  });

  it("waits for OSC and APC strings to finish before a size checkpoint", () => {
    const splitter = new OutputCheckpointSplitter(100, 32);
    const osc = `\x1b]0;${"t".repeat(40)}\x1b\\`;
    const apc = `\x1b_G${"a".repeat(40)}\x1b\\`;
    const slices = splitter.push(`${osc}${apc}visible tail`);
    expect(slices.map((slice) => slice.data).join("")).toBe(`${osc}${apc}visible tail`);
    let offset = 0;
    const protectedRanges = [
      [0, osc.length],
      [osc.length, osc.length + apc.length]
    ];
    for (const slice of slices) {
      offset += slice.data.length;
      if (!slice.checkpoint) continue;
      expect(protectedRanges.some(([start, end]) => offset > start! && offset < end!))
        .toBe(false);
    }
  });

  it("never checkpoints inside a restarted ESC sequence", () => {
    const splitter = new OutputCheckpointSplitter(100, 32);
    const prefix = "x".repeat(31);
    const data = prefix + "\x1b\x1b[31mred";
    const slices = splitter.push(data);
    expect(slices.map((slice) => slice.data).join("")).toBe(data);
    expect(slices[0]).toEqual({
      data: prefix + "\x1b\x1b[31m",
      checkpoint: true
    });
  });

  it("never checkpoints between a UTF-16 surrogate pair", () => {
    const splitter = new OutputCheckpointSplitter(100, 32);
    const prefix = "x".repeat(31);
    const data = prefix + "🧪-tail";
    const slices = splitter.push(data);
    expect(slices.map((slice) => slice.data).join("")).toBe(data);
    expect(slices[0]).toEqual({
      data: prefix + "🧪",
      checkpoint: true
    });
    expect(slices[0]!.data.endsWith("\ud83e")).toBe(false);
  });

  it("never checkpoints inside a Unicode grapheme cluster", () => {
    for (const grapheme of ["e\u0301", "🧑‍💻", "👨‍👩‍👧‍👦"]) {
      const splitter = new OutputCheckpointSplitter(100, 32);
      const prefix = "x".repeat(31);
      const data = prefix + grapheme + "-tail";
      const slices = splitter.push(data);
      expect(slices.map((slice) => slice.data).join(""), grapheme).toBe(data);
      expect(slices[0], grapheme).toEqual({
        data: prefix + grapheme,
        checkpoint: true
      });
    }
  });

  it("does not add a size checkpoint between CR and LF", () => {
    const splitter = new OutputCheckpointSplitter(100, 32);
    const prefix = "x".repeat(31);
    expect(splitter.push(prefix + "\r\nnext")).toEqual([
      { data: prefix + "\r\nn", checkpoint: true },
      { data: "ext", checkpoint: false }
    ]);
  });

  it("waits across PTY callbacks for a possible grapheme continuation", () => {
    const splitter = new OutputCheckpointSplitter(100, 32);
    const prefix = "x".repeat(31);
    expect(splitter.push(prefix + "e")).toEqual([
      { data: prefix + "e", checkpoint: false }
    ]);
    expect(splitter.push("\u0301tail")).toEqual([
      { data: "\u0301", checkpoint: true },
      { data: "tail", checkpoint: false }
    ]);
  });

  it("checkpoints before repeated IND controls can scroll a formula away", () => {
    const splitter = new OutputCheckpointSplitter(2, 32);
    const formula = "\\(x\\)";
    const ind = "\x1bD";
    expect(splitter.push(formula + ind.repeat(4))).toEqual([
      { data: formula + ind, checkpoint: true },
      { data: ind.repeat(2), checkpoint: true },
      { data: ind, checkpoint: false }
    ]);
  });

  it("checkpoints before one large CSI scroll command", () => {
    const splitter = new OutputCheckpointSplitter(2, 32);
    expect(splitter.push("\\(x\\)\x1b[100S")).toEqual([
      { data: "\\(x\\)", checkpoint: true },
      { data: "\x1b[100S", checkpoint: false }
    ]);
  });

  it("emits an empty barrier when a large motion starts the next PTY callback", () => {
    const splitter = new OutputCheckpointSplitter(2, 32);
    expect(splitter.push("\\(x\\)")).toEqual([
      { data: "\\(x\\)", checkpoint: false }
    ]);
    expect(splitter.push("\x1b[100S")).toEqual([
      { data: "", checkpoint: true },
      { data: "\x1b[100S", checkpoint: false }
    ]);
  });

  it("checkpoints before REP expands a short byte sequence into many cells", () => {
    const splitter = new OutputCheckpointSplitter(100, 32);
    expect(splitter.push("\\(x\\)A\x1b[100b")).toEqual([
      { data: "\\(x\\)A", checkpoint: true },
      { data: "\x1b[100b", checkpoint: false }
    ]);
  });

  it("budgets C1 IND, NEL, and RI as line motions", () => {
    const splitter = new OutputCheckpointSplitter(2, 32);
    expect(splitter.push("formula\u0084\u0085\u008d")).toEqual([
      { data: "formula\u0084", checkpoint: true },
      { data: "\u0085\u008d", checkpoint: false }
    ]);
  });
});
