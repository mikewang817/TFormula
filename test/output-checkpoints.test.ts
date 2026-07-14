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

  it("queries Unicode boundaries sparsely for a large mixed burst", () => {
    const splitter = new OutputCheckpointSplitter(10_000, 257);
    const unit = "界e\u0301🧑‍💻";
    const data = unit.repeat(20_000);
    const slices = splitter.push(data);
    expect(slices.map((slice) => slice.data).join("")).toBe(data);

    const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(data);
    let offset = 0;
    for (const slice of slices) {
      offset += slice.data.length;
      if (!slice.checkpoint) continue;
      const containing = segments.containing(offset - 1);
      expect(containing && containing.index + containing.segment.length, String(offset))
        .toBe(offset);
    }
  });

  it("does not repeatedly inspect a long combining sequence after reaching its budget", () => {
    const splitter = new OutputCheckpointSplitter(10_000, 32);
    const cluster = `e${"\u0301".repeat(20_000)}`;
    const data = `${"x".repeat(31)}${cluster}tail`;
    const slices = splitter.push(data);
    expect(slices.map((slice) => slice.data).join("")).toBe(data);
    expect(slices[0]).toEqual({
      data: `${"x".repeat(31)}${cluster}`,
      checkpoint: true
    });
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

  it("never checkpoints after a trailing ZWJ before its pictograph", () => {
    const splitter = new OutputCheckpointSplitter(100, 32);
    const prefix = `${"x".repeat(31)}A`;
    expect(splitter.push(prefix)).toEqual([{ data: prefix, checkpoint: false }]);
    expect(splitter.push("\u200d💻tail")).toEqual([
      { data: "\u200d💻", checkpoint: true },
      { data: "tail", checkpoint: false }
    ]);
  });

  it("keeps every fragmented 7-bit and C1 control atomic", () => {
    const controls = [
      "\x1b[38;2;1;2;3m",
      "\x1b]0;window title\x07",
      "\x1bP1;2|payload\x1b\\",
      "\x1b_Gi=42;OK\x1b\\",
      "\u009b2J",
      "\u009d0;title\u009c",
      "\u009fGi=42;OK\u009c",
      "\x1b[31;\u009dreset title\u009c",
      "\x1bPpayload\u009b2J"
    ];
    const transcript = `prefix-${controls.join("-visible-")}-suffix`;
    const protectedRanges: Array<[number, number]> = [];
    let searchFrom = 0;
    for (const control of controls) {
      const start = transcript.indexOf(control, searchFrom);
      protectedRanges.push([start, start + control.length]);
      searchFrom = start + control.length;
    }

    for (const width of [1, 2, 3, 5, 11]) {
      const splitter = new OutputCheckpointSplitter(100, 32);
      let output = "";
      const checkpointOffsets: number[] = [];
      for (let offset = 0; offset < transcript.length; offset += width) {
        for (const slice of splitter.push(transcript.slice(offset, offset + width))) {
          output += slice.data;
          if (slice.checkpoint) checkpointOffsets.push(output.length);
        }
      }
      expect(output, `width ${width}`).toBe(transcript);
      for (const checkpoint of checkpointOffsets) {
        expect(
          protectedRanges.some(([start, end]) => checkpoint > start && checkpoint < end),
          `width ${width}, checkpoint ${checkpoint}`
        ).toBe(false);
      }
    }
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

  it("keeps an aborted control string with the motion that terminates it", () => {
    const splitter = new OutputCheckpointSplitter(2, 32);
    const atomicMotion = "\x1b]unfinished title\x1b[100S";
    expect(splitter.push(`\\(x\\)${atomicMotion}`)).toEqual([
      { data: "\\(x\\)", checkpoint: true },
      { data: atomicMotion, checkpoint: false }
    ]);
  });

  it("recognizes large C1 motions without treating private CSI as motion", () => {
    const splitter = new OutputCheckpointSplitter(2, 32);
    expect(splitter.push("\\(x\\)\u009b100S")).toEqual([
      { data: "\\(x\\)", checkpoint: true },
      { data: "\u009b100S", checkpoint: false }
    ]);

    const privateCsi = new OutputCheckpointSplitter(2, 32);
    expect(privateCsi.push("\\(x\\)\x1b[?100S")).toEqual([
      { data: "\\(x\\)\x1b[?100S", checkpoint: false }
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
