import { describe, expect, it } from "vitest";
import {
  detectScreenFormulaRegions,
  screenTextInternals
} from "../src/screen-text.js";

describe("soft-wrapped terminal formula detection", () => {
  it("indexes ASCII directly and never splits Unicode grapheme clusters", () => {
    const ascii = screenTextInternals.createVisualColumnIndex("abc");
    expect(ascii.width).toBe(3);
    expect(ascii.utf16IndexAt(2)).toBe(2);
    expect(ascii.visualColumnAt(2)).toBe(2);

    const unicode = screenTextInternals.createVisualColumnIndex("A👩‍💻e\u0301界Z");
    expect(unicode.width).toBe(7);
    expect([
      unicode.utf16IndexAt(0),
      unicode.utf16IndexAt(1),
      unicode.utf16IndexAt(2),
      unicode.utf16IndexAt(3),
      unicode.utf16IndexAt(4),
      unicode.utf16IndexAt(5),
      unicode.utf16IndexAt(6),
      unicode.utf16IndexAt(7)
    ]).toEqual([0, 1, 6, 6, 8, 9, 9, 10]);
    expect([
      unicode.visualColumnAt(0),
      unicode.visualColumnAt(1),
      unicode.visualColumnAt(2),
      unicode.visualColumnAt(5),
      unicode.visualColumnAt(6),
      unicode.visualColumnAt(7),
      unicode.visualColumnAt(8),
      unicode.visualColumnAt(9),
      unicode.visualColumnAt(10)
    ]).toEqual([0, 1, 1, 1, 3, 3, 4, 6, 7]);
  });

  it("composes formula-dense rows without changing detection order", () => {
    const physical = Array.from({ length: 32 }, (_, row) => ({
      row,
      text: Array.from({ length: 12 }, (_unused, index) =>
        `\\(x_${index}^2\\) term-${index}`
      ).join(" "),
      isWrapped: false
    }));

    const snapshot = detectScreenFormulaRegions(physical, 240);
    expect(snapshot.regions).toHaveLength(32);
    expect(snapshot.regions.every((region) => region.composite)).toBe(true);
    expect(snapshot.regions.map((region) => region.startRow)).toEqual(
      Array.from({ length: 32 }, (_, row) => row)
    );
    expect(snapshot.regions[0]).toMatchObject({
      startCol: 0,
      endCol: physical[0]!.text.length,
      confidence: "explicit"
    });
    expect(snapshot.regions[0]!.latex).toContain("x_0^2\\text{ term-0 }");
    expect(snapshot.regions[0]!.latex).toContain("x_11^2\\text{ term-11}");
  });

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

  it("renders a compact definition group whose prose soft-wraps", () => {
    const snapshot = detectScreenFormulaRegions([
      { row: 0, text: "- (E): a very long description", isWrapped: false },
      { row: 1, text: "continued here", isWrapped: true },
      { row: 2, text: "- (B): magnetic field", isWrapped: false }
    ], 30);
    expect(snapshot.deferred).toEqual([]);
    expect(snapshot.regions).toEqual([expect.objectContaining({
      startRow: 0,
      endRow: 2,
      startCol: 0,
      endCol: 30,
      compact: true,
      latex: expect.stringContaining("\\begin{array}{ll}"),
      displayRange: { startCol: 2, endCol: 30 },
      wrapSegments: [
        expect.objectContaining({ rowOffset: 0, startCol: 2 }),
        expect.objectContaining({ rowOffset: 1, startCol: 0 }),
        expect.objectContaining({ rowOffset: 2, startCol: 2 })
      ]
    })]);
  });

  it("renders an explicit formula wholly contained in a viewport-edge continuation", () => {
    const snapshot = detectScreenFormulaRegions([{
      row: 0,
      text: "continued prose \\(x^2\\) tail",
      isWrapped: true
    }], 80);

    expect(snapshot.regions).toEqual([expect.objectContaining({
      latex: "x^2\\text{ tail}",
      confidence: "explicit"
    })]);
  });

  it("uses xterm cell maps instead of string-width for terminal anchors", () => {
    // U+1FA77 is two columns in string-width 8 but one in xterm's active
    // Unicode grapheme provider. The delimiter therefore starts at column 2.
    const text = "🩷 \\(x\\)";
    const snapshot = detectScreenFormulaRegions([{
      row: 0,
      text,
      isWrapped: false,
      cellColumns: 7,
      columnMap: [0, 1, 1, 2, 3, 4, 5, 6, 7]
    }], 80);

    expect(snapshot.regions[0]).toMatchObject({ startCol: 2, endCol: 7 });
  });

  it("leaves fragile graphemes and mixed terminal styles outside composites", () => {
    for (const physical of [
      [{ row: 0, text: "\\(x\\)👨‍👩‍👧‍👦\\(y\\)", isWrapped: false }],
      [{
        row: 0,
        text: "\\(x\\) colored \\(y\\)",
        isWrapped: false,
        uniformStyle: false
      }]
    ]) {
      const snapshot = detectScreenFormulaRegions(physical, 80);
      expect(snapshot.regions.map((region) => region.latex)).toEqual(["x", "y"]);
      expect(snapshot.regions.every((region) => !region.composite)).toBe(true);
    }
  });
});
