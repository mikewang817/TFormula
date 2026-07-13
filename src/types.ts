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
}

export interface RenderedFormula {
  png: Uint8Array;
  columns: number;
  rows: number;
  widthPx: number;
  heightPx: number;
}

export interface CliOptions {
  command: string;
  args: string[];
  cwd: string;
  renderMath: boolean;
  debug: boolean;
  scale: number;
  cellOverride?: { width: number; height: number };
}
