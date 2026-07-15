import { open, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Definition,
  Image,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent
} from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { mathFromMarkdown } from "mdast-util-math";
import { gfm } from "micromark-extension-gfm";
import { math } from "micromark-extension-math";
import { readerFileKind } from "./reader-path.js";
import type { ReaderFileKind } from "./reader-path.js";
import type {
  ReaderGridData,
  ReaderFormatPayload,
  ReaderPdfData
} from "./reader-formats.js";
import { loadSharp } from "./sharp-loader.js";

export { looksLikeReaderPath, readerFileKind, type ReaderFileKind } from "./reader-path.js";

const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES = 128 * 1024 * 1024;
const MAX_CONTAINER_BYTES = 256 * 1024 * 1024;

function loadReaderFormats(): Promise<typeof import("./reader-formats.js")> {
  return import("./reader-formats.js");
}

export interface ImageResource {
  url: string;
  path?: string;
  width?: number;
  height?: number;
  size?: number;
  mtimeMs?: number;
  error?: string;
}

export interface MathResource {
  latex: string;
  display: boolean;
  aspectRatio?: number;
  heightEx?: number;
  error?: string;
}

export interface ReaderDocument {
  path: string;
  title: string;
  kind?: ReaderFileKind;
  label?: string;
  source: string;
  root: Root;
  images: Map<string, ImageResource>;
  math: Map<string, MathResource>;
  grid?: ReaderGridData;
  pages?: ReaderPageState;
  /** Changes whenever a mutable document view changes, invalidating layouts. */
  viewKey?: string;
  temporaryPaths?: string[];
}

export interface ReaderDocumentContent {
  root: Root;
  images: Map<string, ImageResource>;
  math: Map<string, MathResource>;
}

export interface ReaderPageState {
  mode: "reflow" | "page";
  current: number;
  count: number;
  backend: string;
  reflow: ReaderDocumentContent;
  cache: Map<number, ReaderDocumentContent>;
  load: (page: number) => Promise<ReaderDocumentContent>;
}

export function parseMarkdown(source: string): Root {
  const normalized = normalizeMarkdownMathDelimiters(source);
  const root = fromMarkdown(normalized, {
    extensions: [gfm(), math()],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()]
  });
  root.children = promoteDisplayMath(root.children, normalized);
  return root;
}

function fencedCodeLines(lines: string[]): boolean[] {
  const fenced = Array.from({ length: lines.length }, () => false);
  let fenceCharacter = "";
  let fenceLength = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
    if (!fenceCharacter) {
      if (marker) {
        fenceCharacter = marker[0]!;
        fenceLength = marker.length;
        fenced[index] = true;
      }
      continue;
    }
    fenced[index] = true;
    if (marker?.[0] === fenceCharacter && marker.length >= fenceLength
      && new RegExp(`^ {0,3}${fenceCharacter}{${fenceLength},}\\s*$`, "u").test(line)) {
      fenceCharacter = "";
      fenceLength = 0;
    }
  }
  return fenced;
}

function replaceExplicitInlineMathDelimiters(line: string): string {
  let output = "";
  let codeTicks = 0;
  for (let index = 0; index < line.length;) {
    if (line[index] === "`") {
      let end = index + 1;
      while (line[end] === "`") end += 1;
      const ticks = end - index;
      if (codeTicks === 0) codeTicks = ticks;
      else if (ticks === codeTicks) codeTicks = 0;
      output += line.slice(index, end);
      index = end;
      continue;
    }
    const unescaped = index === 0 || line[index - 1] !== "\\";
    if (codeTicks === 0 && unescaped && line.startsWith("\\(", index)) {
      output += "$";
      index += 2;
      continue;
    }
    if (codeTicks === 0 && unescaped && line.startsWith("\\)", index)) {
      output += "$";
      index += 2;
      continue;
    }
    if (codeTicks === 0 && unescaped && line.startsWith("\\[", index)) {
      output += "$$";
      index += 2;
      continue;
    }
    if (codeTicks === 0 && unescaped && line.startsWith("\\]", index)) {
      output += "$$";
      index += 2;
      continue;
    }
    output += line[index];
    index += 1;
  }
  return output;
}

function containsStrongTex(value: string): boolean {
  return /\\(?:begin|cases|frac|int|left|lim|log|matrix|neq|prod|sqrt|sum|tag)\b/u.test(value)
    || /(?:[_^]\s*(?:\{|[A-Za-z0-9])|\\[A-Za-z]+\s*\{)/u.test(value)
    || /(?:=|\\neq|\\leq|\\geq).*(?:\\|[_^])/u.test(value);
}

/**
 * Protect TeX delimiters which CommonMark otherwise treats as escaped
 * punctuation. Line count is intentionally preserved so heading and search
 * positions still correspond to the source document.
 */
export function normalizeMarkdownMathDelimiters(source: string): string {
  const lines = source.split("\n");
  const fenced = fencedCodeLines(lines);
  for (let index = 0; index < lines.length; index += 1) {
    if (fenced[index]) continue;
    const line = lines[index]!;
    const trimmed = line.trim();
    if (trimmed === "\\[" || trimmed === "\\]") {
      const indentation = line.slice(0, line.search(/\S/u));
      lines[index] = `${indentation}$$`;
    } else {
      lines[index] = replaceExplicitInlineMathDelimiters(line);
    }
  }

  // Some PDF/TUI conversion pipelines have already consumed the backslashes
  // around a display block. Recognize only bracket blocks with unmistakable
  // TeX structure so ordinary prose and reference labels remain untouched.
  for (let index = 0; index < lines.length; index += 1) {
    if (fenced[index]) continue;
    const line = lines[index]!;
    const oneLine = line.match(/^(\s*)\[\s*(.+?)\s*\]\s*$/u);
    if (oneLine && containsStrongTex(oneLine[2]!)) {
      lines[index] = `${oneLine[1]}$$${oneLine[2]}$$`;
      continue;
    }
    if (line.trim() !== "[") continue;
    for (let end = index + 1; end < Math.min(lines.length, index + 64); end += 1) {
      if (fenced[end]) break;
      if (lines[end]!.trim() !== "]") continue;
      const body = lines.slice(index + 1, end).join("\n");
      if (containsStrongTex(body)) {
        // A replacement string of "$$" has special String.replace semantics
        // and produces one literal dollar. A callback preserves both math
        // delimiter characters.
        lines[index] = line.replace("[", () => "$$");
        lines[end] = lines[end]!.replace("]", () => "$$");
      }
      break;
    }
  }
  return lines.join("\n");
}

function isDoubleDollarMath(node: PhrasingContent, source: string): boolean {
  if (node.type !== "inlineMath") return false;
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return false;
  const raw = source.slice(start, end).trim();
  return raw.startsWith("$$") && raw.endsWith("$$");
}

function splitDisplayMathParagraph(paragraph: Paragraph, source: string): RootContent[] {
  const result: RootContent[] = [];
  let phrasing: PhrasingContent[] = [];
  const flush = (): void => {
    if (phrasing.length === 0) return;
    result.push({ type: "paragraph", children: phrasing });
    phrasing = [];
  };
  for (const child of paragraph.children) {
    if (isDoubleDollarMath(child, source) && child.type === "inlineMath") {
      flush();
      result.push({ type: "math", value: child.value });
    } else {
      phrasing.push(child);
    }
  }
  flush();
  return result.length > 0 ? result : [paragraph];
}

function promoteDisplayMath(children: RootContent[], source: string): RootContent[] {
  const result: RootContent[] = [];
  for (const child of children) {
    if (child.type === "paragraph") {
      result.push(...splitDisplayMathParagraph(child, source));
      continue;
    }
    if (child.type === "blockquote" || child.type === "footnoteDefinition") {
      child.children = promoteDisplayMath(child.children, source) as typeof child.children;
    } else if (child.type === "list") {
      for (const item of child.children) {
        item.children = promoteDisplayMath(item.children, source) as typeof item.children;
      }
    }
    result.push(child);
  }
  return result;
}

function plainTextRoot(source: string): Root {
  return {
    type: "root",
    children: [{ type: "code", value: source.replace(/\n$/u, "") }]
  };
}

function imageRoot(path: string): Root {
  const image: Image = {
    type: "image",
    url: path,
    alt: basename(path),
    title: basename(path)
  };
  return {
    type: "root",
    children: [{ type: "paragraph", children: [image] }]
  };
}

function visit(node: Root | RootContent, callback: (node: Root | RootContent) => void): void {
  callback(node);
  if (!("children" in node) || !Array.isArray(node.children)) return;
  for (const child of node.children) visit(child as RootContent, callback);
}

export function collectDocumentResources(root: Root): {
  imageUrls: string[];
  formulas: Array<{ latex: string; display: boolean }>;
} {
  const imageUrls = new Set<string>();
  const formulas = new Map<string, { latex: string; display: boolean }>();
  const definitions = new Map<string, Definition>();
  for (const node of root.children) {
    if (node.type === "definition") definitions.set(node.identifier, node);
  }
  visit(root, (node) => {
    if (node.type === "image") imageUrls.add(node.url);
    if (node.type === "imageReference") {
      const definition = definitions.get(node.identifier);
      if (definition) imageUrls.add(definition.url);
    }
    if (node.type === "math" || node.type === "inlineMath") {
      const display = node.type === "math";
      formulas.set(mathResourceKey(node.value, display), { latex: node.value, display });
    }
  });
  return { imageUrls: [...imageUrls], formulas: [...formulas.values()] };
}

export function mathResourceKey(latex: string, display: boolean): string {
  return `${display ? "display" : "inline"}\0${latex}`;
}

function localImagePath(url: string, documentPath: string): string | undefined {
  if (/^https?:\/\//iu.test(url) || /^data:/iu.test(url)) return undefined;
  try {
    if (/^file:/iu.test(url)) return fileURLToPath(url);
    const withoutFragment = url.split("#", 1)[0]!.split("?", 1)[0]!;
    return resolve(dirname(documentPath), decodeURIComponent(withoutFragment));
  } catch {
    return undefined;
  }
}

async function inspectImage(url: string, documentPath: string): Promise<ImageResource> {
  const path = localImagePath(url, documentPath);
  if (!path) {
    return { url, error: "remote and data images are not loaded in this release" };
  }
  try {
    const sharp = await loadSharp();
    const [metadata, info] = await Promise.all([sharp(path).metadata(), stat(path)]);
    const width = metadata.autoOrient.width ?? metadata.width;
    const height = metadata.autoOrient.height ?? metadata.height;
    if (!width || !height) throw new Error("image dimensions are unavailable");
    return { url, path, width, height, size: info.size, mtimeMs: info.mtimeMs };
  } catch (error) {
    return {
      url,
      path,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function contentForRoot(root: Root, documentPath: string): Promise<ReaderDocumentContent> {
  const resources = collectDocumentResources(root);
  const imageEntries = await Promise.all(
    resources.imageUrls.map(async (url) => [url, await inspectImage(url, documentPath)] as const)
  );
  // Natural formula dimensions are deliberately resolved only when a formula
  // enters the viewport. Eagerly invoking MathJax here makes startup scale
  // with every unique formula in a long document, including content the user
  // may never visit.
  const mathEntries = resources.formulas.map(({ latex, display }) => [
    mathResourceKey(latex, display),
    { latex, display }
  ] as const);
  return {
    root,
    images: new Map(imageEntries),
    math: new Map(mathEntries)
  };
}

function applyDocumentContent(document: ReaderDocument, content: ReaderDocumentContent): void {
  document.root = content.root;
  document.images = content.images;
  document.math = content.math;
}

export async function setReaderPage(document: ReaderDocument, page: number): Promise<boolean> {
  const pages = document.pages;
  if (!pages) return false;
  const target = Math.max(1, Math.min(pages.count, Math.floor(page)));
  let content = pages.cache.get(target);
  if (!content) {
    content = await pages.load(target);
  } else pages.cache.delete(target);
  pages.cache.set(target, content);
  while (pages.cache.size > 3) {
    const oldest = pages.cache.keys().next().value;
    if (oldest === undefined) break;
    pages.cache.delete(oldest);
  }
  pages.current = target;
  pages.mode = "page";
  applyDocumentContent(document, content);
  document.viewKey = `page:${target}`;
  document.label = `PDF page ${target}/${pages.count}`;
  return true;
}

export async function toggleReaderPageView(document: ReaderDocument): Promise<boolean> {
  const pages = document.pages;
  if (!pages) return false;
  if (pages.mode === "page") {
    pages.mode = "reflow";
    applyDocumentContent(document, pages.reflow);
    document.viewKey = "reflow";
    document.label = "PDF reflow";
    return true;
  }
  return setReaderPage(document, pages.current);
}

export async function changeReaderPage(document: ReaderDocument, delta: number): Promise<boolean> {
  const pages = document.pages;
  if (!pages || pages.mode !== "page") return false;
  const target = Math.max(1, Math.min(pages.count, pages.current + Math.sign(delta)));
  if (target === pages.current) return false;
  return setReaderPage(document, target);
}

export async function disposeReaderDocument(document: ReaderDocument): Promise<void> {
  const paths = document.temporaryPaths?.splice(0) ?? [];
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true }).catch(() => undefined)));
}

function looksLikeImage(data: Uint8Array): boolean {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  )) return true;
  const ascii = bytes.subarray(0, 16).toString("ascii");
  const brand = bytes.length >= 12 && ascii.slice(4, 8) === "ftyp" ? ascii.slice(8, 12) : "";
  return (bytes[0] === 0xff && bytes[1] === 0xd8)
    || ascii.startsWith("GIF87a")
    || ascii.startsWith("GIF89a")
    || (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP")
    || ascii.startsWith("II*\0")
    || ascii.startsWith("MM\0*")
    || ["avif", "avis", "heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)
    || /<svg(?:\s|>)/iu.test(bytes.subarray(0, 1024).toString("utf8"));
}

function decodeUtf8(data: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return undefined;
  }
}

function sniffReaderFileKind(data: Uint8Array): ReaderFileKind {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const ascii = bytes.subarray(0, 16).toString("ascii");
  if (ascii.startsWith("%PDF-")) return "pdf";
  if (ascii.startsWith("PK\x03\x04") || ascii.startsWith("PK\x05\x06")) return "archive";
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return "archive";
  if (bytes.subarray(257, 262).toString("ascii") === "ustar") return "archive";
  if (looksLikeImage(data)) return "image";
  const source = decodeUtf8(data);
  if (source === undefined) return "binary";
  const trimmed = source.replace(/^\uFEFF/u, "").trimStart();
  if (/^<!doctype\s+html\b|^<html\b/iu.test(trimmed)) return "html";
  if (/^<\?xml\b/iu.test(trimmed)) return "xml";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
  return "text";
}

function maximumBytesFor(kind: ReaderFileKind | undefined): number {
  if (kind === undefined) return MAX_CONTAINER_BYTES;
  if (kind === "image") return MAX_IMAGE_BYTES;
  if (kind === "pdf" || kind === "epub" || kind === "archive" || kind === "binary") {
    return MAX_CONTAINER_BYTES;
  }
  return MAX_DOCUMENT_BYTES;
}

export async function loadReaderDocument(inputPath: string, cwd = process.cwd()): Promise<ReaderDocument> {
  const path = resolve(cwd, inputPath);
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`${inputPath} is not a regular file`);
  // Implicit reader dispatch is limited to known extensions so executable
  // commands remain unambiguous. Explicit `--read` may still open an unknown
  // file, whose leading bytes are safely sniffed before its size-bound loader
  // is selected.
  const extensionKind = readerFileKind(path);
  let kind = extensionKind;
  if (!kind) {
    const handle = await open(path, "r");
    try {
      const head = Buffer.alloc(Math.min(info.size, 4_096));
      const { bytesRead } = await handle.read(head, 0, head.length, 0);
      kind = sniffReaderFileKind(head.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }
  const maximumBytes = maximumBytesFor(kind);
  if (info.size > maximumBytes) {
    throw new Error(`${inputPath} exceeds the ${maximumBytes / 1024 / 1024} MB reader limit`);
  }
  const bytes = kind === "image" ? undefined : await readFile(path);
  const source = bytes ? decodeUtf8(bytes) : "";

  if (kind === "image") {
    const content = await contentForRoot(imageRoot(path), path);
    return {
      path,
      title: basename(path),
      kind,
      label: "Image",
      source: "",
      ...content,
      viewKey: "image"
    };
  }

  let payload: ReaderFormatPayload;
  if (kind === "markdown") {
    if (source === undefined) throw new Error(`${inputPath} is not valid UTF-8`);
    payload = { source, root: parseMarkdown(source), label: "Markdown" };
  } else if (kind === "text") {
    if (source === undefined) {
      const { loadBinaryFormat } = await loadReaderFormats();
      payload = loadBinaryFormat(path, bytes!);
    }
    else payload = { source, root: plainTextRoot(source), label: "Text" };
  } else if (["json", "jsonl", "yaml", "toml", "xml"].includes(kind)) {
    if (source === undefined) throw new Error(`${inputPath} is not valid UTF-8`);
    const { loadStructuredFormat } = await loadReaderFormats();
    payload = loadStructuredFormat(kind, path, source);
  } else if (kind === "csv" || kind === "tsv") {
    if (source === undefined) throw new Error(`${inputPath} is not valid UTF-8`);
    const { loadDelimitedFormat } = await loadReaderFormats();
    payload = loadDelimitedFormat(kind, path, source);
  } else if (kind === "html") {
    if (source === undefined) throw new Error(`${inputPath} is not valid UTF-8`);
    const { htmlToMarkdown } = await loadReaderFormats();
    const converted = htmlToMarkdown(source);
    payload = {
      source,
      markdown: converted.markdown,
      title: converted.title,
      label: "HTML"
    };
  } else if (kind === "notebook") {
    if (source === undefined) throw new Error(`${inputPath} is not valid UTF-8`);
    const { loadNotebookFormat } = await loadReaderFormats();
    payload = await loadNotebookFormat(path, source);
  } else if (kind === "epub") {
    const { loadEpubFormat } = await loadReaderFormats();
    payload = await loadEpubFormat(path, bytes!);
  } else if (kind === "pdf") {
    const { loadPdfFormat } = await loadReaderFormats();
    payload = await loadPdfFormat(path);
  } else if (kind === "archive") {
    const { loadArchiveFormat } = await loadReaderFormats();
    payload = loadArchiveFormat(path, bytes!);
  } else {
    const { loadBinaryFormat } = await loadReaderFormats();
    payload = loadBinaryFormat(path, bytes!);
  }

  const root = payload.root ?? parseMarkdown(payload.markdown ?? "");
  const content = await contentForRoot(root, path);
  const document: ReaderDocument = {
    path,
    title: payload.title || basename(path),
    kind,
    label: payload.label,
    source: payload.source,
    ...content,
    grid: payload.grid,
    viewKey: payload.grid ? `grid:${payload.grid.columnOffset}` : "rendered",
    temporaryPaths: payload.temporaryPaths ?? []
  };
  const pdf = payload.pdf as ReaderPdfData | undefined;
  if (pdf) {
    const reflow = content;
    document.pages = {
      mode: "reflow",
      current: 1,
      count: pdf.pageCount,
      backend: pdf.backend,
      reflow,
      cache: new Map(),
      load: async (page) => {
        const renderedPath = await pdf.renderPage(page);
        return contentForRoot(imageRoot(renderedPath), path);
      }
    };
    document.viewKey = "reflow";
  }
  return document;
}
