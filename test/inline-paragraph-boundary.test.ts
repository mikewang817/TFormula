import { describe, expect, it } from "vitest";
import { detectFormulas } from "../src/detect.js";

const inlineDelimiters = [
  ["slash", "\\(", "\\)"],
  ["dollar", "$", "$"]
];

describe("inline delimiter paragraph boundaries", () => {
  it.each(inlineDelimiters)("keeps %s math out of a later status paragraph", (_name, open, close) => {
    const formulas = detectFormulas([
      open,
      "x=\\frac{1}{2}",
      "",
      "Working on the next task",
      close
    ]);
    expect(formulas.map((formula) => formula.latex)).toEqual(["x=\\frac{1}{2}"]);
  });

  it("recovers a later dollar formula after a stale opener in a previous paragraph", () => {
    expect(detectFormulas(["$\\frac{1}{2}", "", "$a$"]))
      .toEqual([expect.objectContaining({ latex: "a", confidence: "explicit" })]);
  });

  it.each(inlineDelimiters)("retains %s inline math hard-wrapped across adjacent rows", (_name, open, close) => {
    expect(detectFormulas([open + "x=", "\\frac{1}{2}" + close]).map((formula) => formula.latex))
      .toEqual(["x=\n\\frac{1}{2}"]);
  });

  it.each([
    ["slash", "\\[", "\\]"],
    ["dollar", "$$", "$$"]
  ])("retains %s display math with a blank row", (_name, open, close) => {
    expect(detectFormulas([open, "x=1", "", "+y", close]).map((formula) => formula.latex))
      .toEqual(["x=1\n\n+y"]);
  });

  it.each(inlineDelimiters)("does not pair %s delimiters across a blank row inside braces", (_name, open, close) => {
    expect(detectFormulas([open + "x=\\text{a", "", "b}" + close])).toEqual([]);
  });
});
