export interface CellMetrics {
  width: number;
  height: number;
  source: "cell-query" | "window-query" | "override" | "fallback";
}

export interface TerminalCapabilities {
  kittyGraphics: boolean;
  foreground: string;
  background: string;
  cell: CellMetrics;
  windowPixels?: { width: number; height: number };
}

export interface FormulaWrapSegment {
  /** Physical row offset from FormulaRegion.startRow. */
  rowOffset: number;
  /** Destination columns occupied by source TeX on this physical row. */
  startCol: number;
  endCol: number;
  /** Column offset of this slice in the reassembled source span. */
  logicalStartCol: number;
}

export interface FormulaRegion {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
  latex: string;
  display: boolean;
  confidence: "explicit" | "inferred";
  /** Use the detected region width even when the formula spans several rows. */
  compact?: boolean;
  /** Safe terminal-column interval used to center an embedded display. */
  displayRange?: { startCol: number; endCol: number };
  /** The region combines literal terminal text and inline formula tokens. */
  composite?: boolean;
  /**
   * Slices of a soft- or hard-wrapped source span. The placed image still uses
   * a rectangular terminal canvas, but pixels outside these slices remain
   * transparent so prose before and after the formula is not covered.
   */
  wrapSegments?: FormulaWrapSegment[];
}

export interface RenderedFormula {
  png: Uint8Array;
  /** Content-addressed key for this exact terminal-ready PNG variant. */
  cacheKey: string;
  columns: number;
  rows: number;
  widthPx: number;
  heightPx: number;
  /** MathJax source geometry, cached lazily by the document reader. */
  naturalAspectRatio: number;
  naturalHeightEx: number;
}

export interface CliOptions {
  mode: "proxy";
  command: string;
  args: string[];
  cwd: string;
  renderMath: boolean;
  debug: boolean;
  scale: number;
  cellOverride?: { width: number; height: number };
}

export interface ReaderCliOptions {
  mode: "reader";
  path: string;
  cwd: string;
  debug: boolean;
  scale: number;
  cellOverride?: { width: number; height: number };
}

export type TFormulaOptions = CliOptions | ReaderCliOptions;
