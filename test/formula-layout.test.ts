import { describe, expect, it } from "vitest";
import {
  estimateFormulaCanvasRows,
  planFormulaPlacements,
  scoreFormulaCanvasCandidate
} from "../src/formula-layout.js";
import type { MappedFormula } from "../src/types.js";

function mappedFormula(overrides: Partial<MappedFormula> = {}): MappedFormula {
  const formula = overrides.formula ?? {
    source: { startRow: 1, endRow: 1, startCol: 0, endCol: 15 },
    latex: "\\frac{a}{b}",
    intent: "display" as const,
    confidence: "explicit" as const
  };
  return {
    formula,
    source: overrides.source ?? { startRow: 1, endRow: 1, startCol: 0, endCol: 15 },
    sourceSegments: overrides.sourceSegments ?? [
      { rowOffset: 0, startCol: 0, endCol: 15, logicalStartCol: 0 }
    ],
    formulaSlices: overrides.formulaSlices ?? [],
    fullWidth: overrides.fullWidth ?? true,
    composite: overrides.composite ?? false,
    ...(overrides.displayRange ? { displayRange: overrides.displayRange } : {})
  };
}

const blankDisplayLines = [
  { row: 0, text: "", isWrapped: false },
  { row: 1, text: "$$\\frac{a}{b}$$", isWrapped: false },
  { row: 2, text: "", isWrapped: false }
];

describe("FormulaPlacementPlan", () => {
  it("plans directly from mapped source cells without a mixed region", () => {
    const mapped = mappedFormula();
    const [plan] = planFormulaPlacements([mapped], blankDisplayLines, 80);

    expect(plan).toMatchObject({
      formula: mapped.formula,
      canvas: { startRow: 0, endRow: 2, startCol: 0, endCol: 80 },
      sourceMasks: [
        { rowOffset: 1, startCol: 0, endCol: 15, logicalStartCol: 0 }
      ],
      formulaSlices: [],
      mode: "borrowed-both",
      estimatedQuality: 98
    });
  });

  it("borrows only the safe upper blank row and shifts the source mask", () => {
    const mapped = mappedFormula();
    const [plan] = planFormulaPlacements([mapped], [
      { row: 0, text: "", isWrapped: false },
      { row: 1, text: "$$\\frac{a}{b}$$", isWrapped: false },
      { row: 2, text: "following text", isWrapped: false }
    ], 80);

    expect(plan).toMatchObject({
      canvas: { startRow: 0, endRow: 1, startCol: 0, endCol: 80 },
      mode: "borrowed-above",
      sourceMasks: [
        { rowOffset: 1, startCol: 0, endCol: 15, logicalStartCol: 0 }
      ]
    });
  });

  it("borrows only the safe lower blank row without covering later text", () => {
    const mapped = mappedFormula();
    const [plan] = planFormulaPlacements([mapped], [
      { row: 0, text: "preceding text", isWrapped: false },
      { row: 1, text: "$$\\frac{a}{b}$$", isWrapped: false },
      { row: 2, text: "", isWrapped: false },
      { row: 3, text: "later text", isWrapped: false }
    ], 80);

    expect(plan).toMatchObject({
      canvas: { startRow: 1, endRow: 2, startCol: 0, endCol: 80 },
      mode: "borrowed-below",
      sourceMasks: [
        { rowOffset: 0, startCol: 0, endCol: 15, logicalStartCol: 0 }
      ]
    });
    expect(plan!.canvas.endRow).toBeLessThan(3);
  });

  it("scores canvas candidates without screen state", () => {
    expect(estimateFormulaCanvasRows("\\frac{a}{b}")).toBe(2);
    expect(scoreFormulaCanvasCandidate({
      rows: 3,
      requiredRows: 2,
      borrowedRows: 2,
      centerShift: 0
    }).score).toBe(98);
  });

  it("keeps semantic source independent from a borrowed visual canvas", () => {
    const mapped = mappedFormula();
    const [plan] = planFormulaPlacements([mapped], blankDisplayLines, 80);

    expect(plan!.formula).toBe(mapped.formula);
    expect(plan!.formula.source).toEqual({
      startRow: 1,
      endRow: 1,
      startCol: 0,
      endCol: 15
    });
    expect(plan!.canvas).toEqual({
      startRow: 0,
      endRow: 2,
      startCol: 0,
      endCol: 80
    });
  });

  it("uses embedded-display spans as masks without slicing the formula", () => {
    const segments = [
      { rowOffset: 0, startCol: 7, endCol: 20, logicalStartCol: 0 },
      { rowOffset: 1, startCol: 0, endCol: 10, logicalStartCol: 13 }
    ];
    const mapped = mappedFormula({
      formula: {
        source: { startRow: 0, endRow: 1, startCol: 7, endCol: 10 },
        latex: "E=mc^2",
        intent: "embedded-display",
        confidence: "explicit"
      },
      source: { startRow: 0, endRow: 1, startCol: 0, endCol: 20 },
      sourceSegments: segments,
      formulaSlices: [],
      displayRange: { startCol: 7, endCol: 40 }
    });
    const [plan] = planFormulaPlacements([mapped], [
      { row: 0, text: "before \\[E=", isWrapped: false },
      { row: 1, text: "mc^2\\]", isWrapped: true }
    ], 40);

    expect(plan!.mode).toBe("embedded");
    expect(plan!.sourceMasks).toEqual(segments);
    expect(plan!.formulaSlices).toEqual([]);
    expect(plan!.displayRange).toEqual({ startCol: 7, endCol: 40 });
  });

  it("keeps ordinary wrapped formulas as render slices", () => {
    const segments = [
      { rowOffset: 0, startCol: 20, endCol: 40, logicalStartCol: 0 },
      { rowOffset: 1, startCol: 0, endCol: 12, logicalStartCol: 20 }
    ];
    const mapped = mappedFormula({
      formula: {
        source: { startRow: 0, endRow: 0, startCol: 20, endCol: 52 },
        latex: "x_i^2",
        intent: "inline",
        confidence: "explicit"
      },
      source: { startRow: 0, endRow: 1, startCol: 0, endCol: 40 },
      sourceSegments: segments,
      formulaSlices: segments
    });
    const [plan] = planFormulaPlacements([mapped], [
      { row: 0, text: "prefix", isWrapped: false },
      { row: 1, text: "suffix", isWrapped: true }
    ], 40);

    expect(plan!.mode).toBe("wrapped");
    expect(plan!.sourceMasks).toEqual(segments);
    expect(plan!.formulaSlices).toEqual(segments);
  });
});
