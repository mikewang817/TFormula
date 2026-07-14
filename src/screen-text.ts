import stringWidth from "string-width";
import { detectFormulaRegions, escapeTexText } from "./detect.js";
import type { FormulaRegion, FormulaWrapSegment } from "./types.js";

export interface PhysicalScreenLine {
  /** Row relative to the current viewport. */
  row: number;
  text: string;
  /** xterm marks a physical row that continues the previous row. */
  isWrapped: boolean;
}

interface LogicalSpan {
  row: number;
  logicalStart: number;
  logicalEnd: number;
}

interface LogicalLine {
  text: string;
  spans: LogicalSpan[];
  truncatedStart: boolean;
  truncatedEnd: boolean;
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
        truncatedEnd: false
      };
      logicalLines.push(logical);
    }
    const logicalStart = stringWidth(logical.text);
    logical.text += physical.text;
    logical.spans.push({
      row: physical.row,
      logicalStart,
      logicalEnd: logicalStart + stringWidth(physical.text)
    });
  }
  if (continuesAfterViewport && logicalLines.length > 0) {
    logicalLines.at(-1)!.truncatedEnd = true;
  }
  return logicalLines;
}

function mapStart(spans: LogicalSpan[], logicalColumn: number): { row: number; column: number } {
  const span = spans.find((candidate, index) =>
    logicalColumn < candidate.logicalEnd || index === spans.length - 1
  ) ?? spans[0]!;
  return {
    row: span.row,
    column: Math.max(0, logicalColumn - span.logicalStart)
  };
}

function mapEnd(spans: LogicalSpan[], logicalColumn: number): { row: number; column: number } {
  const lastCoveredColumn = Math.max(0, logicalColumn - 1);
  const span = spans.find((candidate, index) =>
    lastCoveredColumn < candidate.logicalEnd || index === spans.length - 1
  ) ?? spans.at(-1)!;
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
    const sliceEnd = row === endRow ? endColumn : stringWidth(line.text);
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

function utf16IndexAtVisualColumn(line: string, column: number): number {
  for (let index = 0; index <= line.length; index += 1) {
    if (stringWidth(line.slice(0, index)) >= column) return index;
  }
  return line.length;
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

  for (let row = 0; row < lines.length; row += 1) {
    if (regions.some((region) => region.display
      && region.startRow <= row
      && region.endRow >= row)) continue;
    const line = lines[row]!.text;
    const candidates = regions
      .filter((region) => region.startRow === row
        && region.endRow === row
        && !region.display)
      .sort((left, right) => left.startCol - right.startCol);
    if (candidates.length === 0) continue;
    const last = candidates.at(-1)!;
    const lastEnd = utf16IndexAtVisualColumn(line, last.endCol);
    if (candidates.length === 1 && !line.slice(lastEnd).trim()) continue;

    const latex: string[] = [];
    let cursor = utf16IndexAtVisualColumn(line, candidates[0]!.startCol);
    for (const candidate of candidates) {
      const start = utf16IndexAtVisualColumn(line, candidate.startCol);
      const end = utf16IndexAtVisualColumn(line, candidate.endCol);
      if (start > cursor) latex.push(`\\text{${escapeTexText(line.slice(cursor, start))}}`);
      latex.push(candidate.latex);
      cursor = Math.max(cursor, end);
    }
    if (cursor < line.length) latex.push(`\\text{${escapeTexText(line.slice(cursor))}}`);

    const replacement: FormulaRegion = {
      startRow: row,
      endRow: row,
      startCol: candidates[0]!.startCol,
      endCol: stringWidth(line),
      latex: latex.join(""),
      display: false,
      confidence: candidates.some((candidate) => candidate.confidence === "explicit")
        ? "explicit"
        : "inferred",
      composite: true
    };
    const firstInDetectionOrder = candidates.reduce((first, candidate) =>
      regions.indexOf(candidate) < regions.indexOf(first) ? candidate : first
    );
    replacements.set(firstInDetectionOrder, replacement);
    for (const candidate of candidates) {
      if (candidate !== firstInDetectionOrder) removed.add(candidate);
    }
  }

  return regions.flatMap((region) => {
    const replacement = replacements.get(region);
    if (replacement) return [replacement];
    return removed.has(region) ? [] : [region];
  });
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
  const logicalLines = collapseSoftWrappedLines(physicalLines, continuesAfterViewport);
  const detected = composeInlineFormulaTails(
    logicalLines,
    detectFormulaRegions(logicalLines.map((line) => line.text))
  );
  const regions: FormulaRegion[] = [];
  const deferred: FormulaSnapshot["deferred"] = [];

  for (const region of detected) {
    const startLine = logicalLines[region.startRow];
    const endLine = logicalLines[region.endRow];
    if (!startLine || !endLine) continue;
    const involved = logicalLines.slice(region.startRow, region.endRow + 1);
    if (involved.some((line) => line.truncatedStart || line.truncatedEnd)) continue;

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
      const endLineWidth = stringWidth(endLine.text);
      const hasSuffix = region.endCol < endLineWidth;
      regions.push({
        ...region,
        startRow: start.row,
        endRow: end.row,
        startCol: 0,
        endCol: terminalColumns,
        wrapSegments,
        displayRange: {
          startCol: start.column,
          endCol: Math.max(start.column + 1, hasSuffix ? end.column : terminalColumns)
        }
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
      // Compact definition arrays combine several logical rows, so there is no
      // one-dimensional source strip to slice. Keep their conservative
      // fallback until they can be mapped independently row by row.
      deferred.push({
        latex: region.latex,
        startRow: startLine.spans[0]!.row,
        endRow: endLine.spans.at(-1)!.row
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
  composeInlineFormulaTails,
  mapEnd,
  mapStart,
  multilineFormulaSegments,
  utf16IndexAtVisualColumn,
  wrappedFormulaSegments
};
