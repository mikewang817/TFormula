import type { CellMetrics } from "./types.js";

export interface FormulaGeometryInput {
  aspectRatio: number;
  naturalHeightEx: number;
  columns: number;
  rows: number;
  cell: CellMetrics;
  scale: number;
  display: boolean;
}

export interface FormulaGeometry {
  canvasWidth: number;
  canvasHeight: number;
  formulaWidth: number;
  formulaHeight: number;
  offsetX: number;
  offsetY: number;
}

/**
 * MathJax dimensions are expressed in ex units. A terminal glyph's x-height is
 * approximately 45% of its cell height. This keeps ordinary symbols aligned
 * with terminal text while allowing fractions to use their natural extra height.
 */
export function calculateFormulaGeometry(input: FormulaGeometryInput): FormulaGeometry {
  const canvasWidth = Math.max(1, Math.round(input.columns * input.cell.width));
  const canvasHeight = Math.max(1, Math.round(input.rows * input.cell.height));
  const exPx = input.cell.height * 0.45 * input.scale;
  const naturalHeight = Math.max(1, input.naturalHeightEx * exPx);
  const naturalWidth = Math.max(1, naturalHeight * input.aspectRatio);
  const horizontalPadding = input.display ? input.cell.width : Math.min(2, input.cell.width * 0.15);
  const verticalPadding = Math.max(1, input.cell.height * 0.08);
  const availableWidth = Math.max(1, canvasWidth - horizontalPadding * 2);
  const availableHeight = Math.max(1, canvasHeight - verticalPadding * 2);

  // Never enlarge merely to fill the source rectangle; only shrink to fit.
  const fit = Math.min(1, availableWidth / naturalWidth, availableHeight / naturalHeight);
  const formulaWidth = Math.max(1, Math.round(naturalWidth * fit));
  const formulaHeight = Math.max(1, Math.round(naturalHeight * fit));

  return {
    canvasWidth,
    canvasHeight,
    formulaWidth,
    formulaHeight,
    offsetX: Math.round((canvasWidth - formulaWidth) / 2),
    offsetY: Math.round((canvasHeight - formulaHeight) / 2)
  };
}
