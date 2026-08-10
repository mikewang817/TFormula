import stringWidth from "string-width";
import type { DetectedFormula, FormulaIntent } from "./types.js";

/** Internal semantic candidate used while detection passes merge and filter spans. */
interface SemanticFormulaCandidate {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
  latex: string;
  display: boolean;
  confidence: "explicit" | "inferred";
  compact?: boolean;
}


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

export const MAX_DISPLAY_BLOCK_ROWS = 256;
const FORMULA_TRIGGER_RE = /[\\$()[\]^_=<>+*/-]|[^\x00-\x7f]/u;

export function containsFormulaTrigger(value: string): boolean {
  return FORMULA_TRIGGER_RE.test(value);
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

// Only concatenate a terminal hard row when its two letter runs make one of
// the TeX control words TFormula supports. This repairs `\\varep` + `silon`
// without corrupting an already-complete command such as `\\qquad` followed
// by the next equation line.
const TEX_CONTROL_WORDS = new Set([
  "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta", "theta",
  "vartheta", "iota", "kappa", "lambda", "mu", "nu", "xi", "pi", "varpi", "rho",
  "varrho", "sigma", "varsigma", "tau", "upsilon", "phi", "varphi", "chi", "psi", "omega",
  "Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Upsilon", "Phi", "Psi", "Omega",
  "begin", "end", "frac", "dfrac", "tfrac", "binom", "dbinom", "tbinom", "sqrt",
  "sum", "prod", "coprod", "int", "iint", "iiint", "oint", "lim", "sin", "cos", "tan",
  "log", "ln", "exp", "min", "max", "sup", "inf", "det", "gcd", "text", "mathrm",
  "mathbf", "mathit", "mathbb", "mathcal", "mathfrak", "mathsf", "mathtt", "operatorname",
  "left", "right", "middle", "quad", "qquad", "enspace", "thinspace", "negthinspace",
  "medspace", "thickspace", "displaystyle", "textstyle", "scriptstyle", "scriptscriptstyle",
  "overline", "underline", "overbrace", "underbrace", "lVert", "rVert", "lvert", "rvert",
  "cdot", "times", "div", "pm", "mp", "leq", "geq", "neq", "approx", "sim", "simeq",
  "equiv", "propto", "partial", "nabla", "infty", "forall", "exists", "in", "notin",
  "subset", "subseteq", "supset", "supseteq", "cup", "cap", "land", "lor", "neg", "to",
  "rightarrow", "leftarrow", "leftrightarrow", "Rightarrow", "Leftarrow", "Leftrightarrow"
]);

function shouldJoinHardWrappedToken(left: string, right: string): boolean {
  if (!left || !right) return false;
  // Soft-wrapped terminal rows are already reassembled before detection.
  // Across genuine terminal lines, TeX treats the newline after a control
  // word as its terminator. Joining an unrecognised word to the next line
  // turns valid source such as `\qquad` followed by `y` into `\qquady`.
  // The one unambiguous recovery case is a lone trailing slash, which can
  // only be the first half of a control sequence at this boundary.
  if (hasOddTrailingBackslash(left)) return true;
  const command = left.match(/\\([A-Za-z]+)$/u)?.[1];
  const continuation = right.match(/^([A-Za-z]+)/u)?.[1];
  if (!command || !continuation) return false;
  const joined = command + continuation;
  return Array.from(TEX_CONTROL_WORDS).some((word) =>
    word.length > command.length && word.startsWith(command) && joined.startsWith(word)
  );
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

/** A Markdown renderer may reduce TeX's `\\[2pt]` row break to `\[2pt]`. */
function isStrippedRowSpacingAt(line: string, index: number): boolean {
  return /^\\\[\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*(?:pt|pc|in|bp|cm|mm|dd|cc|sp|em|ex|mu)\s*\]/u
    .test(line.slice(index));
}

function slashDelimitedRegions(
  lines: string[],
  contexts: DetectionLineContext[],
  opening: "\\(" | "\\[",
  closing: "\\)" | "\\]",
  display: boolean
): SemanticFormulaCandidate[] {
  const regions: SemanticFormulaCandidate[] = [];
  let pending: DelimiterPosition | undefined;

  for (let row = 0; row < lines.length; row += 1) {
    const context = contexts[row]!;
    if (context.inCodeFence) {
      pending = undefined;
      continue;
    }
    const events = [
      ...unescapedTokenPositions(lines[row] ?? "", opening, context)
        .filter((index) => opening !== "\\["
          || !isStrippedRowSpacingAt(lines[row] ?? "", index))
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
): SemanticFormulaCandidate[] {
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

  const regions: SemanticFormulaCandidate[] = [];
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

/** A delimited outer display must not hide an incomplete nested environment. */
function hasUnclosedDisplayEnvironment(latex: string): boolean {
  const stack: string[] = [];
  const pattern = /\\(begin|end)\{([A-Za-z]+\*?)\}/gu;
  for (const match of latex.matchAll(pattern)) {
    const name = match[2]!;
    if (!DISPLAY_ENVIRONMENTS.has(name)) continue;
    if (match[1] === "begin") {
      stack.push(name);
    } else if (stack.at(-1) === name) {
      stack.pop();
    } else {
      return true;
    }
  }
  return stack.length > 0;
}

interface DollarPair {
  start: DelimiterPosition;
  end: DelimiterPosition;
  latex: string;
  quality: number;
  span: number;
}

function isValidSingleDollarPair(
  lines: string[],
  start: DelimiterPosition,
  end: DelimiterPosition
): boolean {
  const openingNext = (lines[start.row] ?? "")[start.index + 1];
  const closingPrevious = (lines[end.row] ?? "")[end.index - 1];
  return Boolean(openingNext && closingPrevious
    && !/\s/u.test(openingNext)
    && !/\s/u.test(closingPrevious));
}

function dollarDelimitedRegions(
  lines: string[],
  contexts: DetectionLineContext[],
  delimiter: "$" | "$$",
  display: boolean
): SemanticFormulaCandidate[] {
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
    if (!latex || (!display && !isValidSingleDollarPair(lines, start, end))) continue;
    candidates[index] = {
      start,
      end,
      latex,
      quality: latex.length,
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
): SemanticFormulaCandidate | undefined {
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

function trailingInlineRegion(
  lines: string[],
  row: number,
  line: string,
  startIndex: number,
  endIndex: number,
  latex: string,
  confidence: SemanticFormulaCandidate["confidence"]
): SemanticFormulaCandidate {
  const suffix = line.slice(endIndex);
  const trailing = suffix.match(/^([.,;:!?，。；：！？]?)\s*$/u);
  let regionEndIndex = endIndex;
  let regionLatex = latex;
  let compact = false;

  if (trailing) {
    const punctuation = trailing[1] ?? "";
    if (punctuation) {
      regionLatex += `\\text{${escapeTexText(punctuation)}}`;
      regionEndIndex += punctuation.length;
    }
    compact = true;
  }

  const [startCol, endCol] = visualEnd(line, startIndex, regionEndIndex);
  return {
    startRow: row,
    endRow: row,
    startCol,
    endCol,
    latex: regionLatex,
    display: false,
    confidence,
    ...(compact ? { compact: true } : {})
  };
}

function firstNonWhitespaceColumn(line: string): number {
  const index = line.search(/\S/u);
  return index < 0 ? 0 : stringWidth(line.slice(0, index));
}

/** Classify semantic intent before terminal-cell layout is considered. */
export function classifyFormulaIntent(
  region: SemanticFormulaCandidate,
  lines: string[]
): FormulaIntent {
  if (!region.display) return "inline";
  const firstLine = lines[region.startRow] ?? "";
  const lastLine = lines[region.endRow] ?? "";
  const ownsFirstLineStart = region.startCol <= firstNonWhitespaceColumn(firstLine);
  const ownsLastLineEnd = region.endCol >= stringWidth(lastLine.trimEnd());
  return ownsFirstLineStart && ownsLastLineEnd ? "display" : "embedded-display";
}

/** Detect explicit TeX formulas in the post-ANSI terminal screen. */
export function detectFormulas(lines: string[]): DetectedFormula[] {
  if (!lines.some(containsFormulaTrigger)) return [];
  const contexts = detectionLineContexts(lines);
  const regions: SemanticFormulaCandidate[] = [
    ...environmentRegions(lines, contexts),
    ...slashDelimitedRegions(lines, contexts, "\\[", "\\]", true),
    ...slashDelimitedRegions(lines, contexts, "\\(", "\\)", false),
    ...dollarDelimitedRegions(lines, contexts, "$$", true),
    ...dollarDelimitedRegions(lines, contexts, "$", false)
  ].filter((region) => !hasUnclosedDisplayEnvironment(region.latex));
  const contains = (container: SemanticFormulaCandidate, candidate: SemanticFormulaCandidate): boolean =>
    container.startRow <= candidate.startRow
    && container.endRow >= candidate.endRow
    && (container.startRow !== candidate.startRow || container.startCol <= candidate.startCol)
    && (container.endRow !== candidate.endRow || container.endCol >= candidate.endCol);

  return regions
    .filter((candidate, index) => !regions.some((container, containerIndex) => {
      if (containerIndex === index || !contains(container, candidate)) return false;
      const sameBounds = container.startRow === candidate.startRow
        && container.endRow === candidate.endRow
        && container.startCol === candidate.startCol
        && container.endCol === candidate.endCol;
      if (sameBounds) {
        return container.display !== candidate.display
          ? container.display
          : container.latex === candidate.latex && containerIndex < index;
      }
      return container.compact && container.startRow < container.endRow || container.display;
    }))
    .map((region) => ({
      source: {
        startRow: region.startRow,
        endRow: region.endRow,
        startCol: region.startCol,
        endCol: region.endCol
      },
      latex: region.latex,
      intent: classifyFormulaIntent(region, lines),
      confidence: region.confidence,
      ...(region.compact ? { compact: true } : {})
    }));
}

export const detectorInternals = {
  classifyFormulaIntent,
  dollarDelimiterPositions,
  dollarDelimitedSegments,
  escapeTexText,
  hardWrappedDollarDisplay,
  inlineCodeRanges,
  isStandaloneDisplayLine,
  trailingInlineRegion,
  visualColumn
};
