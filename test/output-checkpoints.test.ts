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
});

