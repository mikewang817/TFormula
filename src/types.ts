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
  /** Physical row offset from the owning source/canvas start row. */
  rowOffset: number;
  /** Destination columns occupied by source TeX on this physical row. */
  startCol: number;
  endCol: number;
  /** Column offset of this slice in the reassembled source span. */
  logicalStartCol: number;
}

export type FormulaIntent = "inline" | "display" | "embedded-display";

export interface FormulaSourceRange {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

/** Semantic detector output, independent of terminal image placement. */
export interface DetectedFormula {
  source: FormulaSourceRange;
  latex: string;
  intent: FormulaIntent;
  confidence: "explicit" | "inferred";
  /** Transitional semantic hint for definition arrays and trailing formula groups. */
  compact?: boolean;
}

export interface CellRectangle {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

export type FormulaCanvasMode =
  | "source"
  | "borrowed-above"
  | "borrowed-below"
  | "borrowed-both"
  | "embedded"
  | "wrapped"
  | "compact";

/** Semantic formula mapped onto its exact physical terminal source cells. */
export interface MappedFormula {
  formula: DetectedFormula;
  /** Bounding rectangle for physical source cells, before any blank-row borrowing. */
  source: CellRectangle;
  /** Source-cell masks relative to source.startRow; columns are terminal columns. */
  sourceSegments: FormulaWrapSegment[];
  /** Wrapped slices relative to source.startRow; columns are terminal columns. */
  formulaSlices: FormulaWrapSegment[];
  /** Safe terminal-column interval for an embedded display. */
  displayRange?: { startCol: number; endCol: number };
  /** Request a terminal-width source canvas before blank-row planning. */
  fullWidth: boolean;
  composite: boolean;
}

/** Physical terminal layout selected independently from semantic detection. */
export interface FormulaPlacementPlan {
  formula: DetectedFormula;
  canvas: CellRectangle;
  /** Physical cells whose original TeX must be hidden. */
  sourceMasks: FormulaWrapSegment[];
  /** Source slices through which one logical formula image is painted. */
  formulaSlices: FormulaWrapSegment[];
  /** Safe horizontal interval for an embedded display. */
  displayRange?: { startCol: number; endCol: number };
  mode: FormulaCanvasMode;
  estimatedQuality: number;
  composite: boolean;
}

export interface RecentFormulaEntry {
  id: number;
  formula: DetectedFormula;
  plan: FormulaPlacementPlan;
  fitScale?: number;
  degradationReason?: string;
  observedAt: number;
}

export interface RenderedFormula {
  png: Uint8Array;
  /** Content-addressed key for this exact terminal-ready PNG variant. */
  cacheKey: string;
  columns: number;
  rows: number;
  widthPx: number;
  heightPx: number;
  /** Natural-size Kitty placement inside the first reserved terminal cell. */
  pixelPlacement?: { offsetX: number; offsetY: number };
  /** Fraction of the requested natural formula size retained after fitting. */
  fitScale: number;
  /** MathJax source geometry, cached lazily by the document reader. */
  naturalAspectRatio: number;
  naturalHeightEx: number;
}

export interface FormulaRenderedEvent {
  latex: string;
  display: boolean;
  confidence: DetectedFormula["confidence"];
}

export interface CliOptions {
  mode: "proxy";
  command: string;
  args: string[];
  cwd: string;
  renderMath: boolean;
  recordHistory: boolean;
  debug: boolean;
  scale: number;
  /** Keep raw TeX when fitting would reduce a formula below this ratio. */
  minReadableScale: number;
  /** Quiet period required by background scans before placing new formulas. */
  stabilityMs: number;
  /** One control character which toggles the non-destructive formula focus overlay. */
  focusKey: string;
  cellOverride?: { width: number; height: number };
}

export interface HistoryCliOptions {
  mode: "history";
  limit: number;
  json: boolean;
  clear: boolean;
  debug: boolean;
}

export type FormulaExportFormat =
  | "latex"
  | "latex-inline"
  | "latex-display"
  | "markdown"
  | "mathml"
  | "html"
  | "svg"
  | "png"
  | "tiff";

export interface FormulaExportOptions {
  format: FormulaExportFormat;
  /** Output scale relative to MathJax's natural 8 px/ex size. */
  scale?: number;
  /** CSS color used by vector and raster output. */
  color?: string;
  /** Optional CSS canvas color. Omit or use transparent for an alpha canvas. */
  background?: string;
  /** Canvas padding in output pixels, applied after scale. */
  padding?: number;
}

export interface ExportCliOptions extends FormulaExportOptions {
  mode: "export";
  selector: string;
  output?: string;
  cwd: string;
  debug: boolean;
}

export interface CopyCliOptions extends FormulaExportOptions {
  mode: "copy";
  selector: string;
  debug: boolean;
}

export interface ReaderCliOptions {
  mode: "reader";
  path: string;
  cwd: string;
  debug: boolean;
  scale: number;
  cellOverride?: { width: number; height: number };
}

export type TFormulaOptions =
  | CliOptions
  | ReaderCliOptions
  | HistoryCliOptions
  | ExportCliOptions
  | CopyCliOptions;
