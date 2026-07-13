import stringWidth from "string-width";
import type { FormulaRegion } from "./types.js";

const COMMAND_RE = /\\(?:frac|dfrac|tfrac|sum|prod|int|iint|iiint|log|ln|exp|sqrt|lim|begin|end|left|right|mathrm|mathbf|mathbb|mathcal|operatorname|overline|underline|hat|bar|vec|partial|nabla|infty|alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|kappa|lambda|mu|nu|xi|omicron|pi|varpi|rho|varrho|sigma|varsigma|tau|upsilon|phi|varphi|chi|psi|omega)(?![A-Za-z])/gu;

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
  lineWidth: number;
}

function escapeTexText(value: string): string {
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
  return /^(?:\\\[[\s\S]+\\\]|\$\$[^$]+\$\$)$/u.test(trimmed);
}

function expandStandaloneDisplayRegions(
  lines: string[],
  regions: FormulaRegion[]
): FormulaRegion[] {
  const claimedRows = new Set<number>();
  for (const region of regions) {
    for (let row = region.startRow; row <= region.endRow; row += 1) claimedRows.add(row);
  }

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
      && !claimedRows.has(previousRow)) {
      startRow = previousRow;
      claimedRows.add(previousRow);
    }
    if (nextRow < lines.length
      && !(lines[nextRow] ?? "").trim()
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
  let inCodeFence = false;

  for (let row = 0; row < lines.length; row += 1) {
    const line = lines[row] ?? "";
    const trimmed = line.trim();

    if (/^```/u.test(trimmed)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence || !trimmed) continue;

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

    const blockStart = trimmed === "\\[" || trimmed === "$$" || trimmed === "[";
    if (blockStart) {
      const explicit = trimmed !== "[";
      const closing = trimmed === "$$" ? "$$" : trimmed === "\\[" ? "\\]" : "]";
      const body: string[] = [];
      let endRow = -1;

      for (let candidate = row + 1; candidate < Math.min(lines.length, row + 16); candidate += 1) {
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

    const explicitPatterns: Array<{ regex: RegExp; display: boolean }> = [
      { regex: /\\\[([\s\S]+?)\\\]/gu, display: true },
      { regex: /\$\$([^$]+?)\$\$/gu, display: true },
      { regex: /\\\((.+?)\\\)/gu, display: false }
    ];

    for (const { regex, display } of explicitPatterns) {
      for (const match of line.matchAll(regex)) {
        if (match.index === undefined || !match[1]?.trim()) continue;
        const matchEnd = match.index + match[0].length;
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

    // Several terminal Markdown renderers consume the backslashes in \(...\)
    // and leave forms such as `(\mathbf E)` or `(\rho)`. Only infer these
    // when the body has strong TeX evidence, so ordinary prose parentheses
    // remain untouched.
    for (const segment of inferredParenthesizedMath(line)) {
      const [startCol, endCol] = visualEnd(line, segment.start, segment.end);
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
    const inlineDollar = /(?<!\$)\$([^$\n]+?)\$(?!\$)/gu;
    for (const match of line.matchAll(inlineDollar)) {
      if (match.index === undefined || !match[1] || mathScore(match[1]) < 2) continue;
      regions.push(trailingInlineRegion(
        lines,
        row,
        line,
        match.index,
        match.index + match[0].length,
        match[1].trim(),
        "explicit"
      ));
    }
  }

  return expandStandaloneDisplayRegions(lines, regions);
}

export const detectorInternals = {
  descriptionToLatex,
  definitionItem,
  escapeTexText,
  expandStandaloneDisplayRegions,
  inferredDefinitionGroup,
  inferredParenthesizedMath,
  isLikelyMath,
  isStandaloneDisplayLine,
  looksLikeAsciiMath,
  mathScore,
  parenthesizedSegments,
  trailingInlineRegion,
  visualColumn
};
