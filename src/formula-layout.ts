import type {
  FormulaCanvasMode,
  FormulaPlacementPlan,
  FormulaWrapSegment,
  MappedFormula
} from "./types.js";

export interface FormulaLayoutLine {
  row: number;
  text: string;
  isWrapped: boolean;
}

export interface FormulaCanvasCandidateScore {
  rows: number;
  requiredRows: number;
  borrowedRows: number;
  centerShift: number;
  score: number;
}

/** Estimate vertical demand without invoking MathJax during screen mapping. */
export function estimateFormulaCanvasRows(latex: string): number {
  const rowEnvironment = /\\begin\{(?:aligned|alignedat|align|align\*|array|cases|gathered|gather|gather\*|matrix|[pbvB]matrix|Vmatrix|smallmatrix|split)\}/u
    .test(latex);
  if (rowEnvironment) {
    const breaks = latex.match(/\\\\(?:\[[^\]]*\])?/gu)?.length ?? 0;
    return Math.max(2, Math.min(6, breaks + 1));
  }
  if (/\\(?:dfrac|tfrac|frac|binom)\b/u.test(latex)) return 2;
  if (/\\(?:sum|prod|coprod|int|iint|iiint|oint)\b/u.test(latex)
    && /[_^]/u.test(latex)) return 2;
  return 1;
}

export function scoreFormulaCanvasCandidate(options: {
  rows: number;
  requiredRows: number;
  borrowedRows: number;
  centerShift: number;
}): FormulaCanvasCandidateScore {
  const rows = Math.max(1, Math.floor(options.rows));
  const requiredRows = Math.max(1, Math.floor(options.requiredRows));
  const borrowedRows = Math.max(0, Math.floor(options.borrowedRows));
  const centerShift = Math.max(0, options.centerShift);
  const readability = Math.min(1, rows / requiredRows);
  return {
    rows,
    requiredRows,
    borrowedRows,
    centerShift,
    score: readability * 100 - borrowedRows - centerShift * 4
  };
}

function relativeSegments(
  segments: FormulaWrapSegment[],
  canvasStartCol: number,
  rowShift = 0
): FormulaWrapSegment[] {
  return segments.map((segment) => ({
    ...segment,
    rowOffset: segment.rowOffset + rowShift,
    startCol: segment.startCol - canvasStartCol,
    endCol: segment.endCol - canvasStartCol
  }));
}

/** Convert mapped source cells into final visual placement plans. */
export function planFormulaPlacements(
  formulas: MappedFormula[],
  physicalLines: FormulaLayoutLine[],
  terminalColumns: number
): FormulaPlacementPlan[] {
  const linesByRow = new Map(physicalLines.map((line) => [line.row, line]));
  const occupiedRows = new Set<number>();
  for (const mapped of formulas) {
    for (let row = mapped.source.startRow; row <= mapped.source.endRow; row += 1) {
      occupiedRows.add(row);
    }
  }
  const borrowerRows = new Set(formulas
    .filter((mapped) => mapped.source.startRow === mapped.source.endRow
      && (mapped.formula.intent === "display"
        || (mapped.formula.intent === "inline" && mapped.formula.compact)))
    .map((mapped) => mapped.source.startRow));
  const exclusivelyAdjacent = (blankRow: number, formulaRow: number): boolean => {
    const neighbors = [blankRow - 1, blankRow + 1].filter((row) => borrowerRows.has(row));
    return neighbors.length === 1 && neighbors[0] === formulaRow;
  };
  const canBorrow = (row: number, formulaRow: number): boolean => {
    const line = linesByRow.get(row);
    return Boolean(line
      && !line.isWrapped
      && !line.text.trim()
      && !occupiedRows.has(row)
      && exclusivelyAdjacent(row, formulaRow));
  };

  return formulas.map((mapped) => {
    const canvasStartCol = mapped.fullWidth ? 0 : mapped.source.startCol;
    const canvasEndCol = mapped.fullWidth ? terminalColumns : mapped.source.endCol;
    const standaloneDisplay = mapped.formula.intent === "display"
      && mapped.source.startRow === mapped.source.endRow;
    const trailingInline = mapped.formula.intent === "inline"
      && Boolean(mapped.formula.compact)
      && mapped.source.startRow === mapped.source.endRow;
    const canBorrowPrevious = standaloneDisplay
      && canBorrow(mapped.source.startRow - 1, mapped.source.startRow);
    const canBorrowNext = (standaloneDisplay || trailingInline)
      && canBorrow(mapped.source.endRow + 1, mapped.source.endRow);
    const requiredRows = estimateFormulaCanvasRows(mapped.formula.latex);
    const sourceCenter = (mapped.source.startRow + mapped.source.endRow) / 2;
    const candidates: Array<{
      borrowPrevious: boolean;
      borrowNext: boolean;
      mode: FormulaCanvasMode;
      quality: FormulaCanvasCandidateScore;
    }> = [];
    for (const [borrowPrevious, borrowNext, mode] of [
      [false, false, "source"],
      ...(canBorrowPrevious ? [[true, false, "borrowed-above"]] : []),
      ...(canBorrowNext ? [[false, true, "borrowed-below"]] : []),
      ...(canBorrowPrevious && canBorrowNext ? [[true, true, "borrowed-both"]] : [])
    ] as Array<[boolean, boolean, FormulaCanvasMode]>) {
      const startRow = mapped.source.startRow - (borrowPrevious ? 1 : 0);
      const endRow = mapped.source.endRow + (borrowNext ? 1 : 0);
      candidates.push({
        borrowPrevious,
        borrowNext,
        mode,
        quality: scoreFormulaCanvasCandidate({
          rows: endRow - startRow + 1,
          requiredRows,
          borrowedRows: Number(borrowPrevious) + Number(borrowNext),
          centerShift: Math.abs((startRow + endRow) / 2 - sourceCenter)
        })
      });
    }
    const selected = candidates.reduce((best, candidate) =>
      candidate.quality.score > best.quality.score ? candidate : best
    );
    const rowShift = selected.borrowPrevious ? 1 : 0;
    const formulaSlices = relativeSegments(mapped.formulaSlices, canvasStartCol, rowShift);
    let mode = selected.mode;
    if (mode === "source") {
      if (mapped.displayRange) mode = "embedded";
      else if (formulaSlices.length > 0) mode = "wrapped";
      else if (mapped.formula.compact) mode = "compact";
    }
    return {
      formula: mapped.formula,
      canvas: {
        startRow: mapped.source.startRow - rowShift,
        endRow: mapped.source.endRow + (selected.borrowNext ? 1 : 0),
        startCol: canvasStartCol,
        endCol: canvasEndCol
      },
      sourceMasks: relativeSegments(mapped.sourceSegments, canvasStartCol, rowShift),
      formulaSlices,
      ...(mapped.displayRange ? {
        displayRange: {
          startCol: mapped.displayRange.startCol - canvasStartCol,
          endCol: mapped.displayRange.endCol - canvasStartCol
        }
      } : {}),
      mode,
      estimatedQuality: selected.quality.score,
      composite: mapped.composite
    };
  });
}
