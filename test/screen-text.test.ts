import { describe, expect, it } from "vitest";
import { detectScreenFormulaRegions } from "../src/screen-text.js";

describe("soft-wrapped terminal formula detection", () => {
  it("reassembles a standalone display split across physical rows", () => {
    const snapshot = detectScreenFormulaRegions([
      { row: 0, text: "\\[\\nabla \\cdot \\mathbf{E}=", isWrapped: false },
      { row: 1, text: "\\frac{\\rho}{\\varepsilon_0}\\]", isWrapped: true },
      { row: 2, text: "explanation", isWrapped: false }
    ], 40);

    expect(snapshot.regions).toEqual([expect.objectContaining({
      startRow: 0,
      endRow: 1,
      startCol: 0,
      endCol: 40,
      latex: "\\nabla \\cdot \\mathbf{E}=\\frac{\\rho}{\\varepsilon_0}",
      display: true
    })]);
  });

  it("centers an unwrapped standalone display across the terminal width", () => {
    const snapshot = detectScreenFormulaRegions([
      { row: 0, text: "$$\\frac{1}{x}$$", isWrapped: false },
      { row: 1, text: "description", isWrapped: false }
    ], 80);
    expect(snapshot.regions).toEqual([expect.objectContaining({
      startRow: 0,
      endRow: 0,
      startCol: 0,
      endCol: 80
    })]);
  });

  it("protects a logical line truncated at a viewport boundary", () => {
    const snapshot = detectScreenFormulaRegions([
      { row: 0, text: "continued formula\\]", isWrapped: true },
      { row: 1, text: "ordinary", isWrapped: false }
    ], 40);
    expect(snapshot.regions).toEqual([]);
    expect(snapshot.deferred).toEqual([]);
  });

  it("segments an inline formula that soft-wraps without covering prose", () => {
    const snapshot = detectScreenFormulaRegions([
      { row: 0, text: "prefix \\(\\operatorname{Var}", isWrapped: false },
      { row: 1, text: "(X_i)\\) suffix", isWrapped: true }
    ], 30);
    expect(snapshot.deferred).toEqual([]);
    expect(snapshot.regions).toEqual([expect.objectContaining({
      latex: "\\operatorname{Var}(X_i)\\text{ suffix}",
      composite: true,
      startRow: 0,
      endRow: 1,
      startCol: 0,
      endCol: 30,
      wrapSegments: [
        { rowOffset: 0, startCol: 7, endCol: 27, logicalStartCol: 0 },
        { rowOffset: 1, startCol: 0, endCol: 14, logicalStartCol: 20 }
      ]
    })]);
  });

  it("renders a trailing formula that remains whole after earlier prose wraps", () => {
    const snapshot = detectScreenFormulaRegions([
      { row: 0, text: "This is a deliberately long prefix before the tr", isWrapped: false },
      { row: 1, text: "ailing formula \\(x_i^2\\)", isWrapped: true }
    ], 50);
    expect(snapshot.deferred).toEqual([]);
    expect(snapshot.regions).toEqual([expect.objectContaining({
      startRow: 1,
      endRow: 1,
      latex: "x_i^2",
      compact: true
    })]);
  });

  it("keeps a borrowed blank row without treating it as a wrapped formula", () => {
    const snapshot = detectScreenFormulaRegions([
      { row: 0, text: "This is a deliberately long prefix before the tr", isWrapped: false },
      { row: 1, text: "ailing formula \\(x_i^2\\)", isWrapped: true },
      { row: 2, text: "", isWrapped: false }
    ], 50);
    expect(snapshot.deferred).toEqual([]);
    expect(snapshot.regions).toEqual([expect.objectContaining({
      startRow: 1,
      endRow: 2,
      latex: "x_i^2",
      compact: true
    })]);
  });

  it("segments a trailing formula that itself wraps and releases its borrowed blank row", () => {
    const snapshot = detectScreenFormulaRegions([
      { row: 0, text: "prefix \\(\\operatorname{Variance}", isWrapped: false },
      { row: 1, text: "(X_i)+\\frac{1}{2}\\)", isWrapped: true },
      { row: 2, text: "", isWrapped: false }
    ], 30);

    expect(snapshot.deferred).toEqual([]);
    expect(snapshot.regions).toEqual([expect.objectContaining({
      startRow: 0,
      endRow: 1,
      latex: "\\operatorname{Variance}(X_i)+\\frac{1}{2}",
      wrapSegments: expect.arrayContaining([
        expect.objectContaining({ rowOffset: 0, startCol: 7 }),
        expect.objectContaining({ rowOffset: 1, startCol: 0 })
      ])
    })]);
  });

  it("segments a wrapped display formula mixed with prose", () => {
    const snapshot = detectScreenFormulaRegions([
      { row: 0, text: "prefix \\[E=", isWrapped: false },
      { row: 1, text: "mc^2\\] suffix", isWrapped: true }
    ], 30);
    expect(snapshot.deferred).toEqual([]);
    expect(snapshot.regions).toEqual([expect.objectContaining({
      latex: "E=mc^2",
      wrapSegments: [
        { rowOffset: 0, startCol: 7, endCol: 11, logicalStartCol: 0 },
        { rowOffset: 1, startCol: 0, endCol: 6, logicalStartCol: 4 }
      ]
    })]);
  });

  it("segments display math across TUI-inserted hard rows", () => {
    const snapshot = detectScreenFormulaRegions([
      {
        row: 0,
        text: "4. $$\\oint_C \\mathbf{B} \\cdot d\\mathbf{l} = \\mu_0 I_{\\mathrm{enc}} +",
        isWrapped: false
      },
      {
        row: 1,
        text: "\\mu_0\\varepsilon_0\\frac{d}{dt}\\int_S \\mathbf{E} \\cdot d\\mathbf{A}$$",
        isWrapped: false
      }
    ], 100);

    expect(snapshot.deferred).toEqual([]);
    expect(snapshot.regions).toEqual([expect.objectContaining({
      startRow: 0,
      endRow: 1,
      startCol: 0,
      endCol: 100,
      display: true,
      wrapSegments: [
        expect.objectContaining({ rowOffset: 0, startCol: 3, logicalStartCol: 0 }),
        expect.objectContaining({ rowOffset: 1, startCol: 0 })
      ]
    })]);
  });

  it("composes inline formulas and literal text without language-specific rules", () => {
    const snapshot = detectScreenFormulaRegions([{
      row: 0,
      text: "values \\(x_i\\) alpha, \\(\\mathbf B\\) beta, \\(\\mu_0\\) gamma",
      isWrapped: false
    }], 100);

    expect(snapshot.regions).toEqual([expect.objectContaining({
      startRow: 0,
      endRow: 0,
      latex: "x_i\\text{ alpha, }\\mathbf B\\text{ beta, }\\mu_0\\text{ gamma}",
      display: false,
      composite: true
    })]);
  });

  it("centers numbered displays in one shared geometric column range", () => {
    const first = detectScreenFormulaRegions([{
      row: 0,
      text: "1. $$\\oiint_S \\mathbf E \\cdot d\\mathbf A=0$$",
      isWrapped: false
    }], 200).regions[0];
    const fourth = detectScreenFormulaRegions([{
      row: 0,
      text: "4. $$\\oint_C \\mathbf B \\cdot d\\mathbf l=\\mu_0 I+\\mu_0\\varepsilon_0\\frac{d}{dt}\\oiint_S \\mathbf E \\cdot d\\mathbf A$$",
      isWrapped: false
    }], 200).regions[0];

    expect(first?.displayRange).toEqual({ startCol: 3, endCol: 200 });
    expect(fourth?.displayRange).toEqual({ startCol: 3, endCol: 200 });
    expect(first?.startCol).toBe(0);
    expect(fourth?.startCol).toBe(0);
  });

  it("defers a compact definition group whose prose soft-wraps", () => {
    const snapshot = detectScreenFormulaRegions([
      { row: 0, text: "- (E): a very long description", isWrapped: false },
      { row: 1, text: "continued here", isWrapped: true },
      { row: 2, text: "- (B): magnetic field", isWrapped: false }
    ], 30);
    expect(snapshot.regions).toEqual([]);
    expect(snapshot.deferred).toHaveLength(1);
    expect(snapshot.deferred[0]).toMatchObject({ startRow: 0, endRow: 2 });
  });
});
