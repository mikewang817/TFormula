import stringWidth from "string-width";
import type { FormulaRegion } from "./types.js";

const COMMAND_RE = /\\(?:frac|dfrac|tfrac|binom|sum|prod|coprod|int|iint|iiint|oint|log|ln|exp|sqrt|lim|liminf|limsup|sin|cos|tan|cot|sec|csc|arcsin|arccos|arctan|sinh|cosh|tanh|det|dim|gcd|hom|ker|max|min|sup|inf|Pr|mod|pmod|bmod|ce|pu|qty|dv|pdv|bra|ket|braket|begin|end|left|right|text|mathrm|mathbf|mathit|mathsf|mathtt|mathbb|mathcal|mathfrak|operatorname|overline|underline|widehat|widetilde|hat|bar|vec|dot|ddot|partial|nabla|ell|infty|forall|exists|neg|pm|mp|times|div|cdot|ast|star|circ|bullet|oplus|otimes|cap|cup|subset|supset|subseteq|supseteq|in|notin|ni|le|leq|ge|geq|neq|ne|approx|sim|simeq|cong|equiv|propto|to|mapsto|rightarrow|leftarrow|leftrightarrow|Rightarrow|Leftarrow|Leftrightarrow|alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|kappa|lambda|mu|nu|xi|omicron|pi|varpi|rho|varrho|sigma|varsigma|tau|upsilon|phi|varphi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega)(?![A-Za-z])/gu;

const MAX_DISPLAY_BLOCK_ROWS = 256;

function mathScore(value: string): number {
  let score = 0;
  score += (value.match(COMMAND_RE)?.length ?? 0) * 3;
  score += Math.min(3, value.match(/[\^_][{A-Za-z0-9(]/gu)?.length ?? 0);
  score += Math.min(2, value.match(/\\[A-Za-z]+/gu)?.length ?? 0);
  if (/\{[^{}]+\}/u.test(value)) score += 1;
  if (/[=≈≠≤≥∑∫√∞]|\\(?:le|ge|neq|approx|cdot|times)/u.test(value)) score += 1;
  if (/\b[A-Z]\s*\([^)]*\)/u.test(value)) score += 1;
  return score;
}

function visualColumn(line: string, utf16Index: number): number {
  return stringWidth(line.slice(0, utf16Index));
}

function visualEnd(line: string, start: number, end: number): [number, number] {
  const startCol = visualColumn(line, start);
  return [startCol, startCol + Math.max(1, stringWidth(line.slice(start, end)))];
}

function normalizeLatex(parts: string[]): string {
  return parts.map((part) => part.trim()).filter(Boolean).join("\n");
}

interface ParenthesizedSegment {
  start: number;
  end: number;
  body: string;
}

function parenthesizedSegments(line: string): ParenthesizedSegment[] {
  const segments: Array<{ start: number; end: number; body: string }> = [];
  for (let start = 0; start < line.length; start += 1) {
    if (line[start] !== "(" || line[start - 1] === "\\") continue;
    let depth = 1;
    for (let end = start + 1; end < line.length; end += 1) {
      if (line[end] === "(" && line[end - 1] !== "\\") depth += 1;
      if (line[end] === ")" && line[end - 1] !== "\\") depth -= 1;
      if (depth !== 0) continue;
      const body = line.slice(start + 1, end).trim();
      if (body) segments.push({ start, end: end + 1, body });
      start = end;
      break;
    }
  }
  return segments;
}

function looksLikeAsciiMath(value: string): boolean {
  const compact = value.replace(/\\[ ,;:!]/gu, "").trim();
  if (!/[A-Za-z0-9]/u.test(compact)) return false;
  if (!/^[A-Za-z0-9\s.,+*/=<>^_{}()[\]|\\-]+$/u.test(compact)) return false;
  if (/[=<>]/u.test(compact)) return true;
  if (/^[A-Za-z](?:[_^](?:[A-Za-z0-9]|\{[A-Za-z0-9]+\}))+$/u.test(compact)) return true;
  if (/[_^]/u.test(compact)
    && (/^[0-9]/u.test(compact)
      || /[+*/-]/u.test(compact)
      || /^[A-Za-z]{1,3}[_^]/u.test(compact))) return true;
  const operand = String.raw`(?:\d+(?:\.\d+)?|[A-Za-z])`;
  return new RegExp(`^${operand}(?:[+*/-]${operand})+$`, "u").test(compact.replace(/\s+/gu, ""));
}

function isLikelyMath(value: string): boolean {
  return mathScore(value) >= 3 || looksLikeAsciiMath(value);
}

function inferredParenthesizedMath(line: string): ParenthesizedSegment[] {
  return parenthesizedSegments(line).filter((segment) => isLikelyMath(segment.body));
}

interface DefinitionItem {
  body: string;
  descriptionLatex: string;
  startCol: number;
  endCol: number;
  lineWidth: number;
}

export function escapeTexText(value: string): string {
  const replacements: Record<string, string> = {
    "\\": "\\backslash{}",
    "{": "\\{",
    "}": "\\}",
    "$": "\\$",
    "&": "\\&",
    "#": "\\#",
    "%": "\\%",
    "_": "\\_",
    "^": "\\^{}",
    "~": "\\~{}"
  };
  return value.replace(/[\\{}$&#%_^~]/gu, (character) => replacements[character]!);
}

function descriptionToLatex(value: string): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const segment of parenthesizedSegments(value)) {
    if (!isLikelyMath(segment.body)) continue;
    const prose = value.slice(cursor, segment.start);
    if (prose) parts.push(`\\text{${escapeTexText(prose)}}`);
    parts.push(segment.body);
    cursor = segment.end;
  }
  const prose = value.slice(cursor);
  if (prose) parts.push(`\\text{${escapeTexText(prose)}}`);
  return parts.join("");
}

function isDefinitionSymbol(value: string): boolean {
  return isLikelyMath(value) || /^[A-Za-z](?:[_^](?:[A-Za-z0-9]|\{[A-Za-z0-9]+\}))?$/u.test(value);
}

function definitionItem(line: string): DefinitionItem | undefined {
  for (const segment of parenthesizedSegments(line)) {
    if (!isDefinitionSymbol(segment.body)) continue;
    const prefix = line.slice(0, segment.start);
    if (!/^\s*(?:[-*•]\s+|\d+[.)]\s+)$/u.test(prefix)) continue;
    const suffix = line.slice(segment.end);
    const description = suffix.match(/^\s*([：:]\s*\S.*)$/u)?.[1];
    if (!description) continue;
    return {
      body: segment.body,
      descriptionLatex: descriptionToLatex(description),
      startCol: visualColumn(line, segment.start),
      endCol: visualColumn(line, segment.end),
      lineWidth: stringWidth(line)
    };
  }
  return undefined;
}

function inferredDefinitionGroup(lines: string[], startRow: number): FormulaRegion | undefined {
  const items: DefinitionItem[] = [];
  for (let row = startRow; row < lines.length; row += 1) {
    const item = definitionItem(lines[row] ?? "");
    if (!item || (items[0] && item.startCol !== items[0].startCol)) break;
    items.push(item);
  }
  if (items.length < 2) return undefined;

  const latexRows = items
    .map((item) => `${item.body} & ${item.descriptionLatex}`)
    .join("\\\\");
  return {
    startRow,
    endRow: startRow + items.length - 1,
    startCol: items[0]!.startCol,
    endCol: Math.max(...items.map((item) => item.lineWidth)),
    latex: `\\begin{array}{ll}${latexRows}\\end{array}`,
    display: false,
    confidence: "inferred",
    compact: true
  };
}

function isStandaloneDisplayLine(line: string): boolean {
  const trimmed = line.trim();
  return /^(?:\\\[[\s\S]+\\\]|\$\$(?:\\.|[^$]|\$(?!\$))+\$\$)$/u.test(trimmed);
}

interface DelimitedSegment {
  start: number;
  end: number;
  body: string;
}

interface InlineCodeRange {
  start: number;
  end: number;
}

function isEscapedAt(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

/** Finds Markdown backtick spans so TeX-looking examples remain plain code. */
function inlineCodeRanges(line: string): InlineCodeRange[] {
  const ranges: InlineCodeRange[] = [];
  for (let start = 0; start < line.length; start += 1) {
    if (line[start] !== "`" || isEscapedAt(line, start)) continue;
    let runLength = 1;
    while (line[start + runLength] === "`") runLength += 1;
    const delimiter = "`".repeat(runLength);
    let searchFrom = start + runLength;
    while (searchFrom < line.length) {
      const end = line.indexOf(delimiter, searchFrom);
      if (end < 0) break;
      if (line[end - 1] !== "`" && line[end + runLength] !== "`") {
        ranges.push({ start, end: end + runLength });
        start = end + runLength - 1;
        break;
      }
      searchFrom = end + runLength;
    }
  }
  return ranges;
}

function overlapsInlineCode(start: number, end: number, ranges: InlineCodeRange[]): boolean {
  return ranges.some((range) => start < range.end && end > range.start);
}

function dollarDelimiterPositions(line: string, delimiter: "$" | "$$"): number[] {
  const positions: number[] = [];
  const isSingle = delimiter === "$";
  for (let index = 0; index < line.length; index += 1) {
    if (!line.startsWith(delimiter, index) || isEscapedAt(line, index)) continue;
    if (isSingle && (line[index - 1] === "$" || line[index + 1] === "$")) continue;
    positions.push(index);
    index += delimiter.length - 1;
  }
  return positions;
}

/** Finds dollar-delimited TeX without treating `\$` inside the body as a delimiter. */
function dollarDelimitedSegments(line: string, delimiter: "$" | "$$"): DelimitedSegment[] {
  const segments: DelimitedSegment[] = [];
  const positions = dollarDelimiterPositions(line, delimiter);
  for (let index = 0; index + 1 < positions.length; index += 2) {
    const start = positions[index]!;
    const end = positions[index + 1]!;
    const body = line.slice(start + delimiter.length, end).trim();
    if (body) segments.push({ start, end: end + delimiter.length, body });
  }
  return segments;
}

/**
 * Terminal Markdown renderers sometimes insert a real newline before the
 * terminal edge. Such a row is not marked isWrapped by xterm, so recognize an
 * unmatched `$$` here and pair it with a delimiter on a later logical row.
 */
function hardWrappedDollarDisplay(
  lines: string[],
  startRow: number,
  codeRanges: InlineCodeRange[]
): FormulaRegion | undefined {
  const line = lines[startRow] ?? "";
  const openings = dollarDelimiterPositions(line, "$$")
    .filter((position) => !overlapsInlineCode(position, position + 2, codeRanges));
  if (openings.length % 2 === 0) return undefined;
  const start = openings.at(-1)!;
  const body = [line.slice(start + 2)];

  for (let row = startRow + 1;
    row < Math.min(lines.length, startRow + MAX_DISPLAY_BLOCK_ROWS + 1);
    row += 1) {
    const candidate = lines[row] ?? "";
    const candidateCodeRanges = inlineCodeRanges(candidate);
    const closings = dollarDelimiterPositions(candidate, "$$")
      .filter((position) => !overlapsInlineCode(position, position + 2, candidateCodeRanges));
    if (closings.length === 0) {
      body.push(candidate);
      continue;
    }
    const end = closings[0]!;
    body.push(candidate.slice(0, end));
    const latex = normalizeLatex(body);
    if (!latex) return undefined;
    return {
      startRow,
      endRow: row,
      startCol: visualColumn(line, start),
      endCol: visualColumn(candidate, end + 2),
      latex,
      display: true,
      confidence: "explicit"
    };
  }
  return undefined;
}

function isLikelyInlineDollarMath(value: string): boolean {
  const trimmed = value.trim();
  const evidence = trimmed.replace(/\\\$/gu, "1");
  const compact = evidence.replace(/\s+/gu, "");
  // Explicit `$...$` is stronger evidence than stripped parentheses, so allow
  // the ubiquitous one-letter variable while still rejecting prices such as
  // `$12.50$` and prose-like `$USD$`.
  return isLikelyMath(evidence)
    || /^[A-Za-z]$/u.test(trimmed)
    || /^[a-z]{2,3}$/u.test(trimmed)
    || /^[A-Za-z][A-Za-z0-9]*\s*\([^()]+\)$/u.test(trimmed)
    || (/[_^]/u.test(compact)
      && /[A-Za-z0-9]/u.test(compact)
      && /^[A-Za-z0-9\\{}()[\].,+*/=<>|^_-]+$/u.test(compact));
}

function expandStandaloneDisplayRegions(
  lines: string[],
  regions: FormulaRegion[]
): FormulaRegion[] {
  const claimedRows = new Set<number>();
  const standaloneRows = new Set(regions
    .filter((region) => region.display
      && region.startRow === region.endRow
      && isStandaloneDisplayLine(lines[region.startRow] ?? ""))
    .map((region) => region.startRow));
  for (const region of regions) {
    for (let row = region.startRow; row <= region.endRow; row += 1) claimedRows.add(row);
  }

  const exclusivelyAdjacent = (blankRow: number, formulaRow: number): boolean => {
    const neighbors = [blankRow - 1, blankRow + 1]
      .filter((row) => standaloneRows.has(row));
    return neighbors.length === 1 && neighbors[0] === formulaRow;
  };

  return regions.map((region) => {
    if (!region.display
      || region.startRow !== region.endRow
      || !isStandaloneDisplayLine(lines[region.startRow] ?? "")) {
      return region;
    }

    let startRow = region.startRow;
    let endRow = region.endRow;
    const previousRow = startRow - 1;
    const nextRow = endRow + 1;
    if (previousRow >= 0
      && !(lines[previousRow] ?? "").trim()
      && exclusivelyAdjacent(previousRow, region.startRow)
      && !claimedRows.has(previousRow)) {
      startRow = previousRow;
      claimedRows.add(previousRow);
    }
    if (nextRow < lines.length
      && !(lines[nextRow] ?? "").trim()
      && exclusivelyAdjacent(nextRow, region.endRow)
      && !claimedRows.has(nextRow)) {
      endRow = nextRow;
      claimedRows.add(nextRow);
    }
    if (startRow === region.startRow && endRow === region.endRow) return region;

    return {
      ...region,
      startRow,
      endRow,
      startCol: 0,
      endCol: Math.max(...lines.slice(startRow, endRow + 1).map((line) => stringWidth(line)), 1)
    };
  });
}

function trailingInlineRegion(
  lines: string[],
  row: number,
  line: string,
  startIndex: number,
  endIndex: number,
  latex: string,
  confidence: FormulaRegion["confidence"]
): FormulaRegion {
  const suffix = line.slice(endIndex);
  const trailing = suffix.match(/^([.,;:!?，。；：！？]?)\s*$/u);
  let regionEndIndex = endIndex;
  let regionLatex = latex;
  let endRow = row;
  let compact = false;

  if (trailing) {
    const punctuation = trailing[1] ?? "";
    if (punctuation) {
      regionLatex += `\\text{${escapeTexText(punctuation)}}`;
      regionEndIndex += punctuation.length;
    }
    compact = true;
    if (row + 1 < lines.length && !(lines[row + 1] ?? "").trim()) endRow = row + 1;
  }

  const [startCol, endCol] = visualEnd(line, startIndex, regionEndIndex);
  return {
    startRow: row,
    endRow,
    startCol,
    endCol,
    latex: regionLatex,
    display: false,
    confidence,
    ...(compact ? { compact: true } : {})
  };
}

/**
 * Detect formulas in the post-ANSI terminal screen. Explicit TeX delimiters are
 * preferred. A conservative inferred form handles TUIs that turn `\[`/`\]`
 * into bare bracket lines while leaving the TeX body visible.
 */
export function detectFormulaRegions(lines: string[]): FormulaRegion[] {
  const regions: FormulaRegion[] = [];
  let codeFence: { marker: "`" | "~"; length: number } | undefined;

  for (let row = 0; row < lines.length; row += 1) {
    const line = lines[row] ?? "";
    const trimmed = line.trim();

    const fenceRun = trimmed.match(/^(`+|~+)/u)?.[1];
    if (!codeFence && fenceRun && fenceRun.length >= 3) {
      codeFence = { marker: fenceRun[0] as "`" | "~", length: fenceRun.length };
      continue;
    }
    if (codeFence) {
      if (fenceRun
        && fenceRun[0] === codeFence.marker
        && fenceRun.length >= codeFence.length
        && !trimmed.slice(fenceRun.length).trim()) {
        codeFence = undefined;
      }
      continue;
    }
    if (!trimmed) continue;
    const codeRanges = inlineCodeRanges(line);

    // Definition lists need group-level layout: the source TeX tokens have
    // different character widths, so independently overlaying each token
    // leaves the colons and descriptions staggered. A compact MathJax array
    // aligns both columns without changing the child terminal's cell layout.
    const definitionGroup = inferredDefinitionGroup(lines, row);
    if (definitionGroup) {
      regions.push(definitionGroup);
      row = definitionGroup.endRow;
      continue;
    }
    const loneDefinition = definitionItem(line);

    const blockStart = trimmed === "\\[" || trimmed === "$$" || trimmed === "[";
    if (blockStart) {
      const explicit = trimmed !== "[";
      const closing = trimmed === "$$" ? "$$" : trimmed === "\\[" ? "\\]" : "]";
      const body: string[] = [];
      let endRow = -1;

      for (let candidate = row + 1;
        candidate < Math.min(lines.length, row + MAX_DISPLAY_BLOCK_ROWS + 1);
        candidate += 1) {
        const candidateTrimmed = (lines[candidate] ?? "").trim();
        if (candidateTrimmed === closing || (closing === "\\]" && candidateTrimmed === "]")) {
          endRow = candidate;
          break;
        }
        body.push(lines[candidate] ?? "");
      }

      const latex = normalizeLatex(body);
      if (endRow > row && latex && (explicit || isLikelyMath(latex))) {
        regions.push({
          startRow: row,
          endRow,
          startCol: 0,
          endCol: Math.max(...lines.slice(row, endRow + 1).map((value) => stringWidth(value)), 1),
          latex,
          display: true,
          confidence: explicit ? "explicit" : "inferred"
        });
        row = endRow;
        continue;
      }
    }

    const hardWrappedDisplay = hardWrappedDollarDisplay(lines, row, codeRanges);
    if (hardWrappedDisplay) {
      regions.push(hardWrappedDisplay);
      row = hardWrappedDisplay.endRow;
      continue;
    }

    const explicitPatterns: Array<{ regex: RegExp; display: boolean }> = [
      { regex: /\\\[([\s\S]+?)\\\]/gu, display: true },
      { regex: /\\\((.+?)\\\)/gu, display: false }
    ];

    for (const { regex, display } of explicitPatterns) {
      for (const match of line.matchAll(regex)) {
        if (match.index === undefined || !match[1]?.trim()) continue;
        const matchEnd = match.index + match[0].length;
        if (overlapsInlineCode(match.index, matchEnd, codeRanges)) continue;
        if (!display) {
          regions.push(trailingInlineRegion(
            lines,
            row,
            line,
            match.index,
            matchEnd,
            match[1].trim(),
            "explicit"
          ));
        } else {
          const [startCol, endCol] = visualEnd(line, match.index, matchEnd);
          regions.push({
            startRow: row,
            endRow: row,
            startCol,
            endCol,
            latex: match[1].trim(),
            display,
            confidence: "explicit"
          });
        }
      }
    }

    for (const segment of dollarDelimitedSegments(line, "$$")) {
      if (overlapsInlineCode(segment.start, segment.end, codeRanges)) continue;
      const [startCol, endCol] = visualEnd(line, segment.start, segment.end);
      regions.push({
        startRow: row,
        endRow: row,
        startCol,
        endCol,
        latex: segment.body,
        display: true,
        confidence: "explicit"
      });
    }

    // A single definition line is not eligible for the two-column array used
    // above, but its parenthesized symbol still needs a human-friendly glyph.
    if (loneDefinition) {
      regions.push({
        startRow: row,
        endRow: row,
        startCol: loneDefinition.startCol,
        endCol: loneDefinition.endCol,
        latex: loneDefinition.body,
        display: false,
        confidence: "inferred"
      });
    }

    // Several terminal Markdown renderers consume the backslashes in \(...\)
    // and leave forms such as `(\mathbf E)` or `(\rho)`. Only infer these
    // when the body has strong TeX evidence, so ordinary prose parentheses
    // remain untouched.
    for (const segment of inferredParenthesizedMath(line)) {
      if (overlapsInlineCode(segment.start, segment.end, codeRanges)) continue;
      const [startCol, endCol] = visualEnd(line, segment.start, segment.end);
      if (loneDefinition
        && startCol === loneDefinition.startCol
        && endCol === loneDefinition.endCol) continue;
      regions.push({
        startRow: row,
        endRow: row,
        startCol,
        endCol,
        latex: segment.body,
        display: false,
        confidence: "inferred"
      });
    }

    // Single-dollar inline math is intentionally conservative to avoid prices.
    for (const segment of dollarDelimitedSegments(line, "$")) {
      if (overlapsInlineCode(segment.start, segment.end, codeRanges)) continue;
      if (!isLikelyInlineDollarMath(segment.body)) continue;
      regions.push(trailingInlineRegion(
        lines,
        row,
        line,
        segment.start,
        segment.end,
        segment.body,
        "explicit"
      ));
    }
  }

  const expanded = expandStandaloneDisplayRegions(lines, regions);
  // An explicit delimiter can itself contain parenthesized TeX, for example
  // `\(\operatorname{Var}(X_i)\)`. The conservative inference pass sees the
  // inner `(X_i)` as a second formula unless contained candidates are removed.
  return expanded.filter((candidate, index) => !expanded.some((container, containerIndex) =>
    containerIndex !== index
    && container.confidence === "explicit"
    && candidate.confidence === "inferred"
    && container.startRow <= candidate.startRow
    && container.endRow >= candidate.endRow
    && (container.startRow !== candidate.startRow || container.startCol <= candidate.startCol)
    && (container.endRow !== candidate.endRow || container.endCol >= candidate.endCol)
  ));
}

export const detectorInternals = {
  descriptionToLatex,
  definitionItem,
  dollarDelimiterPositions,
  dollarDelimitedSegments,
  escapeTexText,
  expandStandaloneDisplayRegions,
  inferredDefinitionGroup,
  inferredParenthesizedMath,
  hardWrappedDollarDisplay,
  inlineCodeRanges,
  isLikelyMath,
  isLikelyInlineDollarMath,
  isStandaloneDisplayLine,
  looksLikeAsciiMath,
  mathScore,
  parenthesizedSegments,
  trailingInlineRegion,
  visualColumn
};
