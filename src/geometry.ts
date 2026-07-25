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
  /** Fraction of MathJax's requested natural size retained after fitting. */
  fitScale: number;
  offsetX: number;
  offsetY: number;
}

export interface InlineFormulaColumnChoice {
  columns: number;
  ceilColumns: number;
  usedFloor: boolean;
  /** Additional horizontal fit retained after unavoidable one-row fitting. */
  quantizationFit: number;
}

export const MAX_INLINE_QUANTIZATION_SHRINK = 0.08;

function horizontalPadding(cell: CellMetrics, display: boolean): number {
  return display ? cell.width : Math.min(1, cell.width * 0.1);
}

function verticalPadding(cell: CellMetrics, display: boolean): number {
  return display ? 0 : Math.max(1, cell.height * 0.08);
}

/**
 * Choose between floor/ceil cell quantization for one-row inline math. A
 * formula may shrink by at most 8% beyond the vertical fit already required by
 * the terminal row; otherwise it retains the conservative ceil width.
 */
export function chooseInlineFormulaColumns(input: Pick<
  FormulaGeometryInput,
  "aspectRatio" | "naturalHeightEx" | "cell" | "scale"
>): InlineFormulaColumnChoice {
  const exPx = input.cell.height * 0.45 * input.scale;
  const naturalHeight = Math.max(1, input.naturalHeightEx * exPx);
  const naturalWidth = Math.max(1, naturalHeight * input.aspectRatio);
  const paddingX = horizontalPadding(input.cell, false);
  const paddingY = verticalPadding(input.cell, false);
  const availableHeight = Math.max(1, input.cell.height - paddingY * 2);
  const verticalFit = Math.min(1, availableHeight / naturalHeight);
  const verticallyFittedWidth = naturalWidth * verticalFit;
  const idealColumns = (verticallyFittedWidth + paddingX * 2) / input.cell.width;
  const ceilColumns = Math.max(1, Math.ceil(idealColumns));
  const floorColumns = Math.max(1, Math.floor(idealColumns));
  const floorAvailable = Math.max(1, floorColumns * input.cell.width - paddingX * 2);
  const quantizationFit = Math.min(1, floorAvailable / verticallyFittedWidth);
  const usedFloor = floorColumns < ceilColumns
    && quantizationFit >= 1 - MAX_INLINE_QUANTIZATION_SHRINK;
  return {
    columns: usedFloor ? floorColumns : ceilColumns,
    ceilColumns,
    usedFloor,
    quantizationFit: usedFloor ? quantizationFit : 1
  };
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
  const paddingX = horizontalPadding(input.cell, input.display);
  // A display region is whitespace reserved by the TUI, even when the source
  // only spanned a single row. Use its full height so tall fractions keep the
  // same glyph scale as simple equations. Inline formulas retain padding for
  // adjacent terminal text.
  const paddingY = verticalPadding(input.cell, input.display);
  const availableWidth = Math.max(1, canvasWidth - paddingX * 2);
  const availableHeight = Math.max(1, canvasHeight - paddingY * 2);

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
    fitScale: fit,
    offsetX: input.leftAlign
      ? Math.round(paddingX)
      : Math.round((canvasWidth - formulaWidth) / 2),
    offsetY: input.display
      ? Math.round((canvasHeight - formulaHeight) / 2)
      : Math.max(0, Math.min(maxOffsetY, baselineOffsetY))
  };
}
