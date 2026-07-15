import { readFile, stat } from "node:fs/promises";
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
import sharp from "sharp";
import { readSvgDimensions, renderMathJaxSvg } from "./math-renderer.js";
import { readerFileKind } from "./reader-path.js";

export { looksLikeReaderPath, readerFileKind, type ReaderFileKind } from "./reader-path.js";

const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES = 128 * 1024 * 1024;

export interface ImageResource {
  url: string;
  path?: string;
  width?: number;
  height?: number;
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
  source: string;
  root: Root;
  images: Map<string, ImageResource>;
  math: Map<string, MathResource>;
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
    const metadata = await sharp(path).metadata();
    const width = metadata.autoOrient.width ?? metadata.width;
    const height = metadata.autoOrient.height ?? metadata.height;
    if (!width || !height) throw new Error("image dimensions are unavailable");
    return { url, path, width, height };
  } catch (error) {
    return {
      url,
      path,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function inspectMath(latex: string, display: boolean): Promise<MathResource> {
  try {
    const svg = await renderMathJaxSvg(latex, display, 100_000);
    const dimensions = readSvgDimensions(svg);
    return {
      latex,
      display,
      aspectRatio: dimensions.aspectRatio,
      heightEx: dimensions.heightEx
    };
  } catch (error) {
    return {
      latex,
      display,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function loadReaderDocument(inputPath: string, cwd = process.cwd()): Promise<ReaderDocument> {
  const path = resolve(cwd, inputPath);
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`${inputPath} is not a regular file`);
  // Implicit reader dispatch is limited to known extensions so executable
  // commands remain unambiguous. Explicit `--read` may still open any UTF-8
  // file, which is treated as plain text here.
  const kind = readerFileKind(path) ?? "text";
  const maximumBytes = kind === "image" ? MAX_IMAGE_BYTES : MAX_DOCUMENT_BYTES;
  if (info.size > maximumBytes) {
    throw new Error(`${inputPath} exceeds the ${maximumBytes / 1024 / 1024} MB reader limit`);
  }
  const source = kind === "image" ? "" : await readFile(path, "utf8");
  const root = kind === "markdown"
    ? parseMarkdown(source)
    : kind === "text"
      ? plainTextRoot(source)
      : imageRoot(path);
  const resources = collectDocumentResources(root);
  const imageEntries = await Promise.all(
    resources.imageUrls.map(async (url) => [url, await inspectImage(url, path)] as const)
  );
  const mathEntries = await Promise.all(
    resources.formulas.map(async ({ latex, display }) => [
      mathResourceKey(latex, display),
      await inspectMath(latex, display)
    ] as const)
  );

  return {
    path,
    title: basename(path),
    source,
    root,
    images: new Map(imageEntries),
    math: new Map(mathEntries)
  };
}
