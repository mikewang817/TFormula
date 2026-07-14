import stringWidth from "string-width";
import { containsFormulaTrigger, detectFormulaRegions, escapeTexText } from "./detect.js";
import type { FormulaRegion, FormulaWrapSegment } from "./types.js";

export interface PhysicalScreenLine {
  /** Row relative to the current viewport. */
  row: number;
  text: string;
  /** xterm marks a physical row that continues the previous row. */
  isWrapped: boolean;
  /**
   * Optional UTF-16-boundary to terminal-column map built from xterm cells.
   * Detection itself works on strings, but xterm's grapheme width rules are
   * deliberately not identical to `string-width` for every Unicode script.
   */
  columnMap?: number[];
  /** Occupied terminal columns represented by `text`. */
  cellColumns?: number;
  /** A stable style key when every visible cell has the same rendition. */
  styleKey?: string;
  /** False when visible cells use more than one rendition. */
  uniformStyle?: boolean;
}

interface LogicalSpan {
  row: number;
  logicalStart: number;
  logicalEnd: number;
  textStart: number;
  textEnd: number;
  text: string;
  columnMap?: number[];
  visualIndex?: VisualColumnIndex;
}

interface LogicalLine {
  text: string;
  spans: LogicalSpan[];
  truncatedStart: boolean;
  truncatedEnd: boolean;
  uniformStyle: boolean;
  styleKey?: string;
  visualIndex?: VisualColumnIndex;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const UNIT_WIDTH_ASCII_RE = /^[\x20-\x7e]*$/u;

/**
 * Bidirectional index between JavaScript string offsets and terminal columns.
 * Formula detection asks for both directions several times per region. ASCII
 * text needs no tables at all; Unicode text is segmented once and thereafter
 * both lookups are constant-time.
 */
class VisualColumnIndex {
  readonly width: number;
  readonly #utf16Length: number;
  readonly #unitWidthAscii: boolean;
  readonly #utf16ToVisual?: Uint32Array;
  readonly #visualToUtf16?: Uint32Array;

  constructor(value: string) {
    this.#utf16Length = value.length;
    this.#unitWidthAscii = UNIT_WIDTH_ASCII_RE.test(value);
    if (this.#unitWidthAscii) {
      this.width = value.length;
      return;
    }

    const utf16ToVisual = new Uint32Array(value.length + 1);
    const visualToUtf16: number[] = [0];
    let width = 0;
    for (const part of graphemeSegmenter.segment(value)) {
      const start = part.index;
      const end = start + part.segment.length;
      const nextWidth = width + stringWidth(part.segment);
      // An offset inside a grapheme maps to its leading column. The offset at
      // its end maps after the complete grapheme, matching the old scanner.
      utf16ToVisual.fill(width, start, end);
      utf16ToVisual[end] = nextWidth;
      // An interior visual column consumes the whole grapheme so callers can
      // never split a wide glyph, emoji ZWJ sequence, or combining cluster.
      for (let column = width + 1; column <= nextWidth; column += 1) {
        visualToUtf16[column] = end;
      }
      width = nextWidth;
    }
    this.width = width;
    this.#utf16ToVisual = utf16ToVisual;
    this.#visualToUtf16 = Uint32Array.from(visualToUtf16);
  }

  utf16IndexAt(column: number): number {
    if (column <= 0) return 0;
    if (!Number.isFinite(column)) return this.#utf16Length;
    if (this.#unitWidthAscii) {
      return Math.min(this.#utf16Length, Math.ceil(column));
    }
    const integralColumn = Math.ceil(column);
    if (integralColumn >= this.#visualToUtf16!.length) return this.#utf16Length;
    return this.#visualToUtf16![integralColumn]!;
  }

  visualColumnAt(utf16Index: number): number {
    if (utf16Index <= 0) return 0;
    if (!Number.isFinite(utf16Index)) return this.width;
    const integralIndex = Math.floor(utf16Index);
    if (integralIndex >= this.#utf16Length) return this.width;
    if (this.#unitWidthAscii) return integralIndex;
    return this.#utf16ToVisual![integralIndex]!;
  }
}

function lineVisualIndex(line: LogicalLine): VisualColumnIndex {
  return line.visualIndex ??= new VisualColumnIndex(line.text);
}

function spanVisualIndex(span: LogicalSpan): VisualColumnIndex {
  return span.visualIndex ??= new VisualColumnIndex(span.text);
}

export interface FormulaSnapshot {
  regions: FormulaRegion[];
  /** Detected formulas that cannot be safely covered by one opaque rectangle. */
  deferred: Array<{ latex: string; startRow: number; endRow: number }>;
}

function collapseSoftWrappedLines(
  physicalLines: PhysicalScreenLine[],
  continuesAfterViewport: boolean
): LogicalLine[] {
  const logicalLines: LogicalLine[] = [];
  for (const physical of physicalLines) {
    let logical = physical.isWrapped ? logicalLines.at(-1) : undefined;
    if (!logical) {
      logical = {
        text: "",
        spans: [],
        truncatedStart: physical.isWrapped,
        truncatedEnd: false,
        uniformStyle: physical.uniformStyle !== false,
        styleKey: physical.styleKey
      };
      logicalLines.push(logical);
    } else {
      logical.uniformStyle &&= physical.uniformStyle !== false;
      if (logical.styleKey !== undefined
        && physical.styleKey !== undefined
        && logical.styleKey !== physical.styleKey) {
        logical.uniformStyle = false;
      }
      logical.styleKey ??= physical.styleKey;
    }
    const logicalStart = logical.spans.at(-1)?.logicalEnd ?? 0;
    const textStart = logical.text.length;
    const visualIndex = physical.cellColumns === undefined
      ? new VisualColumnIndex(physical.text)
      : undefined;
    const physicalColumns = physical.cellColumns ?? visualIndex!.width;
    const isFirstSpan = logical.spans.length === 0;
    logical.text += physical.text;
    logical.spans.push({
      row: physical.row,
      logicalStart,
      logicalEnd: logicalStart + physicalColumns,
      textStart,
      textEnd: textStart + physical.text.length,
      text: physical.text,
      columnMap: physical.columnMap,
      visualIndex
    });
    // The overwhelmingly common unwrapped case can share one immutable index
    // between its logical line and sole physical span. Appending a soft-wrap
    // invalidates only the line-level view; each span keeps its own index.
    logical.visualIndex = isFirstSpan ? visualIndex : undefined;
  }
  if (continuesAfterViewport && logicalLines.length > 0) {
    logicalLines.at(-1)!.truncatedEnd = true;
  }
  return logicalLines;
}

function spanAtTextIndex(spans: LogicalSpan[], utf16Index: number): LogicalSpan {
  let low = 0;
  let high = spans.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (utf16Index < spans[middle]!.textEnd) high = middle;
    else low = middle + 1;
  }
  return spans[low]!;
}

function spanAtLogicalColumn(spans: LogicalSpan[], logicalColumn: number): LogicalSpan {
  let low = 0;
  let high = spans.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (logicalColumn < spans[middle]!.logicalEnd) high = middle;
    else low = middle + 1;
  }
  return spans[low]!;
}

function logicalColumnAtUtf16Index(line: LogicalLine, utf16Index: number): number {
  const span = spanAtTextIndex(line.spans, utf16Index);
  const localIndex = Math.max(0, Math.min(span.text.length, utf16Index - span.textStart));
  const mapped = span.columnMap?.[localIndex];
  return span.logicalStart + (mapped ?? spanVisualIndex(span).visualColumnAt(localIndex));
}

function mapStart(spans: LogicalSpan[], logicalColumn: number): { row: number; column: number } {
  const span = spanAtLogicalColumn(spans, logicalColumn);
  return {
    row: span.row,
    column: Math.max(0, logicalColumn - span.logicalStart)
  };
}

function mapEnd(spans: LogicalSpan[], logicalColumn: number): { row: number; column: number } {
  const lastCoveredColumn = Math.max(0, logicalColumn - 1);
  const span = spanAtLogicalColumn(spans, lastCoveredColumn);
  return {
    row: span.row,
    column: Math.max(1, logicalColumn - span.logicalStart)
  };
}

function wrappedFormulaSegments(
  line: LogicalLine,
  startColumn: number,
  endColumn: number,
  firstPhysicalRow: number
): FormulaWrapSegment[] {
  const segments: FormulaWrapSegment[] = [];
  for (const span of line.spans) {
    const logicalStart = Math.max(startColumn, span.logicalStart);
    const logicalEnd = Math.min(endColumn, span.logicalEnd);
    if (logicalEnd <= logicalStart) continue;
    segments.push({
      rowOffset: span.row - firstPhysicalRow,
      startCol: logicalStart - span.logicalStart,
      endCol: logicalEnd - span.logicalStart,
      logicalStartCol: logicalStart - startColumn
    });
  }
  return segments;
}

function multilineFormulaSegments(
  lines: LogicalLine[],
  startRow: number,
  endRow: number,
  startColumn: number,
  endColumn: number,
  firstPhysicalRow: number
): FormulaWrapSegment[] {
  const segments: FormulaWrapSegment[] = [];
  let sourceOffset = 0;
  for (let row = startRow; row <= endRow; row += 1) {
    const line = lines[row]!;
    const sliceStart = row === startRow ? startColumn : 0;
    const sliceEnd = row === endRow
      ? endColumn
      : line.spans.at(-1)?.logicalEnd ?? stringWidth(line.text);
    for (const span of line.spans) {
      const logicalStart = Math.max(sliceStart, span.logicalStart);
      const logicalEnd = Math.min(sliceEnd, span.logicalEnd);
      if (logicalEnd <= logicalStart) continue;
      segments.push({
        rowOffset: span.row - firstPhysicalRow,
        startCol: logicalStart - span.logicalStart,
        endCol: logicalEnd - span.logicalStart,
        logicalStartCol: sourceOffset + logicalStart - sliceStart
      });
    }
    sourceOffset += Math.max(0, sliceEnd - sliceStart);
  }
  return segments;
}

function compactFormulaSegments(
  lines: LogicalLine[],
  startRow: number,
  endRow: number,
  startColumn: number,
  firstPhysicalRow: number
): FormulaWrapSegment[] {
  const segments: FormulaWrapSegment[] = [];
  let sourceOffset = 0;
  for (let row = startRow; row <= endRow; row += 1) {
    const line = lines[row]!;
    const lineEnd = line.spans.at(-1)?.logicalEnd ?? stringWidth(line.text);
    for (const span of line.spans) {
      const logicalStart = Math.max(startColumn, span.logicalStart);
      const logicalEnd = Math.min(lineEnd, span.logicalEnd);
      if (logicalEnd <= logicalStart) continue;
      segments.push({
        rowOffset: span.row - firstPhysicalRow,
        startCol: logicalStart - span.logicalStart,
        endCol: logicalEnd - span.logicalStart,
        logicalStartCol: sourceOffset + logicalStart - startColumn
      });
    }
    sourceOffset += Math.max(0, lineEnd - startColumn);
  }
  return segments;
}

function utf16IndexAtVisualColumn(line: string, column: number): number {
  return new VisualColumnIndex(line).utf16IndexAt(column);
}

function containsFragileLiteralGrapheme(value: string): boolean {
  return /[\u200d\ufe0e\ufe0f\p{Emoji_Modifier}\p{Regional_Indicator}\p{Mark}]/u.test(value);
}

/**
 * Compose the tail of a logical line as layout tokens, without interpreting
 * the surrounding language. This moves TeX-source padding to the line end
 * while formula detection itself remains strictly formula-only.
 */
function composeInlineFormulaTails(
  lines: LogicalLine[],
  regions: FormulaRegion[]
): FormulaRegion[] {
  const replacements = new Map<FormulaRegion, FormulaRegion>();
  const removed = new Set<FormulaRegion>();
  const inlineByRow: Array<FormulaRegion[] | undefined> = new Array(lines.length);
  const displayCoverageDelta = new Int32Array(lines.length + 1);
  const detectionOrder = new Map<FormulaRegion, number>();

  for (let index = 0; index < regions.length; index += 1) {
    const region = regions[index]!;
    if (!detectionOrder.has(region)) detectionOrder.set(region, index);
    if (region.display) {
      const startRow = Math.max(0, region.startRow);
      const endRow = Math.min(lines.length - 1, region.endRow);
      if (startRow <= endRow) {
        displayCoverageDelta[startRow]! += 1;
        displayCoverageDelta[endRow + 1]! -= 1;
      }
    } else if (region.startRow === region.endRow
      && region.startRow >= 0
      && region.startRow < lines.length) {
      (inlineByRow[region.startRow] ??= []).push(region);
    }
  }
  for (const candidates of inlineByRow) {
    if (candidates && candidates.length > 1) {
      candidates.sort((left, right) => left.startCol - right.startCol);
    }
  }

  let displayCoverage = 0;
  for (let row = 0; row < lines.length; row += 1) {
    displayCoverage += displayCoverageDelta[row]!;
    if (displayCoverage > 0) continue;
    const line = lines[row]!.text;
    const candidates = inlineByRow[row];
    if (!candidates || candidates.length === 0) continue;
    const visualIndex = lineVisualIndex(lines[row]!);
    const last = candidates.at(-1)!;
    const lastEnd = visualIndex.utf16IndexAt(last.endCol);
    if (candidates.length === 1 && !line.slice(lastEnd).trim()) continue;
    const firstStart = visualIndex.utf16IndexAt(candidates[0]!.startCol);
    // MathJax's \text{} intentionally performs text shaping of its own. It
    // cannot preserve terminal rendition runs or every emoji/combining
    // grapheme, so leave those literal cells to the terminal and overlay only
    // the formulas instead of corrupting the surrounding text.
    if (!lines[row]!.uniformStyle
      || containsFragileLiteralGrapheme(line.slice(firstStart))) continue;

    const latex: string[] = [];
    let cursor = firstStart;
    for (const candidate of candidates) {
      const start = visualIndex.utf16IndexAt(candidate.startCol);
      const end = visualIndex.utf16IndexAt(candidate.endCol);
      if (start > cursor) latex.push(`\\text{${escapeTexText(line.slice(cursor, start))}}`);
      latex.push(candidate.latex);
      cursor = Math.max(cursor, end);
    }
    if (cursor < line.length) latex.push(`\\text{${escapeTexText(line.slice(cursor))}}`);

    const replacement: FormulaRegion = {
      startRow: row,
      endRow: row,
      startCol: candidates[0]!.startCol,
      endCol: visualIndex.width,
      latex: latex.join(""),
      display: false,
      confidence: candidates.some((candidate) => candidate.confidence === "explicit")
        ? "explicit"
        : "inferred",
      composite: true
    };
    const firstInDetectionOrder = candidates.reduce((first, candidate) =>
      detectionOrder.get(candidate)! < detectionOrder.get(first)! ? candidate : first
    );
    replacements.set(firstInDetectionOrder, replacement);
    for (const candidate of candidates) {
      if (candidate !== firstInDetectionOrder) removed.add(candidate);
    }
  }

  const composed: FormulaRegion[] = [];
  for (const region of regions) {
    const replacement = replacements.get(region);
    if (replacement) composed.push(replacement);
    else if (!removed.has(region)) composed.push(region);
  }
  return composed;
}

/**
 * Detect on logical terminal lines, then map the result back to physical rows.
 * This is essential during font zoom: xterm reflows a long `\[...\]` line
 * into multiple `isWrapped` rows, but it remains one logical formula.
 */
export function detectScreenFormulaRegions(
  physicalLines: PhysicalScreenLine[],
  terminalColumns: number,
  continuesAfterViewport = false
): FormulaSnapshot {
  if (!physicalLines.some((line) => containsFormulaTrigger(line.text))) {
    return { regions: [], deferred: [] };
  }
  const logicalLines = collapseSoftWrappedLines(physicalLines, continuesAfterViewport);
  const detected = composeInlineFormulaTails(
    logicalLines,
    detectFormulaRegions(logicalLines.map((line) => line.text))
  );
  const regions: FormulaRegion[] = [];
  const deferred: FormulaSnapshot["deferred"] = [];

  for (const detectedRegion of detected) {
    let region = detectedRegion;
    const startLine = logicalLines[region.startRow];
    const endLine = logicalLines[region.endRow];
    if (!startLine || !endLine) continue;
    const involved = logicalLines.slice(region.startRow, region.endRow + 1);
    // A complete explicit delimiter pair inside the visible fragment is safe
    // even when the logical line itself began or ends outside the viewport.
    // Inferred math has no such boundary proof and remains conservative.
    if (region.confidence !== "explicit"
      && involved.some((line) => line.truncatedStart || line.truncatedEnd)) continue;

    const startIndex = lineVisualIndex(startLine).utf16IndexAt(region.startCol);
    const mappedStartCol = logicalColumnAtUtf16Index(startLine, startIndex);
    let mappedEndCol: number;
    if (region.startRow === region.endRow || !region.compact) {
      mappedEndCol = logicalColumnAtUtf16Index(
        endLine,
        lineVisualIndex(endLine).utf16IndexAt(region.endCol)
      );
    } else {
      mappedEndCol = 1;
      for (const line of involved) {
        const visualIndex = lineVisualIndex(line);
        const visualEnd = Math.min(region.endCol, visualIndex.width);
        mappedEndCol = Math.max(
          mappedEndCol,
          logicalColumnAtUtf16Index(line, visualIndex.utf16IndexAt(visualEnd))
        );
      }
    }
    region = { ...region, startCol: mappedStartCol, endCol: mappedEndCol };

    const hasSoftWrap = involved.some((line) => line.spans.length > 1);
    const borrowsTrailingBlank = Boolean(region.compact
      && region.endRow === region.startRow + 1
      && !endLine.text.trim());
    const start = mapStart(startLine.spans, region.startCol);
    const end = mapEnd(
      borrowsTrailingBlank ? startLine.spans : endLine.spans,
      region.endCol
    );
    const formulaCrossesPhysicalRows = start.row !== end.row;
    const standaloneDisplay = region.display
      && involved.some((line) => /^(?:\\\[[\s\S]+\\\]|\$\$[^$]+\$\$)$/u.test(line.text.trim()))
      && involved.every((line) => !line.text.trim()
        || /^(?:\\\[[\s\S]+\\\]|\$\$[^$]+\$\$)$/u.test(line.text.trim()));
    const standaloneBlock = region.display
      && region.startRow < region.endRow
      && /^(?:\\\[|\$\$|\[)$/u.test(startLine.text.trim())
      && /^(?:\\\]|\$\$|\])$/u.test(endLine.text.trim());

    if (standaloneDisplay) {
      regions.push({
        ...region,
        startRow: involved[0]!.spans[0]!.row,
        endRow: involved.at(-1)!.spans.at(-1)!.row,
        startCol: 0,
        endCol: terminalColumns
      });
      continue;
    }

    if (region.display && !standaloneBlock) {
      const wrapSegments = multilineFormulaSegments(
        logicalLines,
        region.startRow,
        region.endRow,
        region.startCol,
        region.endCol,
        start.row
      );
      if (wrapSegments.length === 0) continue;
      const endLineWidth = endLine.spans.at(-1)?.logicalEnd ?? stringWidth(endLine.text);
      const hasSuffix = region.endCol < endLineWidth;
      const commonRangeEnd = hasSuffix ? end.column : terminalColumns;
      regions.push({
        ...region,
        startRow: start.row,
        endRow: end.row,
        startCol: 0,
        endCol: terminalColumns,
        wrapSegments,
        ...(commonRangeEnd > start.column
          ? { displayRange: { startCol: start.column, endCol: commonRangeEnd } }
          : { displayRange: undefined })
      });
      continue;
    }

    if (region.startRow < region.endRow
      && !standaloneDisplay
      && !standaloneBlock
      && !region.compact) {
      const wrapSegments = multilineFormulaSegments(
        logicalLines,
        region.startRow,
        region.endRow,
        region.startCol,
        region.endCol,
        start.row
      );
      if (wrapSegments.length < 2) continue;
      regions.push({
        ...region,
        startRow: start.row,
        endRow: end.row,
        startCol: 0,
        endCol: terminalColumns,
        wrapSegments
      });
      continue;
    }
    if (hasSoftWrap
      && formulaCrossesPhysicalRows
      && region.compact
      && !borrowsTrailingBlank) {
      // A compact definition array is intrinsically two-dimensional. Keep its
      // MathJax content whole, but paint backgrounds only over the physical
      // source slices so a wrapped continuation at column zero is not leaked
      // beside the array and unrelated terminal cells stay transparent.
      const wrapSegments = compactFormulaSegments(
        logicalLines,
        region.startRow,
        region.endRow,
        region.startCol,
        startLine.spans[0]!.row
      );
      if (wrapSegments.length < 2 || start.column >= terminalColumns) continue;
      regions.push({
        ...region,
        startRow: startLine.spans[0]!.row,
        endRow: endLine.spans.at(-1)!.row,
        startCol: 0,
        endCol: terminalColumns,
        displayRange: { startCol: start.column, endCol: terminalColumns },
        wrapSegments
      });
      continue;
    }

    if (hasSoftWrap
      && formulaCrossesPhysicalRows
      && (region.startRow === region.endRow || borrowsTrailingBlank)) {
      const wrapSegments = wrappedFormulaSegments(
        startLine,
        region.startCol,
        region.endCol,
        start.row
      );
      if (wrapSegments.length < 2) continue;
      regions.push({
        ...region,
        startRow: start.row,
        endRow: end.row,
        startCol: 0,
        endCol: terminalColumns,
        wrapSegments
      });
      continue;
    }

    if (hasSoftWrap && formulaCrossesPhysicalRows) {
      regions.push({
        ...region,
        startRow: startLine.spans[0]!.row,
        endRow: endLine.spans.at(-1)!.row,
        startCol: 0,
        endCol: terminalColumns
      });
      continue;
    }

    regions.push({
      ...region,
      startRow: start.row,
      endRow: borrowsTrailingBlank ? endLine.spans.at(-1)!.row : end.row,
      startCol: start.column,
      endCol: end.column
    });
  }

  return { regions, deferred };
}

export const screenTextInternals = {
  collapseSoftWrappedLines,
  compactFormulaSegments,
  composeInlineFormulaTails,
  createVisualColumnIndex: (value: string) => new VisualColumnIndex(value),
  mapEnd,
  mapStart,
  multilineFormulaSegments,
  utf16IndexAtVisualColumn,
  wrappedFormulaSegments
};
