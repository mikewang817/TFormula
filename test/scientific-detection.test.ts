import { describe, expect, it } from "vitest";
import { detectFormulas } from "../src/detect.js";
import { detectScreenFormulaRegions } from "./mapped-formula-compat.js";
import { SCIENTIFIC_TERMINAL_CORPUS } from "./scientific-formula-corpus.js";

describe("scientific terminal formula detection corpus", () => {
  it.each(SCIENTIFIC_TERMINAL_CORPUS)(
    "$domain/$id recovers agent output after delimiter loss",
    ({ lines, expectedLatex, display = false }) => {
      const formulas = detectFormulas(lines);
      expect(formulas).toEqual(expect.arrayContaining([
        expect.objectContaining({ latex: expectedLatex })
      ]));
      const formula = formulas.find((candidate) => candidate.latex === expectedLatex);
      expect(formula?.intent !== "inline").toBe(display);
    }
  );

  it.each([
    "The process is (running).",
    "The unit tests are (green).",
    "Use [status] to inspect the current command."
  ])("does not reinterpret ordinary prose: %s", (line) => {
    expect(detectFormulas([line])).toEqual([]);
  });

  it("reassembles a scientific command split by terminal soft wrapping", () => {
    const snapshot = detectScreenFormulaRegions([
      {
        row: 0,
        text: "Acceleration \\(g=\\SI{9.81}{\\metre\\per\\seco",
        isWrapped: false
      },
      { row: 1, text: "nd\\squared}\\)", isWrapped: true }
    ], 50);

    expect(snapshot.deferred).toEqual([]);
    expect(snapshot.regions).toEqual([expect.objectContaining({
      latex: "g=\\SI{9.81}{\\metre\\per\\second\\squared}",
      confidence: "explicit"
    })]);
  });

  it("keeps a chemistry expression whole across TUI-inserted hard rows", () => {
    const snapshot = detectScreenFormulaRegions([
      { row: 0, text: "\\[\\ce{Fe^{3+} + SCN^-", isWrapped: false },
      { row: 1, text: "<=> [FeSCN]^{2+}}\\]", isWrapped: false }
    ], 50);

    expect(snapshot.deferred).toEqual([]);
    expect(snapshot.regions).toHaveLength(1);
    expect(snapshot.regions[0]).toMatchObject({ display: true, confidence: "explicit" });
    expect(snapshot.regions[0]!.latex.replace(/\s+/gu, " "))
      .toBe("\\ce{Fe^{3+} + SCN^- <=> [FeSCN]^{2+}}");
  });
});
