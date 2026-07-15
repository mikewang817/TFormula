import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, posix, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import type { Root, RootContent } from "mdast";
import { unzipSync } from "fflate";
import { parse as parseHtml, type DefaultTreeAdapterTypes } from "parse5";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { parseAllDocuments, stringify as stringifyYaml } from "yaml";
import type { ReaderFileKind } from "./reader-path.js";

const MAX_EMBEDDED_ASSET_BYTES = 128 * 1024 * 1024;
const MAX_ARCHIVE_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 100_000;
const MAX_GRID_ROWS = 100_000;
const MAX_GRID_COLUMNS = 512;
const MAX_HEX_BYTES = 8 * 1024;
const MAX_PROCESS_OUTPUT = 64 * 1024 * 1024;

export interface ReaderGridData {
  headers: string[];
  rows: string[][];
  columnOffset: number;
  truncatedRows?: number;
}

export interface ReaderPdfData {
  pageCount: number;
  renderPage: (page: number) => Promise<string>;
  temporaryPaths: string[];
  backend: string;
}

export interface ReaderFormatPayload {
  source: string;
  root?: Root;
  markdown?: string;
  title?: string;
  label: string;
  grid?: ReaderGridData;
  pdf?: ReaderPdfData;
  temporaryPaths?: string[];
}

type HtmlNode = DefaultTreeAdapterTypes.Node;
type HtmlElement = DefaultTreeAdapterTypes.Element;

function heading(depth: 1 | 2 | 3 | 4 | 5 | 6, text: string): RootContent {
  return { type: "heading", depth, children: [{ type: "text", value: text }] };
}

function paragraph(text: string): RootContent {
  return { type: "paragraph", children: [{ type: "text", value: text }] };
}

function codeRoot(title: string, value: string, language?: string, warning?: string): Root {
  const children: RootContent[] = [heading(1, title)];
  if (warning) {
    children.push({
      type: "blockquote",
      children: [{
        type: "paragraph",
        children: [{ type: "text", value: warning }]
      }]
    });
  }
  children.push({ type: "code", value: value.replace(/\n$/u, ""), lang: language });
  return { type: "root", children };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeSource(value: unknown): string {
  if (Array.isArray(value)) return value.join("");
  return typeof value === "string" ? value : "";
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/gu, "");
}

function safeFence(value: string): string {
  const longest = Math.max(0, ...[...value.matchAll(/`+/gu)].map(([ticks]) => ticks.length));
  return "`".repeat(Math.max(3, longest + 1));
}

function escapeMarkdownText(value: string): string {
  return value.replace(/([\\`*_[\]<>])/gu, "\\$1");
}

function escapeMarkdownTable(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replace(/\s+/gu, " ").trim();
}

function htmlAttribute(element: HtmlElement, name: string): string | undefined {
  return element.attrs.find((attribute) => attribute.name.toLowerCase() === name)?.value;
}

function isHtmlElement(node: HtmlNode): node is HtmlElement {
  return "tagName" in node;
}

function htmlNodeText(node: HtmlNode): string {
  if (node.nodeName === "#text" && "value" in node) return node.value;
  if (!("childNodes" in node)) return "";
  return node.childNodes.map(htmlNodeText).join("");
}

function findHtmlElement(node: HtmlNode, tagName: string): HtmlElement | undefined {
  if (isHtmlElement(node) && node.tagName.toLowerCase() === tagName) return node;
  if (!("childNodes" in node)) return undefined;
  for (const child of node.childNodes) {
    const found = findHtmlElement(child, tagName);
    if (found) return found;
  }
  return undefined;
}

function collectHtmlElements(node: HtmlNode, tags: ReadonlySet<string>, result: HtmlElement[] = []): HtmlElement[] {
  if (isHtmlElement(node) && tags.has(node.tagName.toLowerCase())) result.push(node);
  if ("childNodes" in node) {
    for (const child of node.childNodes) collectHtmlElements(child, tags, result);
  }
  return result;
}

interface HtmlMarkdownOptions {
  rewriteUrl?: (value: string, element: "link" | "image") => string;
}

/** Convert inert HTML structure to Markdown without evaluating CSS or scripts. */
export function htmlToMarkdown(source: string, options: HtmlMarkdownOptions = {}): {
  markdown: string;
  title?: string;
} {
  const document = parseHtml(source);
  const title = findHtmlElement(document, "title");
  const body = findHtmlElement(document, "body") ?? document;

  const renderChildren = (node: HtmlNode, depth = 0): string =>
    "childNodes" in node
      ? node.childNodes.map((child) => render(child, depth)).join("")
      : "";
  const renderList = (element: HtmlElement, ordered: boolean, depth: number): string => {
    const items = element.childNodes.filter((child): child is HtmlElement =>
      isHtmlElement(child) && child.tagName.toLowerCase() === "li");
    return items.map((item, index) => {
      const marker = ordered ? `${index + 1}. ` : "- ";
      const body = renderChildren(item, depth + 1).trim().replace(/\n+/gu, "\n");
      const indentation = "  ".repeat(depth);
      const continuation = `\n${indentation}  `;
      return `${indentation}${marker}${body.replaceAll("\n", continuation)}\n`;
    }).join("") + "\n";
  };
  const renderTable = (element: HtmlElement): string => {
    const rows = collectHtmlElements(element, new Set(["tr"]))
      .map((row) => row.childNodes
        .filter((cell): cell is HtmlElement =>
          isHtmlElement(cell) && ["td", "th"].includes(cell.tagName.toLowerCase()))
        .map((cell) => escapeMarkdownTable(renderChildren(cell).trim())));
    const columns = Math.max(0, ...rows.map((row) => row.length));
    if (columns === 0) return "";
    const normalized = rows.map((row) => Array.from({ length: columns }, (_, index) => row[index] ?? ""));
    const header = normalized[0]!;
    return `\n| ${header.join(" | ")} |\n| ${header.map(() => "---").join(" | ")} |\n`
      + normalized.slice(1).map((row) => `| ${row.join(" | ")} |`).join("\n")
      + "\n\n";
  };
  const render = (node: HtmlNode, depth = 0): string => {
    if (node.nodeName === "#text" && "value" in node) {
      return escapeMarkdownText(node.value.replace(/\s+/gu, " "));
    }
    if (!isHtmlElement(node)) return renderChildren(node, depth);
    const tag = node.tagName.toLowerCase();
    if (["script", "style", "noscript", "template", "head"].includes(tag)) {
      if (tag === "script" && /^math\/tex/iu.test(htmlAttribute(node, "type") ?? "")) {
        const latex = htmlNodeText(node).trim();
        return /mode\s*=\s*display/iu.test(htmlAttribute(node, "type") ?? "")
          ? `\n\n$$\n${latex}\n$$\n\n`
          : `$${latex}$`;
      }
      return "";
    }
    const children = (): string => renderChildren(node, depth);
    if (/^h[1-6]$/u.test(tag)) {
      const level = Number(tag[1]);
      return `\n\n${"#".repeat(level)} ${children().trim()}\n\n`;
    }
    if (["p", "section", "article", "main", "header", "footer", "aside", "nav", "figure", "figcaption", "address"].includes(tag)) {
      return `\n\n${children().trim()}\n\n`;
    }
    if (tag === "br") return "  \n";
    if (tag === "hr") return "\n\n---\n\n";
    if (["strong", "b"].includes(tag)) return `**${children().trim()}**`;
    if (["em", "i"].includes(tag)) return `*${children().trim()}*`;
    if (["s", "strike", "del"].includes(tag)) return `~~${children().trim()}~~`;
    if (tag === "mark") return `**${children().trim()}**`;
    if (tag === "sub") return `~${children().trim()}~`;
    if (tag === "sup") return `^${children().trim()}^`;
    if (tag === "code" && node.parentNode && isHtmlElement(node.parentNode)
      && node.parentNode.tagName.toLowerCase() === "pre") return htmlNodeText(node);
    if (tag === "code") {
      const value = htmlNodeText(node).trim();
      const ticks = safeFence(value);
      return `${ticks}${value}${ticks}`;
    }
    if (tag === "pre") {
      const value = htmlNodeText(node).replace(/^\n/u, "").replace(/\n\s*$/u, "");
      const code = node.childNodes.find((child): child is HtmlElement =>
        isHtmlElement(child) && child.tagName.toLowerCase() === "code");
      const language = htmlAttribute(code ?? node, "class")?.match(/(?:language-|lang-)([\w+-]+)/iu)?.[1] ?? "";
      const fence = safeFence(value);
      return `\n\n${fence}${language}\n${value}\n${fence}\n\n`;
    }
    if (tag === "blockquote") {
      return `\n\n${children().trim().split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
    }
    if (tag === "ul") return `\n${renderList(node, false, depth)}\n`;
    if (tag === "ol") return `\n${renderList(node, true, depth)}\n`;
    if (tag === "li") return children();
    if (tag === "a") {
      const label = children().trim() || htmlAttribute(node, "href") || "link";
      const original = htmlAttribute(node, "href") ?? "";
      const href = options.rewriteUrl?.(original, "link") ?? original;
      if (!href || /^(?:javascript|vbscript):/iu.test(href)) return label;
      return `[${label}](${href.replaceAll(" ", "%20")})`;
    }
    if (tag === "img") {
      const original = htmlAttribute(node, "src") ?? "";
      const src = options.rewriteUrl?.(original, "image") ?? original;
      const alt = escapeMarkdownText(htmlAttribute(node, "alt") || basename(original) || "image");
      return src ? `![${alt}](${src.replaceAll(" ", "%20")})` : `[Image: ${alt}]`;
    }
    if (tag === "table") return renderTable(node);
    if (tag === "dl") return `\n\n${children().trim()}\n\n`;
    if (tag === "dt") return `\n**${children().trim()}**\n`;
    if (tag === "dd") return `: ${children().trim()}\n`;
    return children();
  };

  return {
    markdown: renderChildren(body).replace(/[ \t]+\n/gu, "\n").replace(/\n{3,}/gu, "\n\n").trim(),
    title: title ? htmlNodeText(title).replace(/\s+/gu, " ").trim() || undefined : undefined
  };
}

function formatXml(source: string): string {
  const tokens = source.replace(/>\s*</gu, "><").match(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]+>|[^<]+/gu) ?? [];
  const lines: string[] = [];
  let depth = 0;
  for (const raw of tokens) {
    const token = raw.trim();
    if (!token) continue;
    const closing = /^<\//u.test(token);
    const declaration = /^<\?|^<!/u.test(token);
    const selfClosing = /\/>$/u.test(token) || declaration;
    if (closing) depth = Math.max(0, depth - 1);
    lines.push(`${"  ".repeat(depth)}${token}`);
    if (!closing && !selfClosing && /^<[^/!?>][^>]*>$/u.test(token)
      && !/<\/[^>]+>$/u.test(token)) depth += 1;
  }
  return lines.join("\n");
}

function validateXmlNesting(source: string): void {
  const stack: string[] = [];
  const tags = source.match(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]+>/gu) ?? [];
  for (const tag of tags) {
    if (/^<\?|^<!/u.test(tag) || /\/>$/u.test(tag)) continue;
    const closing = tag.match(/^<\/\s*([\w:.-]+)/u)?.[1];
    if (closing) {
      const opening = stack.pop();
      if (opening !== closing) {
        throw new Error(`closing tag </${closing}> does not match <${opening ?? "none"}>`);
      }
      continue;
    }
    const opening = tag.match(/^<\s*([\w:.-]+)/u)?.[1];
    if (opening) stack.push(opening);
  }
  if (stack.length) throw new Error(`unclosed tag <${stack.at(-1)}>`);
}

function structuredRecordGrid(value: unknown): ReaderGridData | undefined {
  if (!Array.isArray(value) || value.length === 0 || !value.every((record) =>
    record !== null && typeof record === "object" && !Array.isArray(record))) return undefined;
  const headers = [...new Set(value.flatMap((record) => Object.keys(record as Record<string, unknown>)))];
  if (headers.length === 0 || headers.length > MAX_GRID_COLUMNS) return undefined;
  const cell = (entry: unknown): string => {
    if (entry === null) return "null";
    if (entry === undefined) return "";
    if (typeof entry === "string") return entry;
    if (typeof entry === "bigint") return entry.toString();
    if (entry instanceof Date) return entry.toISOString();
    if (typeof entry === "object") return JSON.stringify(entry);
    return String(entry);
  };
  return {
    headers,
    rows: value.slice(0, MAX_GRID_ROWS).map((record) =>
      headers.map((key) => cell((record as Record<string, unknown>)[key]))),
    columnOffset: 0,
    ...(value.length > MAX_GRID_ROWS ? { truncatedRows: value.length - MAX_GRID_ROWS } : {})
  };
}

export function loadStructuredFormat(kind: ReaderFileKind, path: string, source: string): ReaderFormatPayload {
  const title = basename(path);
  let value = source.replace(/^\uFEFF/u, "");
  let parsed: unknown;
  let warning: string | undefined;
  try {
    if (kind === "json") {
      parsed = JSON.parse(value);
      value = `${JSON.stringify(parsed, null, 2)}\n`;
    }
    else if (kind === "jsonl") {
      const records = value.split(/\r?\n/u).filter((line) => line.trim()).map((line) => JSON.parse(line));
      parsed = records;
      value = records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
    } else if (kind === "yaml") {
      const documents = parseAllDocuments(value, { prettyErrors: true });
      const errors = documents.flatMap((document) => document.errors);
      if (errors.length) throw errors[0];
      const values = documents.map((document) => document.toJS({ maxAliasCount: 100 }));
      parsed = values.length === 1 ? values[0] : values;
      value = values.map((document) => stringifyYaml(document)).join("---\n");
    } else if (kind === "toml") {
      parsed = parseToml(value);
      value = stringifyToml(parsed as Parameters<typeof stringifyToml>[0]);
    }
    else if (kind === "xml") {
      validateXmlNesting(value);
      value = `${formatXml(value)}\n`;
    }
  } catch (error) {
    warning = `Could not normalize this ${kind.toUpperCase()} document: ${errorMessage(error)}. Showing the original text.`;
    value = source;
  }
  return {
    source,
    root: codeRoot(title, value, kind === "jsonl" ? "json" : kind, warning),
    title,
    label: kind.toUpperCase(),
    grid: structuredRecordGrid(parsed)
  };
}

/** RFC 4180-style parser with embedded delimiter/newline support. */
export function parseDelimited(source: string, delimiter: "," | "\t"): ReaderGridData {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const input = source.replace(/^\uFEFF/u, "");
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else cell += character;
      continue;
    }
    if (character === '"' && cell.length === 0) quoted = true;
    else if (character === delimiter) {
      row.push(cell);
      cell = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
      if (rows.length > MAX_GRID_ROWS + 1) break;
    } else cell += character;
  }
  if (cell || row.length || (input && !/[\r\n]$/u.test(input))) {
    row.push(cell);
    rows.push(row);
  }
  if (quoted) throw new Error("unterminated quoted field");
  const columnCount = Math.max(0, ...rows.map((candidate) => candidate.length));
  if (columnCount > MAX_GRID_COLUMNS) {
    throw new Error(`table has ${columnCount} columns; the reader limit is ${MAX_GRID_COLUMNS}`);
  }
  const first = rows.shift() ?? [];
  const headers = Array.from({ length: columnCount }, (_, index) =>
    first[index]?.trim() || `Column ${index + 1}`);
  return {
    headers,
    rows: rows.slice(0, MAX_GRID_ROWS),
    columnOffset: 0,
    ...(rows.length > MAX_GRID_ROWS ? { truncatedRows: rows.length - MAX_GRID_ROWS } : {})
  };
}

export function loadDelimitedFormat(kind: "csv" | "tsv", path: string, source: string): ReaderFormatPayload {
  const grid = parseDelimited(source, kind === "csv" ? "," : "\t");
  return {
    source,
    root: codeRoot(basename(path), source, kind),
    title: basename(path),
    label: kind.toUpperCase(),
    grid
  };
}

function safeAssetName(value: string, fallback: string): string {
  const clean = basename(value).replace(/[^\p{Letter}\p{Number}._-]+/gu, "-").slice(0, 100);
  return clean && clean !== "." && clean !== ".." ? clean : fallback;
}

function imageExtension(mime: string): string | undefined {
  if (mime === "image/png") return ".png";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/svg+xml") return ".svg";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/gif") return ".gif";
  return undefined;
}

function decodeEmbeddedImage(value: unknown, mime: string): Uint8Array | undefined {
  const raw = normalizeSource(value).replace(/\s+/gu, "");
  if (!raw) return undefined;
  if (mime === "image/svg+xml") return Buffer.from(normalizeSource(value), "utf8");
  const data = Buffer.from(raw, "base64");
  return data.length ? data : undefined;
}

export async function loadNotebookFormat(path: string, source: string): Promise<ReaderFormatPayload> {
  const notebook = JSON.parse(source) as {
    metadata?: Record<string, unknown>;
    cells?: Array<Record<string, unknown>>;
  };
  if (!Array.isArray(notebook.cells)) throw new Error("notebook has no cells array");
  const languageInfo = notebook.metadata?.language_info as Record<string, unknown> | undefined;
  const kernel = notebook.metadata?.kernelspec as Record<string, unknown> | undefined;
  const language = String(languageInfo?.name ?? kernel?.language ?? "text").replace(/[^\w+-]/gu, "") || "text";
  const title = basename(path, extname(path));
  const parts = [`# ${escapeMarkdownText(title)}`, "", `> Jupyter Notebook · ${notebook.cells.length} cells`, ""];
  let assetDirectory: string | undefined;
  let embeddedBytes = 0;
  let assetIndex = 0;
  const temporaryPaths: string[] = [];
  const ensureAssetDirectory = async (): Promise<string> => {
    if (!assetDirectory) {
      assetDirectory = await mkdtemp(join(tmpdir(), "tformula-notebook-"));
      temporaryPaths.push(assetDirectory);
    }
    return assetDirectory;
  };
  const materialize = async (name: string, mime: string, value: unknown): Promise<string | undefined> => {
    const extension = imageExtension(mime);
    const data = extension ? decodeEmbeddedImage(value, mime) : undefined;
    if (!extension || !data) return undefined;
    embeddedBytes += data.byteLength;
    if (embeddedBytes > MAX_EMBEDDED_ASSET_BYTES) {
      throw new Error("notebook embedded images exceed the 128 MB reader limit");
    }
    const directory = await ensureAssetDirectory();
    const hash = createHash("sha256").update(data).digest("hex").slice(0, 16);
    const filename = `${String(++assetIndex).padStart(4, "0")}-${hash}-${safeAssetName(name, `output${extension}`)}`;
    const outputPath = join(directory, filename.endsWith(extension) ? filename : `${filename}${extension}`);
    await writeFile(outputPath, data);
    return outputPath;
  };

  for (let index = 0; index < notebook.cells.length; index += 1) {
    const cell = notebook.cells[index]!;
    const type = String(cell.cell_type ?? "raw");
    let cellSource = normalizeSource(cell.source);
    parts.push(`## Cell ${index + 1} · ${type === "markdown" ? "Markdown" : type === "code" ? "Code" : "Raw"}`, "");
    if (type === "markdown") {
      const attachments = cell.attachments && typeof cell.attachments === "object"
        ? cell.attachments as Record<string, Record<string, unknown>>
        : {};
      for (const [name, values] of Object.entries(attachments)) {
        for (const [mime, value] of Object.entries(values)) {
          const outputPath = await materialize(name, mime, value);
          if (!outputPath) continue;
          const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
          cellSource = cellSource.replace(new RegExp(`attachment:${escapedName}`, "gu"), outputPath);
          break;
        }
      }
      parts.push(cellSource.trim(), "");
      continue;
    }
    if (type !== "code") {
      const fence = safeFence(cellSource);
      parts.push(`${fence}text`, cellSource.replace(/\n$/u, ""), fence, "");
      continue;
    }
    const fence = safeFence(cellSource);
    parts.push(`${fence}${language}`, cellSource.replace(/\n$/u, ""), fence, "");
    const outputs = Array.isArray(cell.outputs) ? cell.outputs as Array<Record<string, unknown>> : [];
    for (const [outputIndex, output] of outputs.entries()) {
      const outputType = String(output.output_type ?? "output");
      parts.push(`### Output ${outputIndex + 1}`, "");
      if (outputType === "stream") {
        const text = stripAnsi(normalizeSource(output.text));
        const outputFence = safeFence(text);
        parts.push(`${outputFence}text`, text.replace(/\n$/u, ""), outputFence, "");
        continue;
      }
      if (outputType === "error") {
        const traceback = Array.isArray(output.traceback)
          ? output.traceback.map(String).join("\n")
          : `${String(output.ename ?? "Error")}: ${String(output.evalue ?? "")}`;
        const text = stripAnsi(traceback);
        const outputFence = safeFence(text);
        parts.push(`${outputFence}text`, text, outputFence, "");
        continue;
      }
      const data = output.data && typeof output.data === "object"
        ? output.data as Record<string, unknown>
        : {};
      let rendered = false;
      for (const mime of ["image/svg+xml", "image/png", "image/jpeg", "image/webp", "image/gif"]) {
        if (!(mime in data)) continue;
        const outputPath = await materialize(`cell-${index + 1}-output-${outputIndex + 1}${imageExtension(mime)}`, mime, data[mime]);
        if (outputPath) {
          parts.push(`![Cell ${index + 1} output ${outputIndex + 1}](${outputPath.replaceAll(" ", "%20")})`, "");
          rendered = true;
          break;
        }
      }
      if (rendered) continue;
      if (data["text/markdown"] !== undefined) {
        parts.push(normalizeSource(data["text/markdown"]).trim(), "");
      } else if (data["text/latex"] !== undefined) {
        parts.push("$$", normalizeSource(data["text/latex"]).trim().replace(/^\$\$|\$\$$/gu, ""), "$$", "");
      } else if (data["text/html"] !== undefined) {
        parts.push(htmlToMarkdown(normalizeSource(data["text/html"])).markdown, "");
      } else {
        const text = stripAnsi(normalizeSource(data["text/plain"]));
        const outputFence = safeFence(text);
        parts.push(`${outputFence}text`, text.replace(/\n$/u, ""), outputFence, "");
      }
    }
  }
  return {
    source,
    markdown: parts.join("\n"),
    title: `${title}.ipynb`,
    label: "Notebook",
    temporaryPaths
  };
}

interface ZipEntryInfo {
  name: string;
  compressedSize: number;
  size: number;
  directory: boolean;
}

function readZipEntries(data: Uint8Array): ZipEntryInfo[] {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index -= 1) {
    if (bytes.readUInt32LE(index) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP end-of-directory record was not found");
  const count = bytes.readUInt16LE(eocd + 10);
  const offset = bytes.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) throw new Error("ZIP64 archives are not supported yet");
  if (count > MAX_ARCHIVE_ENTRIES) throw new Error(`archive has more than ${MAX_ARCHIVE_ENTRIES} entries`);
  const entries: ZipEntryInfo[] = [];
  let cursor = offset;
  let expanded = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("invalid ZIP central directory");
    }
    const flags = bytes.readUInt16LE(cursor + 8);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = nameBytes.toString(flags & 0x800 ? "utf8" : "latin1");
    expanded += size;
    if (expanded > MAX_ARCHIVE_EXPANDED_BYTES) {
      throw new Error("archive expands beyond the 256 MB reader safety limit");
    }
    entries.push({ name, compressedSize, size, directory: name.endsWith("/") });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function safeArchivePath(value: string): string | undefined {
  const normalized = posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//u, "");
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.startsWith("/")) {
    return undefined;
  }
  return normalized;
}

function xmlAttributes(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of value.matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/gu)) {
    result[match[1]!.toLowerCase()] = match[3]!;
  }
  return result;
}

function decodeXmlText(value: string): string {
  const fragment = parseHtml(`<body>${value}</body>`);
  return htmlNodeText(findHtmlElement(fragment, "body") ?? fragment).replace(/\s+/gu, " ").trim();
}

export async function loadEpubFormat(path: string, bytes: Uint8Array): Promise<ReaderFormatPayload> {
  const infos = readZipEntries(bytes);
  const expanded = unzipSync(bytes);
  const entry = (name: string): Uint8Array | undefined => expanded[safeArchivePath(name) ?? ""];
  const container = entry("META-INF/container.xml");
  if (!container) throw new Error("EPUB container.xml is missing");
  const containerXml = Buffer.from(container).toString("utf8");
  const packagePath = containerXml.match(/<rootfile\b[^>]*\bfull-path\s*=\s*["']([^"']+)["']/iu)?.[1];
  const safePackagePath = packagePath ? safeArchivePath(packagePath) : undefined;
  if (!safePackagePath) throw new Error("EPUB package path is invalid");
  const packageData = entry(safePackagePath);
  if (!packageData) throw new Error("EPUB package document is missing");
  const packageXml = Buffer.from(packageData).toString("utf8");
  const packageDirectory = posix.dirname(safePackagePath);
  const manifest = new Map<string, { path: string; mediaType: string; properties: string }>();
  for (const match of packageXml.matchAll(/<item\b([^>]*)\/?\s*>/giu)) {
    const attributes = xmlAttributes(match[1]!);
    if (!attributes.id || !attributes.href) continue;
    const itemPath = safeArchivePath(posix.join(packageDirectory, attributes.href));
    if (!itemPath) continue;
    manifest.set(attributes.id, {
      path: itemPath,
      mediaType: attributes["media-type"] ?? "",
      properties: attributes.properties ?? ""
    });
  }
  const spine = [...packageXml.matchAll(/<itemref\b([^>]*)\/?\s*>/giu)]
    .map((match) => xmlAttributes(match[1]!).idref)
    .filter((id): id is string => Boolean(id))
    .map((id) => manifest.get(id))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  const chapters = (spine.length ? spine : [...manifest.values()].filter((item) =>
    /xhtml|html/iu.test(item.mediaType)))
    .filter((item) => entry(item.path));
  if (chapters.length === 0) throw new Error("EPUB has no readable spine chapters");
  const metadataTitle = packageXml.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/iu)?.[1];
  const title = decodeXmlText(metadataTitle ?? "") || basename(path, extname(path));
  const chapterSources = new Map(chapters.map((chapter) => [
    chapter.path,
    Buffer.from(entry(chapter.path)!).toString("utf8")
  ]));
  const referencedImages = new Set<string>();
  for (const chapter of chapters) {
    const chapterSource = chapterSources.get(chapter.path)!;
    for (const match of chapterSource.matchAll(/<(?:img|image)\b[^>]*?\b(?:src|href)\s*=\s*(["'])(.*?)\1/giu)) {
      let imageHref = match[2]!;
      try {
        imageHref = decodeURIComponent(imageHref.split("#", 1)[0]!.split("?", 1)[0]!);
      } catch {
        // Keep malformed literal URL bytes for the safe-path check.
      }
      const target = safeArchivePath(posix.join(posix.dirname(chapter.path), imageHref));
      if (target) referencedImages.add(target);
    }
  }
  let assetDirectory: string | undefined;
  const materialized = new Map<string, string>();
  for (const item of manifest.values()) {
    if (!item.mediaType.startsWith("image/") || !referencedImages.has(item.path)) continue;
    const data = entry(item.path);
    const safePath = safeArchivePath(item.path);
    if (!data || !safePath) continue;
    assetDirectory ??= await mkdtemp(join(tmpdir(), "tformula-epub-"));
    const outputPath = resolve(assetDirectory, safePath);
    if (!outputPath.startsWith(`${resolve(assetDirectory)}/`)) continue;
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, data);
    materialized.set(item.path, outputPath);
  }
  const chapterTargets = new Map(chapters.map((chapter, index) => [chapter.path, `#epub-chapter-${index + 1}`]));
  const markdown: string[] = [`# ${escapeMarkdownText(title)}`, "", `> EPUB · ${chapters.length} chapters`, ""];
  for (const [index, chapter] of chapters.entries()) {
    const chapterSource = chapterSources.get(chapter.path)!;
    const converted = htmlToMarkdown(chapterSource, {
      rewriteUrl: (value, element) => {
        if (!value || /^[a-z][a-z\d+.-]*:/iu.test(value) || value.startsWith("#")) return value;
        const [pathname, fragment] = value.split("#", 2);
        let decodedPath = pathname!.split("?", 1)[0]!;
        try {
          decodedPath = decodeURIComponent(decodedPath);
        } catch {
          // Preserve malformed literal URL bytes instead of aborting the book.
        }
        const target = safeArchivePath(posix.join(posix.dirname(chapter.path), decodedPath));
        if (!target) return value;
        if (element === "image") return materialized.get(target) ?? value;
        const chapterTarget = chapterTargets.get(target);
        return chapterTarget ? fragment ? `#${fragment}` : chapterTarget : value;
      }
    });
    markdown.push(`## EPUB Chapter ${index + 1}`, "");
    if (converted.title) markdown.push(`*${escapeMarkdownText(converted.title)}*`, "");
    markdown.push(converted.markdown, "");
  }
  return {
    source: "",
    markdown: markdown.join("\n"),
    title,
    label: "EPUB",
    temporaryPaths: assetDirectory ? [assetDirectory] : []
  };
}

function parseTarEntries(data: Uint8Array): ZipEntryInfo[] {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const entries: ZipEntryInfo[] = [];
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const stringField = (start: number, length: number): string =>
      header.subarray(start, start + length).toString("utf8").replace(/\0.*$/su, "").trim();
    const name = `${stringField(345, 155)}${stringField(345, 155) ? "/" : ""}${stringField(0, 100)}`;
    const size = Number.parseInt(stringField(124, 12).replace(/\s+/gu, "") || "0", 8);
    if (!Number.isFinite(size) || size < 0) throw new Error("invalid TAR entry size");
    entries.push({ name, size, compressedSize: size, directory: stringField(156, 1) === "5" || name.endsWith("/") });
    if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error(`archive has more than ${MAX_ARCHIVE_ENTRIES} entries`);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function archiveGrid(entries: ZipEntryInfo[]): ReaderGridData {
  return {
    headers: ["Path", "Type", "Compressed", "Size"],
    rows: entries.map((entry) => [
      entry.name,
      entry.directory ? "directory" : "file",
      entry.directory ? "—" : String(entry.compressedSize),
      entry.directory ? "—" : String(entry.size)
    ]),
    columnOffset: 0
  };
}

export function loadArchiveFormat(path: string, bytes: Uint8Array): ReaderFormatPayload {
  const lower = path.toLowerCase();
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 512));
  const zip = header.subarray(0, 4).toString("binary");
  const gzip = header[0] === 0x1f && header[1] === 0x8b;
  const tar = header.subarray(257, 262).toString("ascii") === "ustar";
  let entries: ZipEntryInfo[];
  let label: string;
  if (lower.endsWith(".zip") || zip === "PK\x03\x04" || zip === "PK\x05\x06") {
    entries = readZipEntries(bytes);
    label = "ZIP";
  } else if (lower.endsWith(".tgz") || lower.endsWith(".tar.gz")) {
    const expanded = gunzipSync(bytes, { maxOutputLength: MAX_ARCHIVE_EXPANDED_BYTES });
    entries = parseTarEntries(expanded);
    label = "TAR.GZ";
  } else if (lower.endsWith(".tar") || tar) {
    entries = parseTarEntries(bytes);
    label = "TAR";
  } else if (lower.endsWith(".gz") || gzip) {
    const expanded = gunzipSync(bytes, { maxOutputLength: MAX_ARCHIVE_EXPANDED_BYTES });
    entries = [{
      name: basename(path, ".gz"),
      compressedSize: bytes.byteLength,
      size: expanded.byteLength,
      directory: false
    }];
    label = "GZIP";
  } else throw new Error("unsupported archive container");
  return {
    source: "",
    root: codeRoot(basename(path), `${entries.length} archive entries`, "text"),
    title: basename(path),
    label,
    grid: archiveGrid(entries)
  };
}

function hexDump(data: Uint8Array): string {
  const bytes = Buffer.from(data.buffer, data.byteOffset, Math.min(data.byteLength, MAX_HEX_BYTES));
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const chunk = bytes.subarray(offset, offset + 16);
    const hex = [...chunk].map((value) => value.toString(16).padStart(2, "0")).join(" ").padEnd(47);
    const ascii = [...chunk].map((value) => value >= 0x20 && value <= 0x7e ? String.fromCharCode(value) : ".").join("");
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex}  |${ascii.padEnd(16)}|`);
  }
  if (data.byteLength > bytes.length) lines.push(`… ${data.byteLength - bytes.length} additional bytes`);
  return lines.join("\n");
}

function printableStrings(data: Uint8Array): string[] {
  const bytes = Buffer.from(data.buffer, data.byteOffset, Math.min(data.byteLength, 1024 * 1024));
  return (bytes.toString("latin1").match(/[\x20-\x7e]{4,}/gu) ?? []).slice(0, 100);
}

export function loadBinaryFormat(path: string, bytes: Uint8Array): ReaderFormatPayload {
  const strings = printableStrings(bytes);
  const preview = `${hexDump(bytes)}${strings.length
    ? `\n\nPrintable strings (first ${strings.length}):\n${strings.join("\n")}`
    : ""}`;
  return {
    source: "",
    root: codeRoot(
      basename(path),
      preview,
      "hex",
      `Binary file · ${bytes.byteLength.toLocaleString()} bytes · showing the first ${Math.min(bytes.byteLength, MAX_HEX_BYTES).toLocaleString()} bytes`
    ),
    title: basename(path),
    label: "Binary"
  };
}

function runProcess(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, {
      encoding: "utf8",
      maxBuffer: MAX_PROCESS_OUTPUT,
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message).trim();
        reject(new Error(detail || `${command} failed`));
      } else resolvePromise({ stdout, stderr });
    });
  });
}

function pdfInfoValue(info: string, key: string): string | undefined {
  return info.match(new RegExp(`^${key}:\\s*(.+)$`, "imu"))?.[1]?.trim();
}

function pdfFlowRoot(path: string, source: string, info: string, warning?: string): Root {
  const children: RootContent[] = [heading(1, basename(path))];
  const summary = [
    pdfInfoValue(info, "Title"),
    pdfInfoValue(info, "Author") ? `Author: ${pdfInfoValue(info, "Author")}` : undefined,
    pdfInfoValue(info, "Pages") ? `${pdfInfoValue(info, "Pages")} pages` : undefined
  ].filter(Boolean).join(" · ");
  if (summary) children.push({
    type: "blockquote",
    children: [{ type: "paragraph", children: [{ type: "text", value: summary }] }]
  });
  if (warning) children.push({
    type: "blockquote",
    children: [{ type: "paragraph", children: [{ type: "text", value: warning }] }]
  });
  const pages = source.split("\f").filter((page) => page.trim());
  for (const [pageIndex, pageText] of pages.entries()) {
    if (pages.length > 1) children.push(heading(2, `Page ${pageIndex + 1}`));
    for (const block of pageText.split(/\n\s*\n/gu)) {
      const text = block.split(/\r?\n/gu).map((line) => line.trim()).filter(Boolean).join(" ");
      if (text) children.push(paragraph(text));
    }
  }
  if (children.length === 1) children.push(paragraph("No extractable text was found. Press v to try page view."));
  return { type: "root", children };
}

export async function loadPdfFormat(path: string): Promise<ReaderFormatPayload> {
  const pdfInfo = process.env.TFORMULA_PDFINFO || "pdfinfo";
  const pdfToText = process.env.TFORMULA_PDFTOTEXT || "pdftotext";
  const pdfToPpm = process.env.TFORMULA_PDFTOPPM || "pdftoppm";
  let info = "";
  let source = "";
  const warnings: string[] = [];
  const [infoResult, textResult] = await Promise.allSettled([
    runProcess(pdfInfo, [path]),
    runProcess(pdfToText, ["-enc", "UTF-8", path, "-"])
  ]);
  if (infoResult.status === "fulfilled") info = infoResult.value.stdout;
  else warnings.push(`PDF metadata unavailable: ${errorMessage(infoResult.reason)}`);
  if (textResult.status === "fulfilled") source = textResult.value.stdout;
  else warnings.push(`PDF text extraction unavailable: ${errorMessage(textResult.reason)}`);
  const pageCount = Number.parseInt(pdfInfoValue(info, "Pages") ?? "0", 10);
  let pdf: ReaderPdfData | undefined;
  if (Number.isSafeInteger(pageCount) && pageCount > 0) {
    const temporaryPaths: string[] = [];
    let directory: Promise<string> | undefined;
    const outputDirectory = (): Promise<string> => {
      directory ??= mkdtemp(join(tmpdir(), "tformula-pdf-")).then((path) => {
        temporaryPaths.push(path);
        return path;
      });
      return directory;
    };
    const pending = new Map<number, Promise<string>>();
    const renderPage = (page: number): Promise<string> => {
      const normalized = Math.max(1, Math.min(pageCount, Math.floor(page)));
      const existing = pending.get(normalized);
      if (existing) return existing;
      const rendering = outputDirectory().then(async (outputRoot) => {
        const outputPrefix = join(outputRoot, `page-${String(normalized).padStart(6, "0")}`);
        const outputPath = `${outputPrefix}.png`;
        await runProcess(pdfToPpm, [
          "-f", String(normalized),
          "-l", String(normalized),
          "-singlefile",
          "-png",
          "-r", "144",
          path,
          outputPrefix
        ]);
        await stat(outputPath);
        return outputPath;
      });
      pending.set(normalized, rendering);
      void rendering.catch(() => pending.delete(normalized));
      return rendering;
    };
    pdf = {
      pageCount,
      renderPage,
      temporaryPaths,
      backend: "Poppler"
    };
  }
  return {
    source,
    root: pdfFlowRoot(path, source, info, warnings.join(" · ") || undefined),
    title: pdfInfoValue(info, "Title") || basename(path),
    label: "PDF reflow",
    pdf,
    temporaryPaths: pdf?.temporaryPaths ?? []
  };
}
