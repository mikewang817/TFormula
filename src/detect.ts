import stringWidth from "string-width";
import type { FormulaRegion } from "./types.js";

const COMMAND_RE = /\\(?:frac|dfrac|tfrac|sum|prod|int|iint|iiint|log|ln|exp|sqrt|lim|begin|end|left|right|mathrm|mathbf|mathbb|mathcal|operatorname|overline|underline|hat|bar|vec|partial|nabla|infty|alpha|beta|gamma|delta|theta|lambda|mu|sigma|phi|omega)\b/gu;

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
      if (endRow > row && latex && (explicit || mathScore(latex) >= 3)) {
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
        const [startCol, endCol] = visualEnd(line, match.index, match.index + match[0].length);
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

    // Single-dollar inline math is intentionally conservative to avoid prices.
    const inlineDollar = /(?<!\$)\$([^$\n]+?)\$(?!\$)/gu;
    for (const match of line.matchAll(inlineDollar)) {
      if (match.index === undefined || !match[1] || mathScore(match[1]) < 2) continue;
      const [startCol, endCol] = visualEnd(line, match.index, match.index + match[0].length);
      regions.push({
        startRow: row,
        endRow: row,
        startCol,
        endCol,
        latex: match[1].trim(),
        display: false,
        confidence: "explicit"
      });
    }
  }

  return regions;
}

export const detectorInternals = { mathScore, visualColumn };
