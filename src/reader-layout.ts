import type {
  Definition,
  List,
  ListItem,
  PhrasingContent,
  RootContent,
  Table
} from "mdast";
import stringWidth from "string-width";
import type { CellMetrics } from "./types.js";
import {
  mathResourceKey,
  type MathResource,
  type ReaderDocument
} from "./reader-document.js";

export type ReaderColor = "accent" | "muted" | "link" | "code" | "quote" | "warning";

export interface ReaderStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  dim?: boolean;
  inverse?: boolean;
  color?: ReaderColor;
  background?: "code";
  href?: string;
}

export interface StyledSpan {
  text: string;
  style?: ReaderStyle;
}

export interface ReaderImageAsset {
  kind: "image";
  key: string;
  path: string;
  width: number;
  height: number;
  size?: number;
  mtimeMs?: number;
  /** Geometry required to resize image placeholders without reflowing Markdown. */
  availableColumns?: number;
  prefixColumns?: number;
}

export interface ReaderMathAsset {
  kind: "math";
  key: string;
  latex: string;
  display: boolean;
}

export type ReaderAsset = ReaderImageAsset | ReaderMathAsset;

export interface ReaderPlacement {
  row: number;
  col: number;
  columns: number;
  rows: number;
  asset: ReaderAsset;
}

export interface ReaderLine {
  spans: StyledSpan[];
  plain: string;
}

export interface ReaderHeading {
  line: number;
  depth: number;
  text: string;
}

export interface ReaderLink {
  line: number;
  col: number;
  columns: number;
  href: string;
  label: string;
}

export interface ReaderLayout {
  lines: ReaderLine[];
  /** Lines pinned above the vertically scrolling body (used by grid documents). */
  stickyLines?: ReaderLine[];
  placements: ReaderPlacement[];
  headings: ReaderHeading[];
  links: ReaderLink[];
  contentWidth: number;
  left: number;
}

export interface ReaderLayoutOptions {
  columns: number;
  viewportRows: number;
  cell: CellMetrics;
  scale: number;
  /** Multiplier relative to the image's automatic fit size. */
  imageScale?: number;
  graphics: boolean;
}

interface InlineTextAtom {
  kind: "text";
  text: string;
  style?: ReaderStyle;
}

interface InlineBreakAtom {
  kind: "break";
}

interface InlineMathAtom {
  kind: "math";
  latex: string;
  columns: number;
  key: string;
}

type InlineAtom = InlineTextAtom | InlineBreakAtom | InlineMathAtom;

interface WrappedLine {
  spans: StyledSpan[];
  placements: Array<Omit<ReaderPlacement, "row" | "col"> & { col: number }>;
}

interface BlockContext {
  indent: number;
  quoteDepth: number;
}

const EMPTY_CONTEXT: BlockContext = { indent: 0, quoteDepth: 0 };
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

interface MathDimensions {
  aspectRatio: number;
  heightEx: number;
}

/** Fast, conservative geometry used until a formula first enters the viewport. */
export function estimateMathDimensions(latex: string, display: boolean): MathDimensions {
  const structuralHeight = /\\(?:d?frac|binom|cases|matrix|substack)\b|\\begin\s*\{/u.test(latex)
    ? 3.4
    : /\\(?:sum|prod|int|lim)\b|[_^]\s*\{/u.test(latex)
      ? 2.7
      : 2;
  const heightEx = display ? Math.max(2.4, structuralHeight) : Math.min(2.8, structuralHeight);
  const visible = latex
    .replace(/\\(?:left|right|displaystyle|textstyle|limits|nolimits)\b/gu, "")
    .replace(/\\(?:quad|qquad)\b/gu, "  ")
    .replace(/\\(?:,|;|!| )/gu, " ")
    .replace(/\\[A-Za-z]+/gu, "x")
    .replace(/[{}_^&]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const widthEx = Math.max(1.25, Math.min(120, stringWidth(visible || "x") * 1.05));
  return { aspectRatio: widthEx / heightEx, heightEx };
}

function resolvedMathDimensions(
  resource: MathResource | undefined,
  latex: string,
  display: boolean
): MathDimensions {
  return resource?.aspectRatio && resource.heightEx
    ? { aspectRatio: resource.aspectRatio, heightEx: resource.heightEx }
    : estimateMathDimensions(latex, display);
}

interface ReaderImageGeometry {
  columns: number;
  rows: number;
  col: number;
}

export function readerImageGeometry(options: {
  width: number;
  height: number;
  availableColumns: number;
  prefixColumns: number;
  viewportRows: number;
  cell: CellMetrics;
  imageScale?: number;
}): ReaderImageGeometry {
  const availableColumns = Math.max(1, Math.floor(options.availableColumns));
  const maximumRows = Math.max(2, Math.floor(options.viewportRows) - 3);
  const availableWidthPx = availableColumns * options.cell.width;
  const availableHeightPx = maximumRows * options.cell.height;
  const fitScale = Math.min(
    1,
    availableWidthPx / options.width,
    availableHeightPx / options.height
  );
  const imageScale = Number.isFinite(options.imageScale)
    ? Math.max(0.25, Math.min(3, options.imageScale!))
    : 1;
  const renderedScale = Math.min(
    fitScale * imageScale,
    availableWidthPx / options.width
  );
  const columns = Math.max(1, Math.min(
    availableColumns,
    Math.ceil(options.width * renderedScale / options.cell.width)
  ));
  const rows = Math.max(1, Math.ceil(
    options.height * renderedScale / options.cell.height
  ));
  return {
    columns,
    rows,
    col: options.prefixColumns + Math.max(0, Math.floor((availableColumns - columns) / 2))
  };
}

function sanitizeText(value: string): string {
  return value
    .replaceAll("\t", "    ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "�");
}

function styleKey(style: ReaderStyle | undefined): string {
  if (!style) return "";
  return [
    style.bold ? "b" : "",
    style.italic ? "i" : "",
    style.underline ? "u" : "",
    style.strike ? "s" : "",
    style.dim ? "d" : "",
    style.inverse ? "v" : "",
    style.color ?? "",
    style.background ?? "",
    style.href ?? ""
  ].join("|");
}

function appendSpan(spans: StyledSpan[], text: string, style?: ReaderStyle): void {
  if (!text) return;
  const previous = spans.at(-1);
  if (previous && styleKey(previous.style) === styleKey(style)) previous.text += text;
  else spans.push(style ? { text, style } : { text });
}

function mergeStyle(base: ReaderStyle | undefined, extra: ReaderStyle): ReaderStyle {
  return { ...base, ...extra };
}

function graphemes(value: string): string[] {
  return Array.from(segmenter.segment(value), ({ segment }) => segment);
}

function splitByColumns(value: string, width: number): string[] {
  const chunks: string[] = [];
  let chunk = "";
  let columns = 0;
  for (const glyph of graphemes(value)) {
    const glyphWidth = stringWidth(glyph);
    if (chunk && columns + glyphWidth > width) {
      chunks.push(chunk);
      chunk = "";
      columns = 0;
    }
    chunk += glyph;
    columns += glyphWidth;
  }
  if (chunk || chunks.length === 0) chunks.push(chunk);
  return chunks;
}

function truncateColumns(value: string, width: number): string {
  if (width <= 0) return "";
  if (stringWidth(value) <= width) return value;
  if (width === 1) return "…";
  let output = "";
  let columns = 0;
  for (const glyph of graphemes(value)) {
    const glyphWidth = stringWidth(glyph);
    if (columns + glyphWidth > width - 1) break;
    output += glyph;
    columns += glyphWidth;
  }
  return `${output}…`;
}

function padColumns(value: string, width: number, align: "left" | "center" | "right" = "left"): string {
  const clipped = truncateColumns(value, width);
  const padding = Math.max(0, width - stringWidth(clipped));
  if (align === "right") return `${" ".repeat(padding)}${clipped}`;
  if (align === "center") {
    const left = Math.floor(padding / 2);
    return `${" ".repeat(left)}${clipped}${" ".repeat(padding - left)}`;
  }
  return `${clipped}${" ".repeat(padding)}`;
}

function plainInline(nodes: PhrasingContent[]): string {
  let output = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text":
      case "inlineCode":
      case "inlineMath":
        output += node.value;
        break;
      case "break":
        output += " ";
        break;
      case "image":
        output += node.alt || "image";
        break;
      case "footnoteReference":
        output += `[^${node.label ?? node.identifier}]`;
        break;
      default:
        if ("children" in node) output += plainInline(node.children as PhrasingContent[]);
    }
  }
  return sanitizeText(output).replace(/\s+/gu, " ").trim();
}

function stripHtml(value: string): string {
  return sanitizeText(value.replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").trim());
}

function wrapInline(atoms: InlineAtom[], width: number): WrappedLine[] {
  const safeWidth = Math.max(1, width);
  const lines: WrappedLine[] = [{ spans: [], placements: [] }];
  let line = lines[0]!;
  let column = 0;

  const nextLine = (): void => {
    line = { spans: [], placements: [] };
    lines.push(line);
    column = 0;
  };
  const addText = (text: string, style?: ReaderStyle): void => {
    appendSpan(line.spans, text, style);
    column += stringWidth(text);
  };

  for (const atom of atoms) {
    if (atom.kind === "break") {
      nextLine();
      continue;
    }
    if (atom.kind === "math") {
      const columns = Math.min(safeWidth, Math.max(1, atom.columns));
      if (column > 0 && column + columns > safeWidth) nextLine();
      line.placements.push({
        col: column,
        columns,
        rows: 1,
        asset: {
          kind: "math",
          key: atom.key,
          latex: atom.latex,
          display: false
        }
      });
      addText(" ".repeat(columns));
      continue;
    }

    const normalized = sanitizeText(atom.text).replace(/[ \t\r\n]+/gu, " ");
    const tokens = normalized.match(/\s+|\S+/gu) ?? [];
    for (const token of tokens) {
      if (/^\s+$/u.test(token)) {
        if (column > 0 && column < safeWidth) addText(" ", atom.style);
        continue;
      }
      const tokenWidth = stringWidth(token);
      if (tokenWidth <= safeWidth) {
        if (column > 0 && column + tokenWidth > safeWidth) nextLine();
        addText(token, atom.style);
        continue;
      }
      for (const chunk of splitByColumns(token, safeWidth)) {
        const chunkWidth = stringWidth(chunk);
        if (column > 0 && column + chunkWidth > safeWidth) nextLine();
        addText(chunk, atom.style);
        if (column >= safeWidth) nextLine();
      }
    }
  }
  if (lines.length > 1 && lines.at(-1)?.spans.length === 0 && lines.at(-1)?.placements.length === 0) {
    lines.pop();
  }
  return lines;
}

class LayoutBuilder {
  readonly lines: ReaderLine[] = [];
  readonly placements: ReaderPlacement[] = [];
  readonly headings: ReaderHeading[] = [];
  readonly links: ReaderLink[] = [];
  readonly definitions = new Map<string, Definition>();
  readonly contentWidth: number;
  readonly left: number;

  constructor(
    readonly document: ReaderDocument,
    readonly options: ReaderLayoutOptions
  ) {
    const terminalWidth = Math.max(2, Math.floor(options.columns));
    this.contentWidth = Math.max(1, Math.min(100, terminalWidth >= 24 ? terminalWidth - 4 : terminalWidth - 1));
    this.left = Math.max(0, Math.floor((terminalWidth - this.contentWidth) / 2));
    for (const node of document.root.children) {
      if (node.type === "definition") this.definitions.set(node.identifier, node);
    }
  }

  commonPrefix(context: BlockContext): StyledSpan[] {
    const spans: StyledSpan[] = [];
    appendSpan(spans, " ".repeat(this.left));
    for (let index = 0; index < context.quoteDepth; index += 1) {
      appendSpan(spans, "│", { color: "quote", bold: true });
      appendSpan(spans, " ");
    }
    appendSpan(spans, " ".repeat(context.indent));
    return spans;
  }

  available(context: BlockContext): number {
    return Math.max(1, this.contentWidth - context.indent - context.quoteDepth * 2);
  }

  append(spans: StyledSpan[], placements: WrappedLine["placements"] = []): void {
    const row = this.lines.length;
    const plain = spans.map(({ text }) => text).join("");
    this.lines.push({ spans, plain });
    let column = 0;
    let activeLink: ReaderLink | undefined;
    for (const span of spans) {
      const width = stringWidth(span.text);
      const href = span.style?.href;
      if (href && activeLink?.href === href && activeLink.col + activeLink.columns === column) {
        activeLink.columns += width;
        activeLink.label += span.text;
      } else {
        activeLink = href
          ? { line: row, col: column, columns: width, href, label: span.text }
          : undefined;
        if (activeLink) this.links.push(activeLink);
      }
      column += width;
    }
    for (const placement of placements) {
      this.placements.push({ ...placement, row, col: placement.col });
    }
  }

  blank(): void {
    if (this.lines.length === 0 || this.lines.at(-1)?.plain === "") return;
    this.lines.push({ spans: [], plain: "" });
  }

  appendWrapped(
    atoms: InlineAtom[],
    context: BlockContext,
    marker = "",
    markerStyle?: ReaderStyle
  ): void {
    const markerWidth = stringWidth(marker);
    const available = Math.max(1, this.available(context) - markerWidth);
    const wrapped = wrapInline(atoms, available);
    for (let index = 0; index < wrapped.length; index += 1) {
      const prefix = this.commonPrefix(context);
      const actualMarker = index === 0 ? marker : " ".repeat(markerWidth);
      appendSpan(prefix, actualMarker, markerStyle);
      const baseColumn = stringWidth(prefix.map(({ text }) => text).join(""));
      const line = wrapped[index]!;
      this.append(
        [...prefix, ...line.spans],
        line.placements.map((placement) => ({ ...placement, col: baseColumn + placement.col }))
      );
    }
  }

  inlineAtoms(nodes: PhrasingContent[], style?: ReaderStyle): InlineAtom[] {
    const atoms: InlineAtom[] = [];
    const visit = (children: PhrasingContent[], inherited?: ReaderStyle): void => {
      for (const node of children) {
        switch (node.type) {
          case "text":
            atoms.push({ kind: "text", text: node.value, style: inherited });
            break;
          case "strong":
            visit(node.children, mergeStyle(inherited, { bold: true }));
            break;
          case "emphasis":
            visit(node.children, mergeStyle(inherited, { italic: true }));
            break;
          case "delete":
            visit(node.children, mergeStyle(inherited, { strike: true, dim: true }));
            break;
          case "inlineCode":
            atoms.push({
              kind: "text",
              text: ` ${node.value} `,
              style: mergeStyle(inherited, { color: "code", background: "code" })
            });
            break;
          case "break":
            atoms.push({ kind: "break" });
            break;
          case "link":
            visit(node.children, mergeStyle(inherited, {
              color: "link",
              underline: true,
              href: node.url
            }));
            break;
          case "linkReference": {
            const definition = this.definitions.get(node.identifier);
            visit(node.children, mergeStyle(inherited, {
              color: "link",
              underline: true,
              href: definition?.url
            }));
            break;
          }
          case "image":
            atoms.push({
              kind: "text",
              text: `[image: ${node.alt || node.url}]`,
              style: mergeStyle(inherited, { color: "muted", italic: true })
            });
            break;
          case "imageReference": {
            const definition = this.definitions.get(node.identifier);
            atoms.push({
              kind: "text",
              text: `[image: ${node.alt || definition?.url || node.identifier}]`,
              style: mergeStyle(inherited, { color: "muted", italic: true })
            });
            break;
          }
          case "inlineMath": {
            const key = mathResourceKey(node.value, false);
            const resource = this.document.math.get(key);
            if (!this.options.graphics || resource?.error) {
              atoms.push({
                kind: "text",
                text: `$${node.value}$`,
                style: mergeStyle(inherited, { color: "warning" })
              });
              break;
            }
            const dimensions = resolvedMathDimensions(resource, node.value, false);
            const heightPx = dimensions.heightEx * this.options.cell.height
              * 0.45 * this.options.scale;
            const widthPx = heightPx * dimensions.aspectRatio;
            atoms.push({
              kind: "math",
              latex: node.value,
              columns: Math.max(1, Math.ceil(widthPx / this.options.cell.width) + 1),
              key
            });
            break;
          }
          case "footnoteReference":
            atoms.push({
              kind: "text",
              text: `[^${node.label ?? node.identifier}]`,
              style: mergeStyle(inherited, { color: "link", underline: true })
            });
            break;
          default:
            if ("children" in node) visit(node.children as PhrasingContent[], inherited);
        }
      }
    };
    visit(nodes, style);
    return atoms;
  }

  renderParagraph(
    node: Extract<RootContent, { type: "paragraph" }>,
    context: BlockContext,
    marker = "",
    addBlank = true
  ): void {
    if (node.children.length === 1 && node.children[0]?.type === "image") {
      this.renderImage(node.children[0], context);
      if (addBlank) this.blank();
      return;
    }
    if (node.children.length === 1 && node.children[0]?.type === "imageReference") {
      const reference = node.children[0];
      const definition = this.definitions.get(reference.identifier);
      if (definition) {
        this.renderImage({
          type: "image",
          url: definition.url,
          title: definition.title,
          alt: reference.alt
        }, context);
        if (addBlank) this.blank();
        return;
      }
    }
    this.appendWrapped(this.inlineAtoms(node.children), context, marker, {
      color: "accent",
      bold: true
    });
    if (addBlank) this.blank();
  }

  renderImage(image: Extract<PhrasingContent, { type: "image" }>, context: BlockContext): void {
    const resource = this.document.images.get(image.url);
    if (!this.options.graphics || !resource?.path || !resource.width || !resource.height
      || resource.error) {
      const detail = resource?.error ? ` — ${resource.error}` : "";
      const dimensions = resource?.width && resource.height
        ? ` (${resource.width}×${resource.height})`
        : "";
      this.appendWrapped([{
        kind: "text",
        text: `[Image: ${image.alt || image.url}${dimensions}${detail}]`,
        style: { color: resource?.error ? "warning" : "muted", italic: true }
      }], context);
      return;
    }
    const availableColumns = this.available(context);
    const common = this.commonPrefix(context);
    const commonColumns = stringWidth(common.map(({ text }) => text).join(""));
    const geometry = readerImageGeometry({
      width: resource.width,
      height: resource.height,
      availableColumns,
      prefixColumns: commonColumns,
      viewportRows: this.options.viewportRows,
      cell: this.options.cell,
      imageScale: this.options.imageScale
    });
    const startRow = this.lines.length;
    for (let row = 0; row < geometry.rows; row += 1) this.append([...common]);
    this.placements.push({
      row: startRow,
      col: geometry.col,
      columns: geometry.columns,
      rows: geometry.rows,
      asset: {
        kind: "image",
        key: `image\0${resource.path}`,
        path: resource.path,
        width: resource.width,
        height: resource.height,
        size: resource.size,
        mtimeMs: resource.mtimeMs,
        availableColumns,
        prefixColumns: commonColumns
      }
    });
    if (image.alt) {
      const caption = truncateColumns(image.alt, availableColumns);
      const captionOffset = Math.max(0, Math.floor((availableColumns - stringWidth(caption)) / 2));
      this.append([
        ...common,
        { text: " ".repeat(captionOffset) },
        { text: caption, style: { color: "muted", italic: true, dim: true } }
      ]);
    }
  }

  renderMath(node: Extract<RootContent, { type: "math" }>, context: BlockContext): void {
    const key = mathResourceKey(node.value, true);
    const resource = this.document.math.get(key);
    if (!this.options.graphics || resource?.error) {
      this.appendWrapped([{
        kind: "text",
        text: `$$ ${node.value} $$`,
        style: { color: "warning" }
      }], context);
      return;
    }
    const dimensions = resolvedMathDimensions(resource, node.value, true);
    const availableColumns = this.available(context);
    const naturalHeight = dimensions.heightEx * this.options.cell.height
      * 0.45 * this.options.scale;
    const naturalWidth = naturalHeight * dimensions.aspectRatio;
    const columns = Math.max(2, Math.min(availableColumns,
      Math.ceil(naturalWidth / this.options.cell.width) + 2));
    const rows = Math.max(2, Math.min(6, Math.ceil(naturalHeight / this.options.cell.height) + 1));
    const common = this.commonPrefix(context);
    const commonColumns = stringWidth(common.map(({ text }) => text).join(""));
    const offset = Math.max(0, Math.floor((availableColumns - columns) / 2));
    const startRow = this.lines.length;
    for (let row = 0; row < rows; row += 1) this.append([...common]);
    this.placements.push({
      row: startRow,
      col: commonColumns + offset,
      columns,
      rows,
      asset: { kind: "math", key, latex: node.value, display: true }
    });
  }

  renderHeading(node: Extract<RootContent, { type: "heading" }>, context: BlockContext): void {
    this.blank();
    const line = this.lines.length;
    const text = plainInline(node.children);
    this.headings.push({ line, depth: node.depth, text });
    const style: ReaderStyle = node.depth <= 2
      ? { bold: true, color: "accent" }
      : { bold: true };
    this.appendWrapped(this.inlineAtoms(node.children, style), context);
    if (node.depth === 1) {
      const prefix = this.commonPrefix(context);
      appendSpan(prefix, "━".repeat(this.available(context)), { color: "accent", dim: true });
      this.append(prefix);
    }
    this.blank();
  }

  renderCode(node: Extract<RootContent, { type: "code" }>, context: BlockContext): void {
    const available = this.available(context);
    if (available < 8) {
      for (const line of node.value.split("\n")) {
        this.appendWrapped([{
          kind: "text",
          text: line || " ",
          style: { color: "code", background: "code" }
        }], context);
      }
      this.blank();
      return;
    }
    const innerWidth = available - 4;
    const language = sanitizeText(node.lang ?? "");
    const label = language ? ` ${truncateColumns(language, Math.max(1, innerWidth - 2))} ` : "";
    const topFill = Math.max(0, available - 2 - stringWidth(label));
    const prefix = this.commonPrefix(context);
    this.append([
      ...prefix,
      { text: `╭${label}${"─".repeat(topFill)}╮`, style: { color: "muted", dim: true } }
    ]);
    const sourceLines = node.value.split("\n");
    for (const sourceLine of sourceLines) {
      const chunks = splitByColumns(sanitizeText(sourceLine), innerWidth);
      for (const chunk of chunks) {
        this.append([
          ...prefix,
          { text: "│", style: { color: "muted", dim: true } },
          { text: ` ${padColumns(chunk, innerWidth)} `, style: { color: "code", background: "code" } },
          { text: "│", style: { color: "muted", dim: true } }
        ]);
      }
    }
    this.append([
      ...prefix,
      { text: `╰${"─".repeat(available - 2)}╯`, style: { color: "muted", dim: true } }
    ]);
    this.blank();
  }

  renderTable(node: Table, context: BlockContext): void {
    const rows = node.children.map((row) => row.children.map((cell) => plainInline(cell.children)));
    const columnCount = Math.max(0, ...rows.map((row) => row.length));
    const available = this.available(context);
    if (columnCount === 0) return;
    const cellBudget = available - columnCount - 1;
    if (cellBudget < columnCount * 3) {
      for (const [index, row] of rows.entries()) {
        this.appendWrapped([{
          kind: "text",
          text: row.join(" · "),
          style: index === 0 ? { bold: true, color: "accent" } : undefined
        }], context);
      }
      this.blank();
      return;
    }
    const widths = Array.from({ length: columnCount }, (_, column) => Math.max(
      3,
      Math.min(30, Math.max(...rows.map((row) => stringWidth(row[column] ?? ""))))
    ));
    while (widths.reduce((sum, value) => sum + value, 0) > cellBudget) {
      const largest = Math.max(...widths);
      const index = widths.findIndex((value) => value === largest && value > 3);
      if (index < 0) break;
      widths[index]! -= 1;
    }
    const prefix = this.commonPrefix(context);
    const border = (left: string, middle: string, right: string): void => {
      this.append([
        ...prefix,
        {
          text: `${left}${widths.map((width) => "─".repeat(width)).join(middle)}${right}`,
          style: { color: "muted", dim: true }
        }
      ]);
    };
    border("┌", "┬", "┐");
    for (const [rowIndex, row] of rows.entries()) {
      const spans = [...prefix];
      appendSpan(spans, "│", { color: "muted", dim: true });
      for (let column = 0; column < columnCount; column += 1) {
        const alignment = node.align?.[column] ?? "left";
        appendSpan(spans, padColumns(
          row[column] ?? "",
          widths[column]!,
          alignment === "center" || alignment === "right" ? alignment : "left"
        ), rowIndex === 0 ? { bold: true, color: "accent" } : undefined);
        appendSpan(spans, "│", { color: "muted", dim: true });
      }
      this.append(spans);
      if (rowIndex === 0 && rows.length > 1) border("├", "┼", "┤");
    }
    border("└", "┴", "┘");
    this.blank();
  }

  renderList(node: List, context: BlockContext): void {
    for (const [index, item] of node.children.entries()) {
      const number = (node.start ?? 1) + index;
      const task = item.checked === true ? "☑ " : item.checked === false ? "☐ " : "";
      const marker = task || (node.ordered ? `${number}. ` : "• ");
      this.renderListItem(item, context, marker);
      if (node.spread || item.spread) this.blank();
    }
    this.blank();
  }

  renderListItem(item: ListItem, context: BlockContext, marker: string): void {
    const first = item.children[0];
    if (first?.type === "paragraph") this.renderParagraph(first, context, marker, false);
    else {
      this.appendWrapped([], context, marker, { color: "accent", bold: true });
      if (first) this.renderBlock(first, {
        ...context,
        indent: context.indent + stringWidth(marker)
      });
    }
    const nestedContext = { ...context, indent: context.indent + stringWidth(marker) };
    for (const child of item.children.slice(1)) this.renderBlock(child, nestedContext);
  }

  renderBlock(node: RootContent, context: BlockContext): void {
    switch (node.type) {
      case "heading":
        this.renderHeading(node, context);
        break;
      case "paragraph":
        this.renderParagraph(node, context);
        break;
      case "code":
        this.renderCode(node, context);
        break;
      case "math":
        this.renderMath(node, context);
        this.blank();
        break;
      case "blockquote":
        for (const child of node.children) {
          this.renderBlock(child, { ...context, quoteDepth: context.quoteDepth + 1 });
        }
        this.blank();
        break;
      case "list":
        this.renderList(node, context);
        break;
      case "table":
        this.renderTable(node, context);
        break;
      case "thematicBreak": {
        const prefix = this.commonPrefix(context);
        appendSpan(prefix, "─".repeat(this.available(context)), { color: "muted", dim: true });
        this.append(prefix);
        this.blank();
        break;
      }
      case "html": {
        const text = stripHtml(node.value);
        if (text) this.appendWrapped([{ kind: "text", text, style: { color: "muted" } }], context);
        this.blank();
        break;
      }
      case "footnoteDefinition":
        for (const [index, child] of node.children.entries()) {
          if (index === 0 && child.type === "paragraph") {
            this.renderParagraph(child, context, `[^${node.label ?? node.identifier}] `, false);
          } else this.renderBlock(child, { ...context, indent: context.indent + 2 });
        }
        this.blank();
        break;
      case "definition":
      case "yaml":
        break;
      default:
        break;
    }
  }

  finish(): ReaderLayout {
    while (this.lines.at(-1)?.plain === "") this.lines.pop();
    if (this.lines.length === 0) this.lines.push({ spans: [], plain: "" });
    return {
      lines: this.lines,
      placements: this.placements.filter((placement) => placement.row < this.lines.length),
      headings: this.headings,
      links: this.links.filter((link) => link.line < this.lines.length),
      contentWidth: this.contentWidth,
      left: this.left
    };
  }
}

export function layoutReaderDocument(
  document: ReaderDocument,
  options: ReaderLayoutOptions
): ReaderLayout {
  if (document.grid) return layoutReaderGrid(document, options);
  const builder = new LayoutBuilder(document, options);
  for (const node of document.root.children) builder.renderBlock(node, EMPTY_CONTEXT);
  return builder.finish();
}

function readerGridLine(spans: StyledSpan[], searchable?: string): ReaderLine {
  return {
    spans,
    plain: searchable ?? spans.map(({ text }) => text).join("")
  };
}

/** A non-wrapping, horizontally windowed table with a frozen header. */
export function layoutReaderGrid(
  document: ReaderDocument,
  options: ReaderLayoutOptions
): ReaderLayout {
  const grid = document.grid!;
  const terminalWidth = Math.max(2, Math.floor(options.columns));
  const contentWidth = Math.max(1, terminalWidth - (terminalWidth >= 24 ? 2 : 1));
  const left = Math.max(0, Math.floor((terminalWidth - contentWidth) / 2));
  const prefix = " ".repeat(left);
  const rowNumberWidth = Math.max(1, String(Math.max(1, grid.rows.length)).length);
  const samples = grid.rows.slice(0, 1_000);
  const widths = grid.headers.map((header, column) => Math.max(3, Math.min(30, Math.max(
    stringWidth(sanitizeText(header)),
    ...samples.map((row) => stringWidth(sanitizeText(row[column] ?? "").replace(/\s+/gu, " ")))
  ))));
  const start = Math.max(0, Math.min(grid.columnOffset, Math.max(0, grid.headers.length - 1)));
  const fixedWidth = rowNumberWidth + 3;
  let remaining = Math.max(3, contentWidth - fixedWidth - 1);
  const visible: Array<{ index: number; width: number }> = [];
  for (let column = start; column < grid.headers.length; column += 1) {
    const width = Math.min(widths[column]!, Math.max(3, remaining - 1));
    if (visible.length > 0 && width + 1 > remaining) break;
    visible.push({ index: column, width });
    remaining -= width + 1;
    if (remaining < 4) break;
  }
  if (visible.length === 0 && grid.headers.length > 0) {
    visible.push({ index: start, width: Math.max(1, contentWidth - fixedWidth - 2) });
  }
  const rightHidden = visible.length > 0 && visible.at(-1)!.index < grid.headers.length - 1;
  const leftHidden = start > 0;
  const cellWidths = [rowNumberWidth, ...visible.map(({ width }) => width)];
  const border = (leftEdge: string, joint: string, rightEdge: string): ReaderLine => readerGridLine([{
    text: `${prefix}${leftEdge}${cellWidths.map((width) => "─".repeat(width)).join(joint)}${rightEdge}`,
    style: { color: "muted", dim: true }
  }]);
  const headerSpans: StyledSpan[] = [{ text: `${prefix}│`, style: { color: "muted", dim: true } }];
  appendSpan(headerSpans, padColumns("#", rowNumberWidth, "right"), { bold: true, color: "accent" });
  appendSpan(headerSpans, "│", { color: "muted", dim: true });
  for (const [visibleIndex, column] of visible.entries()) {
    let label = sanitizeText(grid.headers[column.index] ?? `Column ${column.index + 1}`).replace(/\s+/gu, " ");
    if (visibleIndex === 0 && leftHidden) label = `← ${label}`;
    if (visibleIndex === visible.length - 1 && rightHidden) label = `${label} →`;
    appendSpan(headerSpans, padColumns(label, column.width), { bold: true, color: "accent" });
    appendSpan(headerSpans, "│", { color: "muted", dim: true });
  }
  const stickyLines = [
    border("┌", "┬", "┐"),
    readerGridLine(headerSpans),
    border("├", "┼", "┤")
  ];
  const lines = grid.rows.map((row, rowIndex): ReaderLine => {
    const spans: StyledSpan[] = [{ text: `${prefix}│`, style: { color: "muted", dim: true } }];
    appendSpan(spans, padColumns(String(rowIndex + 1), rowNumberWidth, "right"), { color: "muted", dim: true });
    appendSpan(spans, "│", { color: "muted", dim: true });
    for (const column of visible) {
      const value = sanitizeText(row[column.index] ?? "").replace(/\s+/gu, " ").trim();
      const numeric = /^[-+]?\d+(?:[.,]\d+)?(?:e[-+]?\d+)?$/iu.test(value);
      appendSpan(spans, padColumns(value, column.width, numeric ? "right" : "left"));
      appendSpan(spans, "│", { color: "muted", dim: true });
    }
    return readerGridLine(spans, row.join("\t"));
  });
  if (grid.truncatedRows) {
    lines.push(readerGridLine([{
      text: `${prefix}… ${grid.truncatedRows.toLocaleString()} additional rows were not loaded`,
      style: { color: "warning", italic: true }
    }]));
  }
  lines.push(border("└", "┴", "┘"));
  return {
    lines,
    stickyLines,
    placements: [],
    headings: [],
    links: [],
    contentWidth,
    left
  };
}

/**
 * Resize existing image placeholders without reparsing or rewrapping the
 * document. Text spans, tables, links, and formula geometry remain intact;
 * only image rows and downstream absolute row numbers are adjusted.
 */
export function rescaleReaderImages(
  layout: ReaderLayout,
  options: Pick<ReaderLayoutOptions, "viewportRows" | "cell" | "imageScale">
): ReaderLayout {
  const imageCount = layout.placements.filter(({ asset }) => asset.kind === "image").length;
  if (imageCount === 0) return layout;
  const lines = [...layout.lines];
  const placements = layout.placements.map((placement) => ({ ...placement }));
  const headings = layout.headings.map((heading) => ({ ...heading }));
  const links = layout.links.map((link) => ({ ...link }));
  const images = placements
    .filter((placement) => placement.asset.kind === "image")
    .sort((left, right) => left.row - right.row);

  for (const placement of images) {
    if (placement.asset.kind !== "image") continue;
    const geometry = readerImageGeometry({
      width: placement.asset.width,
      height: placement.asset.height,
      availableColumns: placement.asset.availableColumns ?? layout.contentWidth,
      prefixColumns: placement.asset.prefixColumns ?? layout.left,
      viewportRows: options.viewportRows,
      cell: options.cell,
      imageScale: options.imageScale
    });
    const oldRows = placement.rows;
    const oldEnd = placement.row + oldRows;
    const delta = geometry.rows - oldRows;
    placement.col = geometry.col;
    placement.columns = geometry.columns;
    placement.rows = geometry.rows;
    if (delta === 0) continue;

    if (delta > 0) {
      const template = lines[placement.row] ?? { spans: [], plain: "" };
      const inserted = Array.from({ length: delta }, () => ({
        spans: [...template.spans],
        plain: template.plain
      }));
      lines.splice(oldEnd, 0, ...inserted);
    } else {
      lines.splice(placement.row + geometry.rows, -delta);
    }
    for (const candidate of placements) {
      if (candidate !== placement && candidate.row >= oldEnd) candidate.row += delta;
    }
    for (const heading of headings) {
      if (heading.line >= oldEnd) heading.line += delta;
    }
    for (const link of links) {
      if (link.line >= oldEnd) link.line += delta;
    }
  }

  return {
    lines,
    stickyLines: layout.stickyLines,
    placements,
    headings,
    links,
    contentWidth: layout.contentWidth,
    left: layout.left
  };
}

export const readerLayoutInternals = {
  estimateMathDimensions,
  padColumns,
  plainInline,
  sanitizeText,
  splitByColumns,
  truncateColumns,
  wrapInline
};
