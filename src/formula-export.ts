import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import {
  inferFormulaExportFormat,
  normalizeFormulaExportFormat
} from "./formula-export-format.js";
import {
  FormulaHistoryStore,
  type FormulaHistoryEntry
} from "./formula-history.js";
import {
  mathRendererInternals,
  readSvgDimensions,
  renderMathJaxMathMl,
  renderMathJaxSvg
} from "./math-renderer.js";
import { loadSharp } from "./sharp-loader.js";
import type {
  CopyCliOptions,
  ExportCliOptions,
  FormulaExportFormat,
  FormulaExportOptions
} from "./types.js";

const EXPORT_CONTAINER_WIDTH = 100_000;
const MATHJAX_EX_PX = 8;
const DEFAULT_RASTER_SCALE = 4;
const DEFAULT_RASTER_PADDING = 16;

interface ClipboardCandidate {
  command: string;
  args: string[];
}

interface ResolvedVisualOptions {
  scale: number;
  color: string;
  background?: string;
  padding: number;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function assertCssColor(value: string, label: string): string {
  const color = value.trim();
  const validHex = /^#[\da-f]{3}(?:[\da-f]{1}|[\da-f]{3}|[\da-f]{5})?$/iu;
  const validName = /^[a-z]{1,32}$/iu;
  const validFunction = /^(?:rgb|rgba|hsl|hsla)\([\d\s.,%+-]+\)$/iu;
  if (!validHex.test(color) && !validName.test(color) && !validFunction.test(color)) {
    throw new Error(`${label} must be a CSS color name, hex value, rgb(), or hsl()`);
  }
  return color;
}

function resolveVisualOptions(options: FormulaExportOptions): ResolvedVisualOptions {
  const raster = options.format === "png" || options.format === "tiff";
  const scale = options.scale ?? (raster ? DEFAULT_RASTER_SCALE : 1);
  const padding = options.padding ?? (raster ? DEFAULT_RASTER_PADDING : 0);
  if (!Number.isFinite(scale) || scale < 0.25 || scale > 16) {
    throw new Error("export scale must be between 0.25 and 16");
  }
  if (!Number.isSafeInteger(padding) || padding < 0 || padding > 512) {
    throw new Error("export padding must be an integer between 0 and 512");
  }
  const background = options.background?.toLowerCase() === "transparent"
    ? undefined
    : options.background === undefined
      ? undefined
      : assertCssColor(options.background, "export background");
  return {
    scale,
    padding,
    color: assertCssColor(options.color ?? "#000000", "export color"),
    ...(background ? { background } : {})
  };
}

function compactNumber(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "");
}

function positionMathJaxSvg(
  svg: string,
  x: number,
  y: number,
  width: number,
  height: number
): string {
  return svg.replace(/^<svg\b([^>]*)>/iu, (_root, attributes: string) => {
    const cleaned = attributes
      .replace(/\s(?:width|height|x|y|style)=(?:"[^"]*"|'[^']*')/giu, "")
      .replace(/\sxmlns=(?:"[^"]*"|'[^']*')/iu, "");
    return [
      `<svg x="${compactNumber(x)}" y="${compactNumber(y)}"`,
      ` width="${compactNumber(width)}" height="${compactNumber(height)}"`,
      cleaned,
      ">"
    ].join("");
  });
}

async function buildStyledSvg(
  entry: FormulaHistoryEntry,
  options: FormulaExportOptions
): Promise<string> {
  const visual = resolveVisualOptions(options);
  const sourceSvg = await renderMathJaxSvg(
    entry.latex,
    entry.display,
    EXPORT_CONTAINER_WIDTH
  );
  const dimensions = readSvgDimensions(sourceSvg);
  const contentHeight = dimensions.heightEx * MATHJAX_EX_PX * visual.scale;
  const contentWidth = contentHeight * dimensions.aspectRatio;
  const canvasWidth = Math.max(1, Math.ceil(contentWidth + visual.padding * 2));
  const canvasHeight = Math.max(1, Math.ceil(contentHeight + visual.padding * 2));
  const nested = positionMathJaxSvg(
    sourceSvg,
    visual.padding,
    visual.padding,
    contentWidth,
    contentHeight
  );
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}" color="${escapeXmlAttribute(visual.color)}" fill="${escapeXmlAttribute(visual.color)}">`,
    ...(visual.background
      ? [`<rect width="100%" height="100%" fill="${escapeXmlAttribute(visual.background)}"/>`]
      : []),
    nested,
    "</svg>"
  ].join("");
}

function markdownFormula(entry: FormulaHistoryEntry): string {
  return entry.display
    ? `$$\n${entry.latex}\n$$\n`
    : `$${entry.latex}$\n`;
}

export async function exportFormulaEntry(
  entry: FormulaHistoryEntry,
  options: FormulaExportOptions
): Promise<string | Uint8Array> {
  switch (options.format) {
    case "latex":
      return `${entry.latex}\n`;
    case "latex-inline":
      return `\\(${entry.latex}\\)\n`;
    case "latex-display":
      return `\\[\n${entry.latex}\n\\]\n`;
    case "markdown":
      return markdownFormula(entry);
    case "mathml":
      return `${(await renderMathJaxMathMl(entry.latex, entry.display)).trim()}\n`;
    case "html": {
      const tag = entry.display ? "div" : "span";
      const mathml = (await renderMathJaxMathMl(entry.latex, entry.display)).trim();
      return `<${tag} class="tformula-math">${mathml}</${tag}>\n`;
    }
    case "svg":
      return `${await buildStyledSvg(entry, options)}\n`;
    case "png":
    case "tiff": {
      const svg = await buildStyledSvg(entry, options);
      const png = await mathRendererInternals.renderSvgToPng(
        svg,
        mathRendererInternals.svgNeedsSystemFonts(svg)
      );
      if (options.format === "png") return png;
      const sharp = await loadSharp();
      return sharp(png).tiff({ compression: "lzw" }).toBuffer();
    }
  }
}

function clipboardMime(format: FormulaExportFormat): string {
  switch (format) {
    case "mathml": return "application/mathml+xml";
    case "html": return "text/html";
    case "svg": return "image/svg+xml";
    case "png": return "image/png";
    case "tiff": return "image/tiff";
    default: return "text/plain";
  }
}

function clipboardCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  mime: string
): ClipboardCandidate[] {
  if (platform === "darwin") return [{ command: "pbcopy", args: [] }];
  if (platform !== "linux") return [];
  const candidates: ClipboardCandidate[] = [];
  if (env.WAYLAND_DISPLAY) {
    candidates.push({ command: "wl-copy", args: ["--type", mime] });
  }
  if (env.DISPLAY) {
    candidates.push({
      command: "xclip",
      args: ["-selection", "clipboard", "-t", mime]
    });
    candidates.push({ command: "xsel", args: ["--clipboard", "--input"] });
  }
  return candidates;
}

async function pipeToCommand(
  candidate: ClipboardCandidate,
  data: string | Uint8Array,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(candidate.command, candidate.args, {
      env,
      stdio: ["pipe", "ignore", "pipe"]
    });
    let stderr = "";
    let settled = false;
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      resolvePromise();
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 2_000) stderr += chunk;
    });
    child.once("error", fail);
    child.once("close", (code) => {
      if (code === 0) succeed();
      else fail(new Error(
        `${candidate.command} exited with status ${code ?? "unknown"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`
      ));
    });
    child.stdin.once("error", fail);
    child.stdin.end(data);
  });
}

async function copyMacImage(data: Uint8Array, mime: "image/png" | "image/tiff"): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "tformula-clipboard-"));
  const path = join(root, mime === "image/png" ? "formula.png" : "formula.tiff");
  try {
    await writeFile(path, data);
    const clipboardType = mime === "image/png" ? "«class PNGf»" : "TIFF picture";
    await pipeToCommand({
      command: "osascript",
      args: [
        "-e",
        `set the clipboard to (read (POSIX file (system attribute "TFORMULA_CLIPBOARD_FILE")) as ${clipboardType})`
      ]
    }, "", { ...process.env, TFORMULA_CLIPBOARD_FILE: path });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function copyToClipboard(
  data: string | Uint8Array,
  format: FormulaExportFormat
): Promise<string> {
  const mime = clipboardMime(format);
  if (process.platform === "darwin" && typeof data !== "string") {
    await copyMacImage(data, mime as "image/png" | "image/tiff");
    return "osascript";
  }
  const binary = typeof data !== "string";
  const candidates = clipboardCandidates(process.platform, process.env, mime)
    .filter((candidate) => !binary || candidate.command !== "xsel");
  if (candidates.length === 0) {
    throw new Error("no supported clipboard utility is available (install wl-clipboard or xclip)");
  }
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      await pipeToCommand(candidate, data);
      return candidate.command;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `could not write to the system clipboard: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}

export async function runExportCommand(
  options: ExportCliOptions,
  debug: (message: string) => void
): Promise<number> {
  const store = new FormulaHistoryStore({ debug });
  const entry = await store.resolve(options.selector);
  debug(
    `formula export selected ${entry.id} (${entry.display ? "display" : "inline"}, ${entry.latex.length} chars)`
  );
  const exported = await exportFormulaEntry(entry, options);
  const byteLength = typeof exported === "string"
    ? Buffer.byteLength(exported)
    : exported.byteLength;
  debug(`formula export generated ${options.format} (${byteLength} bytes)`);
  if (options.output) {
    const outputPath = isAbsolute(options.output)
      ? options.output
      : resolve(options.cwd, options.output);
    await writeFile(outputPath, exported, typeof exported === "string"
      ? { encoding: "utf8" }
      : undefined);
    debug(`formula export wrote ${entry.id} as ${options.format} to ${outputPath}`);
    return 0;
  }
  if (typeof exported !== "string" && process.stdout.isTTY) {
    throw new Error(`${options.format.toUpperCase()} export to a terminal is unsafe; use save <file>`);
  }
  process.stdout.write(exported);
  debug(`formula export wrote ${entry.id} as ${options.format} to stdout`);
  return 0;
}

export async function runCopyCommand(
  options: CopyCliOptions,
  debug: (message: string) => void
): Promise<number> {
  const store = new FormulaHistoryStore({ debug });
  const entry = await store.resolve(options.selector);
  debug(
    `formula export selected ${entry.id} (${entry.display ? "display" : "inline"}, ${entry.latex.length} chars)`
  );
  const exported = await exportFormulaEntry(entry, options);
  const byteLength = typeof exported === "string"
    ? Buffer.byteLength(exported)
    : exported.byteLength;
  debug(`formula export generated ${options.format} (${byteLength} bytes)`);
  const utility = await copyToClipboard(exported, options.format);
  debug(`formula export copied ${entry.id} as ${options.format} using ${utility}`);
  return 0;
}

export { inferFormulaExportFormat, normalizeFormulaExportFormat };

export const formulaExportInternals = {
  buildStyledSvg,
  clipboardCandidates,
  clipboardMime,
  copyToClipboard,
  resolveVisualOptions
};
