import stringWidth from "string-width";
import type { FormulaRegion } from "./types.js";

const COMMAND_RE = /\\(?:frac|dfrac|tfrac|binom|sum|prod|coprod|int|iint|iiint|oint|log|ln|exp|sqrt|lim|liminf|limsup|sin|cos|tan|cot|sec|csc|arcsin|arccos|arctan|sinh|cosh|tanh|det|dim|gcd|hom|ker|max|min|sup|inf|Pr|mod|pmod|bmod|ce|pu|qty|dv|pdv|bra|ket|braket|begin|end|left|right|text|mathrm|mathbf|mathit|mathsf|mathtt|mathbb|mathcal|mathfrak|operatorname|overline|underline|widehat|widetilde|hat|bar|vec|dot|ddot|partial|nabla|ell|infty|forall|exists|neg|pm|mp|times|div|cdot|ast|star|circ|bullet|oplus|otimes|cap|cup|subset|supset|subseteq|supseteq|in|notin|ni|le|leq|ge|geq|neq|ne|approx|sim|simeq|cong|equiv|propto|to|mapsto|rightarrow|leftarrow|leftrightarrow|Rightarrow|Leftarrow|Leftrightarrow|alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|kappa|lambda|mu|nu|xi|omicron|pi|varpi|rho|varrho|sigma|varsigma|tau|upsilon|phi|varphi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega)(?![A-Za-z])/gu;

const ANY_TEX_COMMAND_RE = /\\[A-Za-z]+/gu;
const UPRIGHT_GREEK_COMMAND_RE = /^(?:up(?:alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|kappa|lambda|mu|nu|xi|omicron|pi|varpi|rho|varrho|sigma|varsigma|tau|upsilon|phi|varphi|chi|psi|omega)|Up(?:gamma|delta|theta|lambda|xi|pi|sigma|upsilon|phi|psi|omega))$/u;
const SCIENTIFIC_COMMANDS = new Set([
  "SI", "si", "unit", "units", "unitfrac", "nicefrac",
  "prescript", "centernot", "implies", "coloneqq", "xleftrightarrow", "xlongequal",
  "cancel", "bcancel", "xcancel", "cancelto", "boldsymbol",
  "degree", "celsius", "ohm", "micro",
  "comm", "commutator", "acomm", "anticommutator",
  "expval", "expectationvalue", "mel", "matrixelement",
  "dd", "fdv", "functionalderivative"
]);
const UNICODE_MATH_RE = /[\p{Sm}\u00b2\u00b3\u00b9\u0370-\u03ff\u1f00-\u1fff\u2070-\u209f\u2100-\u214f\u{1d400}-\u{1d7ff}]/u;
const PROSE_MATH_WORDS = new Set([
  "and", "bar", "baz", "config", "else", "false", "foo", "for", "from", "if", "in",
  "is", "mode", "of", "off", "ok", "on", "or", "set", "status", "the", "then", "to",
  "true", "version", "with"
]);
const INFERRED_MATH_WORDS = new Set([
  "arg", "cos", "cot", "csc", "deg", "det", "dim", "exp", "gcd", "hom", "inf",
  "ker", "lim", "ln", "log", "max", "min", "mod", "pr", "sec", "sin", "sup", "tan"
]);
const DISPLAY_ENVIRONMENTS = new Set([
  "align", "align*", "aligned", "alignedat", "alignat", "alignat*",
  "cases", "displaymath", "equation", "equation*", "flalign", "flalign*",
  "gather", "gather*", "gathered", "matrix", "multline", "multline*",
  "pmatrix", "smallmatrix", "split", "Vmatrix", "vmatrix", "bmatrix", "Bmatrix"
]);

// Terminal Markdown renderers commonly consume one of the two slashes in a
// TeX row separator. These are the environments where a hard source line can be
// restored as a TeX row without changing an ordinary equation/displaymath
// newline into a forced break.
const ROW_BREAK_ENVIRONMENTS = new Set([
  "align", "align*", "aligned", "alignedat", "alignat", "alignat*",
  "flalign", "flalign*", "gather", "gather*", "gathered", "multline",
  "multline*", "split", "cases", "matrix", "pmatrix", "smallmatrix",
  "Vmatrix", "vmatrix", "bmatrix", "Bmatrix"
]);

const ALIGNMENT_ENVIRONMENTS = new Set([
  "align", "align*", "aligned", "alignedat", "alignat", "alignat*",
  "flalign", "flalign*", "split"
]);

const MAX_DISPLAY_BLOCK_ROWS = 256;
const FORMULA_TRIGGER_RE = /[\\$()[\]^_=<>+*/-]|[^\x00-\x7f]/u;

export function containsFormulaTrigger(value: string): boolean {
  return FORMULA_TRIGGER_RE.test(value);
}

function mathScore(value: string): number {
  let score = 0;
  score += (value.match(COMMAND_RE)?.length ?? 0) * 3;
  score += [...value.matchAll(ANY_TEX_COMMAND_RE)]
    .filter((match) => {
      const command = match[0]!.slice(1);
      return SCIENTIFIC_COMMANDS.has(command) || UPRIGHT_GREEK_COMMAND_RE.test(command);
    }).length * 3;
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
  const openStack: number[] = [];
  const matchingEndByStart = new Uint32Array(line.length);

  // Pair every balanced parenthesis in one pass. Keeping the inner matches is
  // important for recovery: when an outer opener is never closed, the former
  // implementation retried at the next opener and could still return a
  // balanced segment inside it.
  for (let index = 0; index < line.length; index += 1) {
    if (line[index - 1] === "\\") continue;
    if (line[index] === "(") {
      openStack.push(index);
    } else if (line[index] === ")" && openStack.length > 0) {
      matchingEndByStart[openStack.pop()!] = index + 1;
    }
  }

  // Retaining the first matched opener and jumping to its closer reproduces
  // the old left-to-right skip semantics. An unmatched ancestor has no end,
  // so scanning continues and can still recover its balanced inner pairs.
  const segments: ParenthesizedSegment[] = [];
  for (let start = 0; start < line.length; start += 1) {
    const end = matchingEndByStart[start]!;
    if (end === 0) continue;
    const body = line.slice(start + 1, end - 1).trim();
    if (body) segments.push({ start, end, body });
    start = end - 1;
  }
  return segments;
}

function looksLikeAsciiMath(value: string): boolean {
  const compact = value.replace(/\\[ ,;:!]/gu, "").trim();
  if (!/[A-Za-z0-9]/u.test(compact)) return false;
  if (!/^[A-Za-z0-9\s.,+*/=<>^_{}()[\]|\\-]+$/u.test(compact)) return false;
  const proseProbe = compact.replace(ANY_TEX_COMMAND_RE, "");
  const words = proseProbe.match(/[A-Za-z]+/gu) ?? [];
  const hasProseWord = words.some((word) => {
    if (PROSE_MATH_WORDS.has(word.toLowerCase())) return true;
    if (/^[A-Z]{3,}$/u.test(word)) return true;
    return word.length >= 4;
  });
  if (hasProseWord) return false;
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

function hasStrongUnicodeMath(value: string): boolean {
  return /[^\x00-\x7f]/u.test(value) && UNICODE_MATH_RE.test(value);
}

/** Strong enough for delimiter-free inference without swallowing prose. */
function isLikelyInferredUnicodeMath(value: string): boolean {
  const trimmed = value.trim();
  if (!hasStrongUnicodeMath(trimmed)) return false;
  const proseProbe = trimmed.replace(ANY_TEX_COMMAND_RE, "");
  const residue = proseProbe.replace(
    /[\p{Sm}\p{Mark}\u00b2\u00b3\u00b9\u0370-\u03ff\u1f00-\u1fff\u2070-\u209f\u2100-\u214f\u{1d400}-\u{1d7ff}]/gu,
    ""
  );
  // Han and other non-mathematical scripts are prose evidence. ASCII words
  // are allowed only when they still resemble short variable/function names.
  if (/[^\x00-\x7f]/u.test(residue)) return false;
  const words = residue.match(/[A-Za-z]+/gu) ?? [];
  if (words.some((word) => word.length > 1
    && !INFERRED_MATH_WORDS.has(word.toLowerCase()))) {
    return false;
  }
  return /^[A-Za-z0-9\s.,+*/=<>^_{}()[\]|\\-]*$/u.test(residue);
}

function inferredParenthesizedMath(line: string): ParenthesizedSegment[] {
  return parenthesizedSegments(line)
    .filter((segment) => isLikelyMath(segment.body)
      || isLikelyInferredUnicodeMath(segment.body));
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
    if (!isLikelyMath(segment.body) && !isLikelyInferredUnicodeMath(segment.body)) continue;
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
  return isLikelyMath(value)
    || isLikelyInferredUnicodeMath(value)
    || /^[A-Za-z](?:[_^](?:[A-Za-z0-9]|\{[A-Za-z0-9]+\}))?$/u.test(value);
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
  if (trimmed.startsWith("\\[") && trimmed.endsWith("\\]")) {
    return trimmed.length > 4;
  }
  if (!trimmed.startsWith("$$")
    || !trimmed.endsWith("$$")
    || trimmed.length <= 4) return false;

  // Keep the body grammar equivalent to `(?:\\.|[^$]|\$(?!\$))+`, but scan
  // it deterministically. In the former regular expression, `\\.` and
  // `[^$]` could both consume a backslash. A malformed line ending in a lone
  // dollar therefore created exponentially many backtracking paths while the
  // screen was being rescanned.
  const body = trimmed.slice(2, -2);
  const reachable = new Uint8Array(body.length + 1);
  reachable[0] = 1;
  for (let index = 0; index < body.length; index += 1) {
    if (!reachable[index]) continue;
    if (body[index] !== "$"
      || (index + 1 < body.length && body[index + 1] !== "$")) {
      reachable[index + 1] = 1;
    }
    if (body[index] === "\\" && index + 1 < body.length) reachable[index + 2] = 1;
  }
  return Boolean(reachable[body.length]);
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

interface BacktickRun {
  start: number;
  end: number;
  length: number;
}

interface DetectionLineContext {
  inCodeFence: boolean;
  codeRanges: InlineCodeRange[];
}

interface DelimiterPosition {
  row: number;
  index: number;
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
  const runs: BacktickRun[] = [];
  let maxRunLength = 0;
  for (let index = 0; index < line.length;) {
    if (line[index] !== "`") {
      index += 1;
      continue;
    }
    const start = index;
    while (line[index] === "`") index += 1;
    const length = index - start;
    runs.push({ start, end: index, length });
    maxRunLength = Math.max(maxRunLength, length);
  }
  if (runs.length < 2) return [];

  // For each run, retain the next run of the same exact length. Markdown code
  // spans require equal-length delimiters. The predecessor disjoint-set below
  // finds the largest still-available delimiter length no greater than an
  // opener's length in amortized linear time.
  const nextSameLength = new Int32Array(runs.length);
  nextSameLength.fill(-1);
  const nextIndexByLength = new Int32Array(maxRunLength + 1);
  nextIndexByLength.fill(-1);
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const length = runs[index]!.length;
    nextSameLength[index] = nextIndexByLength[length]!;
    nextIndexByLength[length] = index;
  }

  const availablePredecessor = new Int32Array(maxRunLength + 1);
  for (let length = 1; length <= maxRunLength; length += 1) {
    availablePredecessor[length] = nextIndexByLength[length]! >= 0
      ? length
      : availablePredecessor[length - 1]!;
  }
  const greatestAvailable = (limit: number): number => {
    let cursor = Math.min(limit, maxRunLength);
    while (availablePredecessor[cursor] !== cursor) {
      cursor = availablePredecessor[cursor]!;
    }
    const root = cursor;
    cursor = Math.min(limit, maxRunLength);
    while (availablePredecessor[cursor] !== cursor) {
      const parent = availablePredecessor[cursor]!;
      availablePredecessor[cursor] = root;
      cursor = parent;
    }
    return root;
  };

  let consumedThrough = -1;
  const consumeThrough = (target: number): void => {
    while (consumedThrough < target) {
      consumedThrough += 1;
      const length = runs[consumedThrough]!.length;
      if (nextIndexByLength[length] !== consumedThrough) continue;
      nextIndexByLength[length] = nextSameLength[consumedThrough]!;
      if (nextIndexByLength[length] < 0) {
        availablePredecessor[length] = greatestAvailable(length - 1);
      }
    }
  };

  const ranges: InlineCodeRange[] = [];
  for (let index = 0; index < runs.length; index += 1) {
    consumeThrough(index);
    const run = runs[index]!;
    // If the first backtick is escaped, the old recovery loop retried at the
    // second backtick, so suffixes of this run remain eligible openers.
    const maximumLength = run.length - (isEscapedAt(line, run.start) ? 1 : 0);
    const delimiterLength = greatestAvailable(maximumLength);
    if (delimiterLength === 0) continue;
    const closingIndex = nextIndexByLength[delimiterLength]!;
    const closingRun = runs[closingIndex]!;
    ranges.push({
      start: run.end - delimiterLength,
      end: closingRun.end
    });
    index = closingIndex;
  }
  return ranges;
}

function overlapsInlineCode(start: number, end: number, ranges: InlineCodeRange[]): boolean {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ranges[middle]!.end <= start) low = middle + 1;
    else high = middle;
  }
  const range = ranges[low];
  return range !== undefined && start < range.end && end > range.start;
}

function detectionLineContexts(lines: string[]): DetectionLineContext[] {
  const contexts: DetectionLineContext[] = [];
  let codeFence: { marker: "`" | "~"; length: number } | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    const fenceRun = trimmed.match(/^(`+|~+)/u)?.[1];
    if (!codeFence && fenceRun && fenceRun.length >= 3) {
      contexts.push({ inCodeFence: true, codeRanges: [] });
      codeFence = { marker: fenceRun[0] as "`" | "~", length: fenceRun.length };
      continue;
    }
    if (codeFence) {
      contexts.push({ inCodeFence: true, codeRanges: [] });
      if (fenceRun
        && fenceRun[0] === codeFence.marker
        && fenceRun.length >= codeFence.length
        && !trimmed.slice(fenceRun.length).trim()) {
        codeFence = undefined;
      }
      continue;
    }
    contexts.push({ inCodeFence: false, codeRanges: inlineCodeRanges(line) });
  }
  return contexts;
}

function positionInInlineCode(index: number, context: DetectionLineContext): boolean {
  return overlapsInlineCode(index, index + 1, context.codeRanges);
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

function hasOddTrailingBackslash(value: string): boolean {
  let count = 0;
  for (let index = value.length - 1; index >= 0 && value[index] === "\\"; index -= 1) {
    count += 1;
  }
  return count % 2 === 1;
}

function shouldJoinHardWrappedToken(left: string, right: string): boolean {
  if (!left || !right) return false;
  if (hasOddTrailingBackslash(left)) return true;

  const command = left.match(/\\([A-Za-z]+)$/u)?.[1];
  const continuation = right.match(/^([A-Za-z]+)/u)?.[1];
  if (!command || !continuation) return false;
  // A complete, known command at the end of a genuine TeX row needs the
  // newline as its control-word terminator. An unknown prefix is much more
  // likely to be a TUI hard-wrap in the middle of `\varepsilon`,
  // `\operatorname`, and similar control words.
  return mathScore(`\\${command}`) < 3;
}

interface RowEnvironmentState {
  name: string;
  braceDepth: number;
}

function trailingSingleBackslash(value: string): boolean {
  const trimmed = value.trimEnd();
  let count = 0;
  for (let index = trimmed.length - 1; index >= 0 && trimmed[index] === "\\"; index -= 1) {
    count += 1;
  }
  return count === 1;
}

const STRIPPED_SPACED_ROW_BREAK_RE = /(\\+)(\s*\[\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*(?:pt|pc|in|bp|cm|mm|dd|cc|sp|ex|em|mu)\s*\])\s*$/u;

function strippedSpacedRowBreak(value: string): boolean {
  const match = value.match(STRIPPED_SPACED_ROW_BREAK_RE);
  return match?.[1]?.length === 1;
}

function topLevelAlignmentMarker(value: string): boolean {
  let braceDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (isEscapedAt(value, index)) continue;
    if (value[index] === "{") braceDepth += 1;
    else if (value[index] === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (value[index] === "&" && braceDepth === 0) return true;
  }
  return false;
}

function startsWithRelation(value: string): boolean {
  return /^(?:=|<|>|≤|≥|≈|≃|≡|∼|\\(?:leq?|geq?|neq?|approx|sim|simeq|equiv|propto)\b)/u
    .test(value.trimStart());
}

function appendMissingRowSlash(value: string): string {
  const trailingWhitespace = value.match(/\s*$/u)?.[0] ?? "";
  const body = value.slice(0, value.length - trailingWhitespace.length);
  return `${body}\\${trailingWhitespace}`;
}

function restoreSpacedRowBreak(value: string): string {
  const match = value.match(STRIPPED_SPACED_ROW_BREAK_RE);
  if (!match || match.index === undefined) return value;
  return `${value.slice(0, match.index)}\\\\${value.slice(match.index + 1)}`;
}

function appendRowBreak(value: string): string {
  const trailingWhitespace = value.match(/\s*$/u)?.[0] ?? "";
  const body = value.slice(0, value.length - trailingWhitespace.length);
  return `${body}\\\\${trailingWhitespace}`;
}

function hasExplicitRowBreak(value: string): boolean {
  return /\\\\(?:\s*\[[^\]]*\])?\s*$/u.test(value) || /\\cr\s*$/u.test(value);
}

/**
 * Repair the lossy Markdown form of row-oriented TeX environments.
 *
 * Several terminal Markdown renderers strip the slash from display delimiters
 * and reduce a two-slash row separator to one trailing slash. MathJax accepts that
 * damaged input, but treats every aligned row as one enormous equation.  The
 * result is the characteristic full-width strip of detached numerators and
 * denominators.  A single trailing slash is strong evidence that this exact
 * transformation occurred.  Once seen, also restore top-level hard lines that
 * carry an alignment tab or begin with a continuation relation; those lines
 * sometimes lose the separator completely during Markdown layout.
 *
 * Boundaries inside an open TeX group are deliberately left alone, as are
 * formulas with no stripped-separator evidence.
 */
function repairStrippedEnvironmentRowBreaks(value: string): string {
  const lines = value.split("\n");
  if (lines.length < 2
    || !lines.some((line) => trailingSingleBackslash(line) || strippedSpacedRowBreak(line))) {
    return value;
  }

  const stack: RowEnvironmentState[] = [];
  let braceDepth = 0;
  for (let row = 0; row + 1 < lines.length; row += 1) {
    const line = lines[row]!;
    for (let index = 0; index < line.length;) {
      const environment = line.slice(index).match(/^\\(begin|end)\{([A-Za-z]+\*?)\}/u);
      if (environment) {
        const name = environment[2]!;
        if (environment[1] === "begin") {
          if (ROW_BREAK_ENVIRONMENTS.has(name)) stack.push({ name, braceDepth });
        } else {
          let matching = -1;
          for (let candidate = stack.length - 1; candidate >= 0; candidate -= 1) {
            if (stack[candidate]!.name === name) {
              matching = candidate;
              break;
            }
          }
          if (matching >= 0) stack.splice(matching);
        }
        index += environment[0].length;
        continue;
      }
      if (!isEscapedAt(line, index)) {
        if (line[index] === "{") braceDepth += 1;
        else if (line[index] === "}") braceDepth = Math.max(0, braceDepth - 1);
      }
      index += 1;
    }

    const active = stack.at(-1);
    if (!active || braceDepth !== active.braceDepth) continue;
    const contentProbe = line
      .replace(/\\(?:begin|end)\{[A-Za-z]+\*?\}(?:\{[^{}]*\})?/gu, "")
      .trim();
    if (!contentProbe) continue;
    const next = lines[row + 1]!;
    if (hasExplicitRowBreak(line)) continue;

    if (strippedSpacedRowBreak(line)) {
      lines[row] = restoreSpacedRowBreak(line);
      continue;
    }

    if (next.trimStart().startsWith(`\\end{${active.name}}`)) continue;

    if (trailingSingleBackslash(line)) {
      lines[row] = appendMissingRowSlash(line);
      continue;
    }

    const nextHasAlignment = topLevelAlignmentMarker(next);
    const nextStartsRelation = startsWithRelation(next);
    if (!nextHasAlignment && !nextStartsRelation) continue;
    // Markdown can wrap the left-hand side immediately before the alignment
    // tab. In that shape `lhs` followed by `&=rhs` is still one TeX row, not
    // two rows with an invented separator.
    if (next.trimStart().startsWith("&") && !topLevelAlignmentMarker(line)) continue;
    lines[row] = appendRowBreak(line);
    if (nextStartsRelation && ALIGNMENT_ENVIRONMENTS.has(active.name)) {
      const indentation = next.match(/^\s*/u)?.[0] ?? "";
      lines[row + 1] = `${indentation}&${next.slice(indentation.length)}`;
    }
  }
  return lines.join("\n");
}

function normalizeHardWrappedLatex(parts: string[]): string {
  const normalized = repairStrippedEnvironmentRowBreaks(
    parts.map((part) => part.trim()).join("\n")
  ).split("\n");
  let result = normalized.shift() ?? "";
  for (const part of normalized) {
    if (!result) {
      result = part;
      continue;
    }
    if (!part) {
      result += "\n";
      continue;
    }
    result += shouldJoinHardWrappedToken(result, part) ? part : `\n${part}`;
  }
  return result.trim();
}

function bodyBetweenDelimiters(
  lines: string[],
  start: DelimiterPosition,
  end: DelimiterPosition,
  openingLength: number
): string {
  if (start.row === end.row) {
    return (lines[start.row] ?? "").slice(start.index + openingLength, end.index).trim();
  }
  return normalizeHardWrappedLatex([
    (lines[start.row] ?? "").slice(start.index + openingLength),
    ...lines.slice(start.row + 1, end.row),
    (lines[end.row] ?? "").slice(0, end.index)
  ]);
}

function delimiterBodyCrossesCode(
  contexts: DetectionLineContext[],
  start: DelimiterPosition,
  end: DelimiterPosition,
  openingLength: number
): boolean {
  for (let row = start.row; row <= end.row; row += 1) {
    const context = contexts[row];
    if (!context || context.inCodeFence) return true;
    const rangeStart = row === start.row ? start.index + openingLength : 0;
    const rangeEnd = row === end.row ? end.index : Number.POSITIVE_INFINITY;
    if (context.codeRanges.some((range) => range.start < rangeEnd && range.end > rangeStart)) {
      return true;
    }
  }
  return false;
}

function unescapedTokenPositions(
  line: string,
  token: string,
  context: DetectionLineContext
): number[] {
  if (context.inCodeFence) return [];
  const positions: number[] = [];
  for (let index = 0; index <= line.length - token.length; index += 1) {
    if (!line.startsWith(token, index)
      || isEscapedAt(line, index)
      || overlapsInlineCode(index, index + token.length, context.codeRanges)) continue;
    positions.push(index);
    index += token.length - 1;
  }
  return positions;
}

function slashDelimitedRegions(
  lines: string[],
  contexts: DetectionLineContext[],
  opening: "\\(" | "\\[",
  closing: "\\)" | "\\]",
  display: boolean
): FormulaRegion[] {
  const regions: FormulaRegion[] = [];
  let pending: DelimiterPosition | undefined;

  for (let row = 0; row < lines.length; row += 1) {
    const context = contexts[row]!;
    if (context.inCodeFence) {
      pending = undefined;
      continue;
    }
    const events = [
      ...unescapedTokenPositions(lines[row] ?? "", opening, context)
        .map((index) => ({ index, opening: true })),
      ...unescapedTokenPositions(lines[row] ?? "", closing, context)
        .map((index) => ({ index, opening: false }))
    ].sort((left, right) => left.index - right.index);

    for (const event of events) {
      if (event.opening) {
        // TeX math delimiters do not nest. Replacing an unmatched opener lets
        // a later valid formula recover instead of being swallowed by stale
        // literal text earlier on the screen.
        pending = { row, index: event.index };
        continue;
      }
      if (!pending) continue;
      const start = pending;
      pending = undefined;
      const end = { row, index: event.index };
      if (end.row - start.row > MAX_DISPLAY_BLOCK_ROWS
        || delimiterBodyCrossesCode(contexts, start, end, opening.length)) continue;
      const latex = bodyBetweenDelimiters(lines, start, end, opening.length);
      if (!latex) continue;

      if (start.row === end.row && !display) {
        regions.push(trailingInlineRegion(
          lines,
          row,
          lines[row] ?? "",
          start.index,
          end.index + closing.length,
          latex,
          "explicit"
        ));
        continue;
      }
      const startLine = lines[start.row] ?? "";
      const endLine = lines[end.row] ?? "";
      regions.push({
        startRow: start.row,
        endRow: end.row,
        startCol: visualColumn(startLine, start.index),
        endCol: visualColumn(endLine, end.index + closing.length),
        latex,
        display,
        confidence: "explicit"
      });
    }
  }
  return regions;
}

interface EnvironmentToken {
  row: number;
  index: number;
  end: number;
  action: "begin" | "end";
  name: string;
}

/** Detects standard TeX display environments even when Markdown omits `$` delimiters. */
function environmentRegions(
  lines: string[],
  contexts: DetectionLineContext[]
): FormulaRegion[] {
  const tokens: EnvironmentToken[] = [];
  const pattern = /\\(begin|end)\{([A-Za-z]+\*?)\}/gu;
  for (let row = 0; row < lines.length; row += 1) {
    const line = lines[row] ?? "";
    const context = contexts[row]!;
    if (context.inCodeFence) continue;
    for (const match of line.matchAll(pattern)) {
      if (match.index === undefined
        || !DISPLAY_ENVIRONMENTS.has(match[2]!)
        || isEscapedAt(line, match.index)
        || overlapsInlineCode(match.index, match.index + match[0].length, context.codeRanges)) {
        continue;
      }
      tokens.push({
        row,
        index: match.index,
        end: match.index + match[0].length,
        action: match[1] as "begin" | "end",
        name: match[2]!
      });
    }
  }

  const regions: FormulaRegion[] = [];
  const stack: EnvironmentToken[] = [];
  let outer: EnvironmentToken | undefined;
  for (const token of tokens) {
    if (token.action === "begin") {
      if (stack.length === 0) outer = token;
      stack.push(token);
      continue;
    }
    if (stack.at(-1)?.name !== token.name) {
      // A mismatched environment cannot be rendered safely. Discard the
      // pending group, then allow the next well-formed begin/end pair to recover.
      stack.length = 0;
      outer = undefined;
      continue;
    }
    stack.pop();
    if (stack.length > 0 || !outer) continue;
    const start = outer;
    outer = undefined;
    if (token.row - start.row > MAX_DISPLAY_BLOCK_ROWS
      || delimiterBodyCrossesCode(contexts, start, token, 0)) continue;
    const latex = start.row === token.row
      ? (lines[start.row] ?? "").slice(start.index, token.end).trim()
      : normalizeHardWrappedLatex([
          (lines[start.row] ?? "").slice(start.index),
          ...lines.slice(start.row + 1, token.row),
          (lines[token.row] ?? "").slice(0, token.end)
        ]);
    if (!latex) continue;
    regions.push({
      startRow: start.row,
      endRow: token.row,
      startCol: visualColumn(lines[start.row] ?? "", start.index),
      endCol: visualColumn(lines[token.row] ?? "", token.end),
      latex,
      display: true,
      confidence: "explicit"
    });
  }
  return regions;
}

interface DollarPair {
  start: DelimiterPosition;
  end: DelimiterPosition;
  latex: string;
  quality: number;
  span: number;
}

function dollarDelimitedRegions(
  lines: string[],
  contexts: DetectionLineContext[],
  delimiter: "$" | "$$",
  display: boolean
): FormulaRegion[] {
  const positions: DelimiterPosition[] = [];
  for (let row = 0; row < lines.length; row += 1) {
    const context = contexts[row]!;
    if (context.inCodeFence) continue;
    for (const index of dollarDelimiterPositions(lines[row] ?? "", delimiter)) {
      if (!positionInInlineCode(index, context)) positions.push({ row, index });
    }
  }

  const candidates = new Array<DollarPair | undefined>(positions.length);
  for (let index = 0; index + 1 < positions.length; index += 1) {
    const start = positions[index]!;
    const end = positions[index + 1]!;
    if (end.row - start.row > MAX_DISPLAY_BLOCK_ROWS
      || delimiterBodyCrossesCode(contexts, start, end, delimiter.length)) continue;
    const latex = bodyBetweenDelimiters(lines, start, end, delimiter.length);
    if (!latex || (!display && !isLikelyInlineDollarMath(latex))) continue;
    if (!display
      && start.row !== end.row
      && !(/\\[A-Za-z]+|[_^=<>+*/-]/u.test(latex)
        || isLikelyInferredUnicodeMath(latex)
        || /^[A-Za-z][A-Za-z0-9]*\s*\([^()]+\)$/su.test(latex))) continue;
    candidates[index] = {
      start,
      end,
      latex,
      quality: mathScore(latex) + (hasStrongUnicodeMath(latex) ? 3 : 0),
      span: (end.row - start.row) * 10_000 + Math.max(1, end.index - start.index)
    };
  }

  // Store only the score and the chosen edge for each dynamic-programming
  // state. Keeping `[pair, ...tail.pairs]` at every position copied a
  // quadratic number of references on dollar-dense output, even though only
  // the first solution survived.
  const pairCounts = new Uint32Array(positions.length + 2);
  const qualities = new Float64Array(positions.length + 2);
  const spans = new Float64Array(positions.length + 2);
  const takesPair = new Uint8Array(positions.length);
  for (let index = positions.length - 1; index >= 0; index -= 1) {
    const pair = candidates[index];
    if (!pair) {
      pairCounts[index] = pairCounts[index + 1]!;
      qualities[index] = qualities[index + 1]!;
      spans[index] = spans[index + 1]!;
      continue;
    }
    const pairedCount = 1 + pairCounts[index + 2]!;
    const pairedQuality = pair.quality + qualities[index + 2]!;
    const pairedSpan = pair.span + spans[index + 2]!;
    const skippedCount = pairCounts[index + 1]!;
    const skippedQuality = qualities[index + 1]!;
    const skippedSpan = spans[index + 1]!;
    const takePair = pairedCount > skippedCount
      || (pairedCount === skippedCount && pairedQuality > skippedQuality)
      || (pairedCount === skippedCount
        && pairedQuality === skippedQuality
        && pairedSpan <= skippedSpan);
    if (takePair) {
      pairCounts[index] = pairedCount;
      qualities[index] = pairedQuality;
      spans[index] = pairedSpan;
      takesPair[index] = 1;
    } else {
      pairCounts[index] = skippedCount;
      qualities[index] = skippedQuality;
      spans[index] = skippedSpan;
    }
  }

  const pairs: DollarPair[] = [];
  for (let index = 0; index < positions.length;) {
    const pair = candidates[index];
    if (takesPair[index] && pair) {
      pairs.push(pair);
      index += 2;
    } else {
      index += 1;
    }
  }

  return pairs.map(({ start, end, latex }) => {
    if (start.row === end.row && !display) {
      return trailingInlineRegion(
        lines,
        start.row,
        lines[start.row] ?? "",
        start.index,
        end.index + delimiter.length,
        latex,
        "explicit"
      );
    }
    const startLine = lines[start.row] ?? "";
    const endLine = lines[end.row] ?? "";
    return {
      startRow: start.row,
      endRow: end.row,
      startCol: visualColumn(startLine, start.index),
      endCol: visualColumn(endLine, end.index + delimiter.length),
      latex,
      display,
      confidence: "explicit"
    };
  });
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
  return /\\[A-Za-z]+/u.test(evidence)
    || hasStrongUnicodeMath(evidence)
    || isLikelyMath(evidence)
    || /^[A-Za-z]$/u.test(trimmed)
    || (/^[a-z]{2,3}$/u.test(trimmed) && !PROSE_MATH_WORDS.has(trimmed))
    || /^[A-Za-z][A-Za-z0-9]*\s*\([^()]+\)$/u.test(trimmed)
    || (/[_^]/u.test(compact)
      && /[A-Za-z0-9]/u.test(compact)
      && /^[A-Za-z0-9\\{}()[\].,+*/=<>|^_-]+$/u.test(compact));
}

function bareBracketSegments(line: string, codeRanges: InlineCodeRange[]): DelimitedSegment[] {
  const segments: DelimitedSegment[] = [];
  const stack: number[] = [];
  for (let index = 0; index < line.length; index += 1) {
    if (overlapsInlineCode(index, index + 1, codeRanges)) continue;
    if (line[index] === "[" && line[index - 1] !== "\\") {
      stack.push(index);
      continue;
    }
    if (line[index] !== "]" || line[index - 1] === "\\" || stack.length === 0) continue;
    const start = stack.pop()!;
    if (stack.length > 0) continue;
    const body = line.slice(start + 1, index).trim();
    if (body && (isLikelyMath(body) || isLikelyInferredUnicodeMath(body))) {
      segments.push({ start, end: index + 1, body });
    }
  }
  return segments;
}

function isLikelyStandaloneMath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 160 || /[`$]/u.test(trimmed)) return false;
  if (/\\(?:\[|\]|\(|\))/u.test(trimmed)) return false;
  if (/\\[A-Za-z]+/u.test(trimmed)) return mathScore(trimmed) >= 3;
  if (hasStrongUnicodeMath(trimmed)) {
    return isLikelyInferredUnicodeMath(trimmed);
  }
  if (!looksLikeAsciiMath(trimmed)) return false;
  return /[=<>^_+*/-]/u.test(trimmed);
}

function isStandaloneDisplayEnvironmentToken(value: string): boolean {
  const match = value.trim().match(/^\\(?:begin|end)\{([A-Za-z]+\*?)\}$/u);
  return Boolean(match && DISPLAY_ENVIRONMENTS.has(match[1]!));
}

function adjacentToStandaloneDelimiter(lines: string[], row: number): boolean {
  const delimiter = /^(?:\\\[|\\\]|\$\$|\[|\])$/u;
  return delimiter.test((lines[row - 1] ?? "").trim())
    || delimiter.test((lines[row + 1] ?? "").trim());
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
  // Every supported explicit delimiter, TeX command, inferred ASCII form, and
  // Unicode-math form contains at least one of these characters. Most TUI
  // frames are plain status/log text, so avoid building code-range contexts
  // and running every detector when a formula is structurally impossible.
  if (!lines.some(containsFormulaTrigger)) return [];
  const contexts = detectionLineContexts(lines);
  const regions: FormulaRegion[] = [
    ...environmentRegions(lines, contexts),
    ...slashDelimitedRegions(lines, contexts, "\\[", "\\]", true),
    ...slashDelimitedRegions(lines, contexts, "\\(", "\\)", false),
    ...dollarDelimitedRegions(lines, contexts, "$$", true),
    ...dollarDelimitedRegions(lines, contexts, "$", false)
  ];

  for (let row = 0; row < lines.length; row += 1) {
    const line = lines[row] ?? "";
    const trimmed = line.trim();
    const context = contexts[row]!;
    if (context.inCodeFence) continue;
    if (!trimmed) continue;
    const codeRanges = context.codeRanges;

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

    if (trimmed === "[") {
      const body: string[] = [];
      let endRow = -1;

      for (let candidate = row + 1;
        candidate < Math.min(lines.length, row + MAX_DISPLAY_BLOCK_ROWS + 1);
        candidate += 1) {
        if (contexts[candidate]?.inCodeFence) break;
        const candidateTrimmed = (lines[candidate] ?? "").trim();
        if (candidateTrimmed === "]" || candidateTrimmed === "\\]") {
          endRow = candidate;
          break;
        }
        body.push(lines[candidate] ?? "");
      }

      const latex = normalizeHardWrappedLatex(body);
      if (endRow > row && latex && isLikelyMath(latex)) {
        regions.push({
          startRow: row,
          endRow,
          startCol: 0,
          endCol: Math.max(...lines.slice(row, endRow + 1).map((value) => stringWidth(value)), 1),
          latex,
          display: true,
          confidence: "inferred"
        });
        row = endRow;
        continue;
      }
    }

    for (const segment of bareBracketSegments(line, codeRanges)) {
      const [startCol, endCol] = visualEnd(line, segment.start, segment.end);
      regions.push({
        startRow: row,
        endRow: row,
        startCol,
        endCol,
        latex: segment.body,
        display: true,
        confidence: "inferred"
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
    const inferredSegments = inferredParenthesizedMath(line);
    for (const segment of inferredSegments) {
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

    if (!loneDefinition
      && inferredSegments.length === 0
      && !adjacentToStandaloneDelimiter(lines, row)
      && !isStandaloneDisplayEnvironmentToken(trimmed)
      && isLikelyStandaloneMath(trimmed)) {
      const start = line.indexOf(trimmed);
      regions.push(trailingInlineRegion(
        lines,
        row,
        line,
        start,
        start + trimmed.length,
        trimmed,
        "inferred"
      ));
    }
  }

  const expanded = expandStandaloneDisplayRegions(lines, regions);
  const contains = (container: FormulaRegion, candidate: FormulaRegion): boolean =>
    container.startRow <= candidate.startRow
    && container.endRow >= candidate.endRow
    && (container.startRow !== candidate.startRow || container.startCol <= candidate.startCol)
    && (container.endRow !== candidate.endRow || container.endCol >= candidate.endCol);

  // Explicit multi-row regions are detected before the per-row compatibility
  // pass. Remove only candidates genuinely inside them: formulas before an
  // opener or after a closer on the same physical rows must remain visible.
  return expanded.filter((candidate, index) => !expanded.some((container, containerIndex) => {
    if (containerIndex === index || !contains(container, candidate)) return false;
    const sameBounds = container.startRow === candidate.startRow
      && container.endRow === candidate.endRow
      && container.startCol === candidate.startCol
      && container.endCol === candidate.endCol;
    if (sameBounds) {
      if (container.display !== candidate.display) return container.display;
      if (container.confidence !== candidate.confidence) {
        return container.confidence === "explicit";
      }
      return container.latex === candidate.latex && containerIndex < index;
    }
    if (container.compact && container.startRow < container.endRow) return true;
    if (container.display) return true;
    return container.confidence === "explicit" && candidate.confidence === "inferred";
  }));
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
