import type { CellMetrics } from "./types.js";

export interface FormulaGeometryInput {
  aspectRatio: number;
  naturalHeightEx: number;
  depthEx: number;
  columns: number;
  rows: number;
  cell: CellMetrics;
  scale: number;
  display: boolean;
  leftAlign?: boolean;
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
  const depthRatio = Math.max(0, Math.min(1, input.depthEx / input.naturalHeightEx));
  const scaledDepth = formulaHeight * depthRatio;
  // Terminal protocols expose cell dimensions, but not font ascent. A baseline
  // near 78% of the cell height matches the usual terminal font metrics. Honor
  // MathJax's depth below that baseline so rho, J, and subscripted symbols line
  // up with neighboring terminal text instead of centering unlike bounding boxes.
  const inlineBaseline = input.cell.height * 0.78;
  const baselineOffsetY = Math.round(inlineBaseline - (formulaHeight - scaledDepth));
  const maxOffsetY = Math.max(0, canvasHeight - formulaHeight);

  return {
    canvasWidth,
    canvasHeight,
    formulaWidth,
    formulaHeight,
    offsetX: input.leftAlign
      ? Math.round(horizontalPadding)
      : Math.round((canvasWidth - formulaWidth) / 2),
    offsetY: input.display
      ? Math.round((canvasHeight - formulaHeight) / 2)
      : Math.max(0, Math.min(maxOffsetY, baselineOffsetY))
  };
}
