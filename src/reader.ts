import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import { KittyImageTransmitter, selectImageTransmissionMode } from "./image-transmitter.js";
import {
  cursorPosition,
  kittyDeleteByZIndex,
  kittyDeleteImage,
  kittyDeletePlacementsByZIndex,
  kittyPlaceImage,
  synchronizedOutput,
  type KittySourceRectangle,
  TFORMULA_IMAGE_ID_MAX,
  TFORMULA_IMAGE_ID_MIN
} from "./kitty.js";
import type { MathRenderer } from "./math-renderer.js";
import {
  KITTY_QUERY_IMAGE_ID,
  parseTerminalResponses,
  STARTUP_PROBE_QUARANTINE_MS,
  TerminalProbeResponseFilter
} from "./probe.js";
import {
  changeReaderPage,
  disposeReaderDocument,
  loadReaderDocument,
  readerFileKind,
  toggleReaderPageView,
  type ReaderDocument
} from "./reader-document.js";
import {
  layoutReaderDocument,
  rescaleReaderImages,
  type ReaderImageAsset,
  type ReaderLayout,
  type ReaderPlacement,
  type ReaderStyle,
  type StyledSpan
} from "./reader-layout.js";
import {
  canonicalImageRequest,
  ReaderImageCache,
  type CanonicalImageRequest
} from "./reader-image-cache.js";
import { TerminalResponseFilter } from "./terminal-responses.js";
import { TerminalWriter } from "./terminal-writer.js";
import type { FormulaRegion, ReaderCliOptions, TerminalCapabilities } from "./types.js";
import stringWidth from "string-width";

const ESC = "\x1b";
const ENTER_ALTERNATE_SCREEN = `${ESC}[?1049h${ESC}[?25l${ESC}[2J${ESC}[H`;
const LEAVE_ALTERNATE_SCREEN = `${ESC}[0m${ESC}[?25h${ESC}[?1049l`;

interface PreparedAsset {
  key: string;
  png: Uint8Array;
  width: number;
  height: number;
}

interface UploadedAsset {
  imageId: number;
  key: string;
  width: number;
  height: number;
}

export interface VisibleReaderPlacement {
  placement: ReaderPlacement;
  screenRow: number;
  rows: number;
  /** First visible terminal-cell row within a vertically clipped image. */
  sourceRow?: number;
}

const IMAGE_SCALE_LEVELS = [0.25, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 2.5, 3] as const;
const DEFAULT_MAX_TERMINAL_IMAGES = 64;

export function readerTerminalImageLimit(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.TFORMULA_READER_MAX_IMAGES);
  return Number.isFinite(configured) && configured > 0
    ? Math.max(1, Math.floor(configured))
    : DEFAULT_MAX_TERMINAL_IMAGES;
}

/** Keys are ordered least- to most-recently used. */
export function selectTerminalImageEvictions(
  keys: Iterable<string>,
  protectedKeys: ReadonlySet<string>,
  maximum: number
): string[] {
  const ordered = [...keys];
  let remaining = ordered.length;
  const evictions: string[] = [];
  for (const key of ordered) {
    if (remaining <= Math.max(1, Math.floor(maximum))) break;
    if (protectedKeys.has(key)) continue;
    evictions.push(key);
    remaining -= 1;
  }
  return evictions;
}

/**
 * Select graphics intersecting the viewport. Formula images remain atomic,
 * while document images may be vertically cropped so a zoomed image remains
 * visible as the reader scrolls through it.
 */
export function visibleReaderPlacements(
  placements: ReaderPlacement[],
  offset: number,
  viewportRows: number
): VisibleReaderPlacement[] {
  const top = Math.max(0, Math.floor(offset));
  const bottom = top + Math.max(1, Math.floor(viewportRows));
  return placements.flatMap((placement): VisibleReaderPlacement[] => {
    if (placement.asset.kind !== "image") {
      return placement.row >= top && placement.row + placement.rows <= bottom
        ? [{
            placement,
            screenRow: placement.row - top,
            rows: placement.rows
          }]
        : [];
    }

    const visibleTop = Math.max(top, placement.row);
    const visibleBottom = Math.min(bottom, placement.row + placement.rows);
    if (visibleTop >= visibleBottom) return [];
    const rows = visibleBottom - visibleTop;
    const clipped = visibleTop !== placement.row
      || visibleBottom !== placement.row + placement.rows;
    return [{
      placement,
      screenRow: visibleTop - top,
      rows,
      ...(clipped ? { sourceRow: visibleTop - placement.row } : {})
    }];
  });
}

/** Map a visible terminal-row slice onto the reusable uploaded PNG. */
export function sourceRectangleForVisiblePlacement(
  visible: VisibleReaderPlacement,
  imageWidth: number,
  imageHeight: number
): KittySourceRectangle | undefined {
  if (visible.sourceRow === undefined) return undefined;
  const width = Math.max(1, Math.round(imageWidth));
  const height = Math.max(1, Math.round(imageHeight));
  const totalRows = Math.max(1, visible.placement.rows);
  const firstRow = Math.max(0, Math.min(totalRows, visible.sourceRow));
  const lastRow = Math.max(firstRow, Math.min(totalRows, firstRow + visible.rows));
  // Calculate both boundaries against the actual canonical PNG dimensions.
  // This keeps fractional cell metrics and the final source rectangle inside
  // the image while scrolling across it.
  const y = Math.min(height - 1, Math.round(firstRow / totalRows * height));
  const bottom = Math.max(y + 1, Math.min(
    height,
    Math.round(lastRow / totalRows * height)
  ));
  return { x: 0, y, width, height: bottom - y };
}

function isDarkColor(color: string): boolean {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(color);
  if (!match) return true;
  const [red, green, blue] = match.slice(1).map((value) => Number.parseInt(value!, 16) / 255);
  const luminance = 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
  return luminance < 0.55;
}

function styleSequence(style: ReaderStyle | undefined, dark: boolean): string {
  if (!style) return "";
  const codes: number[] = [];
  if (style.bold) codes.push(1);
  if (style.dim) codes.push(2);
  if (style.italic) codes.push(3);
  if (style.underline) codes.push(4);
  if (style.inverse) codes.push(7);
  if (style.strike) codes.push(9);
  if (style.color === "accent") codes.push(38, 5, dark ? 81 : 25);
  if (style.color === "muted") codes.push(38, 5, dark ? 245 : 244);
  if (style.color === "link") codes.push(38, 5, dark ? 75 : 26);
  if (style.color === "code") codes.push(38, 5, dark ? 223 : 94);
  if (style.color === "quote") codes.push(38, 5, dark ? 80 : 30);
  if (style.color === "warning") codes.push(38, 5, dark ? 203 : 124);
  if (style.background === "code") codes.push(48, 5, dark ? 236 : 254);
  return codes.length ? `${ESC}[${codes.join(";")}m` : "";
}

function renderSpans(spans: StyledSpan[], dark: boolean, activeHref?: string): string {
  let output = "";
  for (const span of spans) {
    const style = activeHref && span.style?.href === activeHref
      ? { ...span.style, inverse: true }
      : span.style;
    const sequence = styleSequence(style, dark);
    if (sequence) output += sequence;
    output += span.text;
    if (sequence) output += `${ESC}[0m`;
  }
  return output;
}

function truncateStatus(value: string, width: number): string {
  if (width <= 0) return "";
  if (stringWidth(value) <= width) return value;
  if (width === 1) return "…";
  let output = "";
  for (const glyph of Array.from(value)) {
    if (stringWidth(output + glyph) > width - 1) break;
    output += glyph;
  }
  return `${output}…`;
}

function fitStatus(value: string, width: number): string {
  const clipped = truncateStatus(value, width);
  return `${clipped}${" ".repeat(Math.max(0, width - stringWidth(clipped)))}`;
}

function plainFallbackMessage(path: string): string {
  return `tformula: ${path}: this format requires an interactive terminal\n`;
}

interface ReaderDirectoryEntry {
  name: string;
  path: string;
  type: "directory" | "file";
  kind?: NonNullable<ReturnType<typeof readerFileKind>>;
}

export async function listReaderDirectory(directoryPath: string): Promise<ReaderDirectoryEntry[]> {
  const directory = resolve(directoryPath);
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.flatMap((entry): ReaderDirectoryEntry[] => {
    if (entry.isDirectory()) {
      return [{ name: entry.name, path: resolve(directory, entry.name), type: "directory" }];
    }
    if (!entry.isFile()) return [];
    const kind = readerFileKind(entry.name);
    return kind
      ? [{ name: entry.name, path: resolve(directory, entry.name), type: "file", kind }]
      : [];
  }).sort((left, right) => {
    if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, {
      numeric: true,
      sensitivity: "base"
    });
  });
}

export function filterReaderDirectoryEntries(
  entries: ReaderDirectoryEntry[],
  query: string
): ReaderDirectoryEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  return needle
    ? entries.filter(({ name }) => name.toLocaleLowerCase().includes(needle))
    : entries;
}

export function readerDirectoryBreadcrumb(
  rootDirectory: string,
  directory: string,
  width: number
): string {
  const prefix = "  Files  ";
  const root = resolve(rootDirectory);
  const current = resolve(directory);
  const relativePath = relative(root, current);
  const segments = relativePath && relativePath !== "."
    ? relativePath.split(sep).filter(Boolean)
    : [];
  const rootLabel = basename(root) || root;
  for (let tailCount = segments.length; tailCount >= 0; tailCount -= 1) {
    const omitted = segments.length - tailCount;
    const tail = tailCount > 0 ? segments.slice(-tailCount) : [];
    const labels = omitted > 0
      ? [rootLabel, "…", ...tail]
      : [rootLabel, ...segments];
    const breadcrumb = `${prefix}${labels.join(" / ")}`;
    if (stringWidth(breadcrumb) <= width) return breadcrumb;
  }
  return truncateStatus(`${prefix}${segments.at(-1) ?? rootLabel}`, Math.max(1, width));
}

function readerKindLabel(kind: NonNullable<ReaderDirectoryEntry["kind"]>): string {
  if (kind === "markdown") return "Markdown";
  if (kind === "notebook") return "Notebook";
  return kind.toUpperCase();
}

function headingSlug(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, "")
    .replace(/\s+/gu, "-");
}

class TerminalReader {
  readonly #writer = new TerminalWriter(process.stdout);
  #mathRenderer?: Promise<MathRenderer>;
  readonly #transmitter = new KittyImageTransmitter(selectImageTransmissionMode());
  readonly #responseFilter = new TerminalResponseFilter((imageId) =>
    imageId === KITTY_QUERY_IMAGE_ID
    || (imageId >= TFORMULA_IMAGE_ID_MIN && imageId <= TFORMULA_IMAGE_ID_MAX)
  );
  readonly #startupResponseFilter = new TerminalProbeResponseFilter();
  readonly #decoder = new StringDecoder("utf8");
  readonly #uploaded = new Map<string, UploadedAsset>();
  readonly #imageCache = new ReaderImageCache();
  readonly #blockedAssets = new Set<string>();
  readonly #layoutCache = new WeakMap<ReaderDocument, Map<string, ReaderLayout>>();
  readonly #placementAssetKeys = new WeakMap<ReaderPlacement, string>();
  readonly #maxTerminalImages = readerTerminalImageLimit();
  #nextImageId = TFORMULA_IMAGE_ID_MIN;
  #nextPlacementId = 1;
  #graphicsAvailable: boolean;
  #document: ReaderDocument;
  #layout!: ReaderLayout;
  #offset = 0;
  #renderVersion = 0;
  #renderTail = Promise.resolve();
  #viewTail = Promise.resolve();
  #renderPending = false;
  #renderRunning = false;
  #closing = false;
  #searching = false;
  #searchQuery = "";
  #lastSearch = "";
  #statusMessage = "";
  #rawMode = false;
  #showToc = false;
  #tocIndex = 0;
  #showFiles = false;
  #fileEntries: ReaderDirectoryEntry[] = [];
  #fileIndex = 0;
  #loadingFiles = false;
  #fileLoadVersion = 0;
  #fileRootDirectory = "";
  #fileDirectory = "";
  #fileParents: Array<{ directory: string; selectedPath: string }> = [];
  #fileQuery = "";
  #fileSearching = false;
  #activeLinkIndex?: number;
  #openingDocument = false;
  #switchingView = false;
  #imageScale = 1;
  readonly #history: Array<{ document: ReaderDocument; offset: number; rawMode: boolean }> = [];
  readonly #ownedDocuments = new Set<ReaderDocument>();
  #resolveExit?: (code: number) => void;
  #previousRaw = false;
  #responseTailTimer?: NodeJS.Timeout;
  #startupProbePending: boolean;
  #startupProbeTimer?: NodeJS.Timeout;
  #startupProbeCapture = "";

  constructor(
    readonly options: ReaderCliOptions,
    readonly capabilities: TerminalCapabilities,
    document: ReaderDocument,
    startupProbePending: boolean
  ) {
    this.#document = document;
    this.#ownedDocuments.add(document);
    this.#graphicsAvailable = capabilities.kittyGraphics;
    this.#startupProbePending = startupProbePending;
    this.#relayout();
  }

  get columns(): number {
    return Math.max(2, process.stdout.columns ?? 80);
  }

  get rows(): number {
    return Math.max(3, process.stdout.rows ?? 24);
  }

  get viewportRows(): number {
    return Math.max(1, this.rows - 1);
  }

  get contentViewportRows(): number {
    return Math.max(1, this.viewportRows - (this.#layout?.stickyLines?.length ?? 0));
  }

  #layoutCacheKey(imageScale = this.#imageScale): string {
    return [
      this.#rawMode ? "source" : "rendered",
      this.#graphicsAvailable ? "graphics" : "text",
      this.columns,
      this.viewportRows,
      this.capabilities.cell.width,
      this.capabilities.cell.height,
      this.options.scale,
      imageScale,
      this.#document.viewKey ?? "default"
    ].join(":");
  }

  #cachedLayout(key: string): ReaderLayout | undefined {
    const cache = this.#layoutCache.get(this.#document);
    const layout = cache?.get(key);
    if (!layout || !cache) return undefined;
    cache.delete(key);
    cache.set(key, layout);
    return layout;
  }

  #rememberLayout(key: string, layout: ReaderLayout): void {
    let cache = this.#layoutCache.get(this.#document);
    if (!cache) {
      cache = new Map();
      this.#layoutCache.set(this.#document, cache);
    }
    cache.delete(key);
    cache.set(key, layout);
    while (cache.size > 12) cache.delete(cache.keys().next().value!);
  }

  #relayout(): void {
    const cacheKey = this.#layoutCacheKey();
    const cached = this.#cachedLayout(cacheKey);
    if (cached) {
      this.#layout = cached;
      this.#offset = this.#clampOffset(this.#offset);
      this.#activeLinkIndex = undefined;
      return;
    }
    const sourceKind = readerFileKind(this.#document.path);
    const sourceLanguage = sourceKind === "notebook" ? "json"
      : sourceKind === "jsonl" ? "json"
        : sourceKind && ["markdown", "json", "yaml", "toml", "xml", "csv", "tsv", "html"]
          .includes(sourceKind)
          ? sourceKind
          : undefined;
    const displayedDocument: ReaderDocument = this.#rawMode && this.#document.source
      ? {
          ...this.#document,
          grid: undefined,
          root: {
            type: "root",
            children: [{
              type: "code",
              value: this.#document.source.replace(/\n$/u, ""),
              lang: sourceLanguage
            }]
          }
        }
      : this.#document;
    this.#layout = layoutReaderDocument(displayedDocument, {
      columns: this.columns,
      viewportRows: this.viewportRows,
      cell: this.capabilities.cell,
      scale: this.options.scale,
      imageScale: this.#imageScale,
      graphics: this.#graphicsAvailable
    });
    this.#rememberLayout(cacheKey, this.#layout);
    this.#offset = this.#clampOffset(this.#offset);
    this.#activeLinkIndex = undefined;
  }

  #clampOffset(value: number): number {
    const maximum = Math.max(0, this.#layout.lines.length - this.contentViewportRows);
    return Math.max(0, Math.min(maximum, Math.floor(value)));
  }

  #allocateImageId(): number {
    const imageId = this.#nextImageId;
    this.#nextImageId += 1;
    if (this.#nextImageId > TFORMULA_IMAGE_ID_MAX) this.#nextImageId = TFORMULA_IMAGE_ID_MIN;
    return imageId;
  }

  #allocatePlacementId(): number {
    const placementId = this.#nextPlacementId;
    this.#nextPlacementId = this.#nextPlacementId >= 0x7fffffff ? 1 : this.#nextPlacementId + 1;
    return placementId;
  }

  #touchUploaded(key: string): UploadedAsset | undefined {
    const uploaded = this.#uploaded.get(key);
    if (!uploaded) return undefined;
    this.#uploaded.delete(key);
    this.#uploaded.set(key, uploaded);
    return uploaded;
  }

  #pruneUploaded(protectedKeys: ReadonlySet<string>): string {
    const evictions = selectTerminalImageEvictions(
      this.#uploaded.keys(),
      protectedKeys,
      this.#maxTerminalImages
    );
    return evictions.map((key) => {
      const uploaded = this.#uploaded.get(key);
      this.#uploaded.delete(key);
      return uploaded ? kittyDeleteImage(uploaded.imageId) : "";
    }).join("");
  }

  #imageRequest(asset: ReaderImageAsset): CanonicalImageRequest {
    return canonicalImageRequest(
      asset,
      this.#layout.contentWidth,
      this.viewportRows,
      this.capabilities.cell
    );
  }

  #knownAssetKey(placement: ReaderPlacement): string | undefined {
    if (placement.asset.kind === "image") return this.#imageRequest(placement.asset).key;
    return this.#placementAssetKeys.get(placement);
  }

  #appendPlacements(
    graphics: string[],
    assets: Array<{ visible: VisibleReaderPlacement; key: string }>
  ): void {
    for (const { visible, key } of assets) {
      const uploaded = this.#touchUploaded(key);
      if (!uploaded) continue;
      const { placement } = visible;
      graphics.push(
        cursorPosition(visible.screenRow + 1, placement.col + 1),
        kittyPlaceImage(
          uploaded.imageId,
          this.#allocatePlacementId(),
          placement.columns,
          visible.rows,
          sourceRectangleForVisiblePlacement(visible, uploaded.width, uploaded.height)
        )
      );
    }
  }

  #prepareImageAsset(
    asset: ReaderImageAsset,
    request: CanonicalImageRequest
  ): Promise<PreparedAsset> {
    return this.#imageCache.prepare(asset, request);
  }

  #loadMathRenderer(): Promise<MathRenderer> {
    this.#mathRenderer ??= import("./math-renderer.js").then(({ MathRenderer }) =>
      new MathRenderer());
    return this.#mathRenderer;
  }

  async #prepareAsset(placement: ReaderPlacement): Promise<{
    key: string;
    prepared?: PreparedAsset;
  }> {
    const knownKey = this.#placementAssetKeys.get(placement);
    if (knownKey && (this.#touchUploaded(knownKey) || this.#blockedAssets.has(knownKey))) {
      return { key: knownKey };
    }
    const widthPx = Math.max(1, Math.round(placement.columns * this.capabilities.cell.width));
    const heightPx = Math.max(1, Math.round(placement.rows * this.capabilities.cell.height));
    if (placement.asset.kind === "image") {
      const request = this.#imageRequest(placement.asset);
      this.#placementAssetKeys.set(placement, request.key);
      if (this.#touchUploaded(request.key) || this.#blockedAssets.has(request.key)) {
        return { key: request.key };
      }
      return {
        key: request.key,
        prepared: await this.#prepareImageAsset(placement.asset, request)
      };
    }

    const region: FormulaRegion = {
      startRow: 0,
      endRow: placement.rows - 1,
      startCol: 0,
      endCol: placement.columns,
      latex: placement.asset.latex,
      display: placement.asset.display,
      confidence: "explicit",
      compact: !placement.asset.display
    };
    const renderer = await this.#loadMathRenderer();
    const rendered = await renderer.render(
      region,
      placement.columns,
      placement.rows,
      this.capabilities,
      this.options.scale
    );
    const resource = this.#document.math.get(placement.asset.key);
    if (resource && (!resource.aspectRatio || !resource.heightEx)) {
      resource.aspectRatio = rendered.naturalAspectRatio;
      resource.heightEx = rendered.naturalHeightEx;
      // Keep the already-visible estimate stable, but ensure the next resize,
      // raw-view toggle, or return navigation uses measured geometry.
      this.#layoutCache.delete(this.#document);
    }
    const prepared = {
      key: `math\0${rendered.cacheKey}`,
      png: rendered.png,
      width: rendered.widthPx,
      height: rendered.heightPx
    };
    this.#placementAssetKeys.set(placement, prepared.key);
    return { key: prepared.key, prepared };
  }

  #visiblePlacements(): VisibleReaderPlacement[] {
    if (this.#showToc || this.#showFiles) return [];
    const stickyRows = this.#layout.stickyLines?.length ?? 0;
    return visibleReaderPlacements(
      this.#layout.placements,
      this.#offset,
      this.contentViewportRows
    ).map((visible) => ({ ...visible, screenRow: visible.screenRow + stickyRows }));
  }

  #tocScreenLines(): StyledSpan[][] {
    const lines: StyledSpan[][] = [[
      { text: "  Table of contents", style: { bold: true, color: "accent" } }
    ], []];
    const available = Math.max(1, this.viewportRows - 2);
    const maximumStart = Math.max(0, this.#layout.headings.length - available);
    const start = Math.max(0, Math.min(maximumStart, this.#tocIndex - Math.floor(available / 2)));
    for (let index = start; index < Math.min(this.#layout.headings.length, start + available); index += 1) {
      const heading = this.#layout.headings[index]!;
      const indentation = `  ${"  ".repeat(Math.max(0, heading.depth - 1))}`;
      const label = truncateStatus(
        heading.text || "(untitled)",
        Math.max(1, this.columns - stringWidth(indentation) - 1)
      );
      lines.push([
        { text: indentation },
        {
          text: label,
          style: index === this.#tocIndex
            ? { inverse: true, bold: true }
            : { color: heading.depth <= 2 ? "accent" : undefined }
        }
      ]);
    }
    return lines;
  }

  #fileScreenLines(): StyledSpan[][] {
    const entries = filterReaderDirectoryEntries(this.#fileEntries, this.#fileQuery);
    const heading = readerDirectoryBreadcrumb(
      this.#fileRootDirectory || this.#fileDirectory,
      this.#fileDirectory,
      Math.max(1, this.columns - 1)
    );
    const lines: StyledSpan[][] = [[
      { text: heading, style: { bold: true, color: "accent" } }
    ], []];
    if (entries.length === 0) {
      lines.push([{
        text: this.#fileQuery
          ? "  (no matching folders or supported files)"
          : "  (no folders or supported files)",
        style: { italic: true, color: "muted" }
      }]);
      return lines;
    }

    const available = Math.max(1, this.viewportRows - 2);
    const maximumStart = Math.max(0, entries.length - available);
    const start = Math.max(0, Math.min(
      maximumStart,
      this.#fileIndex - Math.floor(available / 2)
    ));
    const currentPath = resolve(this.#document.path);
    for (let index = start; index < Math.min(entries.length, start + available); index += 1) {
      const entry = entries[index]!;
      const selected = index === this.#fileIndex;
      const marker = entry.type === "directory"
        ? "▸ "
        : entry.path === currentPath ? "● " : "  ";
      const labelCandidate = `  ${entry.type === "directory"
        ? "Folder"
        : readerKindLabel(entry.kind!)}`;
      const contentWidth = Math.max(1, this.columns - stringWidth(marker) - 1);
      const label = stringWidth(labelCandidate) < contentWidth ? labelCandidate : "";
      const name = truncateStatus(
        `${entry.name}${entry.type === "directory" ? "/" : ""}`,
        Math.max(1, contentWidth - stringWidth(label))
      );
      lines.push([
        { text: marker, style: { color: "accent" } },
        {
          text: name,
          style: selected
            ? { inverse: true, bold: true }
            : entry.type === "directory" ? { bold: true, color: "accent" } : undefined
        },
        {
          text: label,
          style: selected
            ? { inverse: true, dim: true }
            : { color: "muted", dim: true }
        }
      ]);
    }
    return lines;
  }

  #screenText(): string {
    const dark = isDarkColor(this.capabilities.background);
    const chunks: string[] = [];
    const tocLines = this.#showToc ? this.#tocScreenLines() : undefined;
    const fileLines = this.#showFiles ? this.#fileScreenLines() : undefined;
    const panelLines = fileLines ?? tocLines;
    const activeLink = this.#activeLinkIndex === undefined
      ? undefined
      : this.#layout.links[this.#activeLinkIndex];
    const stickyLines = !panelLines ? this.#layout.stickyLines ?? [] : [];
    for (let screenRow = 0; screenRow < this.viewportRows; screenRow += 1) {
      const line = panelLines?.[screenRow] ?? (!panelLines
        ? screenRow < stickyLines.length
          ? stickyLines[screenRow]?.spans
          : this.#layout.lines[this.#offset + screenRow - stickyLines.length]?.spans
        : undefined);
      chunks.push(`${ESC}[${screenRow + 1};1H${ESC}[2K`);
      if (line) chunks.push(renderSpans(line, dark, activeLink?.href));
    }
    const percent = this.#layout.lines.length <= this.contentViewportRows
      ? 100
      : Math.round((this.#offset / Math.max(1, this.#layout.lines.length - this.contentViewportRows)) * 100);
    const pageHint = this.#document.pages
      ? this.#document.pages.mode === "page"
        ? " · [/] page · v reflow"
        : " · v page view"
      : "";
    const gridHint = this.#document.grid && !this.#rawMode ? " · ←/→ columns" : "";
    const matchingFiles = this.#showFiles
      ? filterReaderDirectoryEntries(this.#fileEntries, this.#fileQuery)
      : [];
    const folderCount = this.#fileEntries.filter(({ type }) => type === "directory").length;
    const fileCount = this.#fileEntries.length - folderCount;
    const fileBackHint = this.#fileParents.length > 0 ? "← up" : "← close";
    const status = this.#showFiles
      ? this.#loadingFiles
        ? "Loading folder…  Esc/l cancel"
        : this.#fileSearching
          ? `Filter /${this.#fileQuery}  Enter apply · Esc clear`
          : this.#statusMessage
            ? this.#statusMessage
            : this.#fileQuery
              ? `${matchingFiles.length}/${this.#fileEntries.length} matches  ↑/↓ select · → open · ${fileBackHint} · / filter`
              : `${folderCount} folders · ${fileCount} files  ↑/↓ select · → open · ${fileBackHint} · / filter`
      : this.#showToc
      ? "Table of contents  j/k select · Enter jump · t/Esc close"
      : this.#searching
      ? `/${this.#searchQuery}`
      : this.#statusMessage
        ? this.#statusMessage
        : `${this.#document.title}${this.#document.label ? ` [${this.#document.label}]` : ""}${this.#rawMode ? " [source]" : ""}  ${percent}%  ${this.#layout.lines.length} lines  j/k scroll${gridHint}${pageHint} · l files · r source · q quit`;
    chunks.push(
      `${ESC}[${this.rows};1H${ESC}[2K${ESC}[7m${fitStatus(status, Math.max(1, this.columns - 1))}${ESC}[0m`
    );
    return chunks.join("");
  }

  #requestRender(): void {
    if (this.#closing) return;
    this.#renderVersion += 1;
    this.#renderPending = true;
    this.#startRenderLoop();
  }

  #startRenderLoop(): void {
    if (this.#renderRunning || this.#closing) return;
    this.#renderRunning = true;
    const task = (async () => {
      while (!this.#closing && this.#renderPending) {
        this.#renderPending = false;
        await this.#render(this.#renderVersion);
      }
    })().catch((error: unknown) => {
      this.#statusMessage = `render failed: ${error instanceof Error ? error.message : String(error)}`;
    }).finally(() => {
      this.#renderRunning = false;
      if (this.#renderPending && !this.#closing) this.#startRenderLoop();
    });
    this.#renderTail = task;
  }

  async #render(version: number): Promise<void> {
    if (this.#closing || version !== this.#renderVersion) return;
    const placements = this.#graphicsAvailable ? this.#visiblePlacements() : [];
    const known = placements.map((visible) => ({
      visible,
      key: this.#knownAssetKey(visible.placement)
    }));
    if (known.length > 0 && known.every(({ key }) =>
      key !== undefined && !this.#blockedAssets.has(key) && this.#uploaded.has(key))) {
      const assets = known.map(({ visible, key }) => ({ visible, key: key! }));
      const protectedKeys = new Set(assets.map(({ key }) => key));
      const graphics = [
        kittyDeletePlacementsByZIndex(),
        this.#pruneUploaded(protectedKeys),
        this.#screenText()
      ];
      this.#appendPlacements(graphics, assets);
      graphics.push(cursorPosition(this.rows, 1));
      await this.#writer.writeIf(
        synchronizedOutput(graphics.join("")),
        () => !this.#closing && version === this.#renderVersion
      );
      return;
    }
    const initialStatus = this.#statusMessage;
    const text = synchronizedOutput(
      `${this.#graphicsAvailable ? kittyDeletePlacementsByZIndex() : ""}`
      + `${this.#screenText()}${cursorPosition(this.rows, 1)}`
    );
    const displayed = await this.#writer.writeIf(
      text,
      () => !this.#closing && version === this.#renderVersion
    );
    if (!displayed || this.#closing || version !== this.#renderVersion || placements.length === 0) {
      return;
    }
    const results = await Promise.all(placements.map(async (visible) => {
      try {
        return {
          ok: true as const,
          visible,
          asset: await this.#prepareAsset(visible.placement)
        };
      } catch (error) {
        return { ok: false as const, visible, error };
      }
    }));
    if (this.#closing || version !== this.#renderVersion) return;
    const resolved: Array<{
      visible: VisibleReaderPlacement;
      asset: { key: string; prepared?: PreparedAsset };
    }> = [];
    let resourceFailed = false;
    for (const result of results) {
      if (result.ok) {
        resolved.push(result);
        continue;
      }
      const message = result.error instanceof Error
        ? result.error.message
        : String(result.error);
      this.#statusMessage = `asset failed: ${message}`;
      const failedAsset = result.visible.placement.asset;
      if (failedAsset.kind === "math") {
        const resource = this.#document.math.get(failedAsset.key);
        if (resource) resource.error = message;
        resourceFailed = true;
      } else {
        const resource = [...this.#document.images.values()]
          .find(({ path }) => path === failedAsset.path);
        if (resource) resource.error = message;
        resourceFailed = true;
      }
    }
    if (resourceFailed) {
      this.#layoutCache.delete(this.#document);
      this.#relayout();
      this.#requestRender();
      return;
    }
    const usable = resolved.filter(({ asset }) => !this.#blockedAssets.has(asset.key));

    for (const { asset } of usable) {
      if (this.#touchUploaded(asset.key) || !asset.prepared) continue;
      const uploaded = {
        key: asset.key,
        imageId: this.#allocateImageId(),
        width: asset.prepared.width,
        height: asset.prepared.height
      };
      await this.#writer.write(
        this.#transmitter.transmitPayload(asset.prepared.png, uploaded.imageId)
      );
      this.#uploaded.set(asset.key, uploaded);
      this.#imageCache.release(asset.key);
      if (this.#closing || version !== this.#renderVersion) return;
    }

    const protectedKeys = new Set(usable.map(({ asset }) => asset.key));
    const graphics: string[] = [
      kittyDeletePlacementsByZIndex(),
      this.#pruneUploaded(protectedKeys)
    ];
    if (this.#statusMessage !== initialStatus) graphics.push(this.#screenText());
    this.#appendPlacements(
      graphics,
      usable.map(({ visible, asset }) => ({ visible, key: asset.key }))
    );
    graphics.push(cursorPosition(this.rows, 1));
    const transaction = synchronizedOutput(graphics.join(""));
    await this.#writer.writeIf(transaction, () => !this.#closing && version === this.#renderVersion);
  }

  #scroll(delta: number): void {
    const next = this.#clampOffset(this.#offset + delta);
    if (next === this.#offset) return;
    this.#offset = next;
    this.#statusMessage = "";
    this.#requestRender();
  }

  #jump(value: number): void {
    const next = this.#clampOffset(value);
    if (next === this.#offset) return;
    this.#offset = next;
    this.#statusMessage = "";
    this.#requestRender();
  }

  #changeImageScale(direction: -1 | 0 | 1): void {
    if (!this.#graphicsAvailable) {
      this.#statusMessage = "image zoom requires Kitty graphics";
      this.#requestRender();
      return;
    }
    const images = this.#layout.placements.filter(({ asset }) => asset.kind === "image");
    if (images.length === 0) {
      this.#statusMessage = "no renderable images in this view";
      this.#requestRender();
      return;
    }

    let currentIndex = 0;
    for (let index = 1; index < IMAGE_SCALE_LEVELS.length; index += 1) {
      if (Math.abs(IMAGE_SCALE_LEVELS[index]! - this.#imageScale)
        < Math.abs(IMAGE_SCALE_LEVELS[currentIndex]! - this.#imageScale)) {
        currentIndex = index;
      }
    }
    const nextIndex = direction === 0
      ? IMAGE_SCALE_LEVELS.indexOf(1)
      : Math.max(0, Math.min(IMAGE_SCALE_LEVELS.length - 1, currentIndex + direction));
    const nextScale = IMAGE_SCALE_LEVELS[nextIndex]!;
    if (nextScale === this.#imageScale) {
      this.#statusMessage = `image zoom ${Math.round(nextScale * 100)}%`;
      this.#requestRender();
      return;
    }

    const oldMaximum = Math.max(1, this.#layout.lines.length - this.contentViewportRows);
    const progress = this.#offset / oldMaximum;
    const center = this.#offset + this.viewportRows / 2;
    const visibleImages = images.filter((placement) =>
      placement.row < this.#offset + this.viewportRows
      && placement.row + placement.rows > this.#offset
    );
    const anchor = visibleImages.reduce<ReaderPlacement | undefined>((nearest, placement) => {
      if (!nearest) return placement;
      const distance = (candidate: ReaderPlacement): number => {
        if (center < candidate.row) return candidate.row - center;
        if (center > candidate.row + candidate.rows) return center - candidate.row - candidate.rows;
        return 0;
      };
      return distance(placement) < distance(nearest) ? placement : nearest;
    }, undefined);
    const anchorIndex = anchor ? images.indexOf(anchor) : -1;
    // When the image starts on screen, keep its top edge stationary so zoom
    // grows downward naturally. Once the reader is already inside a tall
    // image, preserve the point at the viewport center instead.
    const anchorStartsOnScreen = Boolean(anchor && anchor.row >= this.#offset);
    const anchorPoint = anchor
      ? anchorStartsOnScreen
        ? anchor.row
        : Math.max(anchor.row, Math.min(anchor.row + anchor.rows, center))
      : 0;
    const anchorFraction = anchor
      ? (anchorPoint - anchor.row) / Math.max(1, anchor.rows)
      : 0;
    const anchorScreenRow = anchor ? anchorPoint - this.#offset : 0;

    this.#imageScale = nextScale;
    const cacheKey = this.#layoutCacheKey(nextScale);
    const cached = this.#cachedLayout(cacheKey);
    if (cached) this.#layout = cached;
    else {
      this.#layout = rescaleReaderImages(this.#layout, {
        viewportRows: this.viewportRows,
        cell: this.capabilities.cell,
        imageScale: nextScale
      });
      this.#rememberLayout(cacheKey, this.#layout);
    }
    this.#offset = this.#clampOffset(this.#offset);
    this.#activeLinkIndex = undefined;
    const resizedImages = this.#layout.placements.filter(({ asset }) => asset.kind === "image");
    const resizedAnchor = anchorIndex >= 0 ? resizedImages[anchorIndex] : undefined;
    if (resizedAnchor) {
      this.#offset = this.#clampOffset(Math.round(
        resizedAnchor.row + resizedAnchor.rows * anchorFraction - anchorScreenRow
      ));
    } else {
      const newMaximum = Math.max(0, this.#layout.lines.length - this.contentViewportRows);
      this.#offset = this.#clampOffset(Math.round(progress * newMaximum));
    }
    this.#statusMessage = nextScale === 1
      ? "image size: fit (100%)"
      : `image zoom: ${Math.round(nextScale * 100)}% · 0 reset`;
    this.#requestRender();
  }

  #toggleToc(): void {
    if (!this.#showToc && this.#layout.headings.length === 0) {
      this.#statusMessage = "this view has no headings";
      this.#requestRender();
      return;
    }
    this.#showToc = !this.#showToc;
    this.#searching = false;
    if (this.#showToc) {
      let current = -1;
      for (let index = 0; index < this.#layout.headings.length; index += 1) {
        if (this.#layout.headings[index]!.line <= this.#offset) current = index;
        else break;
      }
      this.#tocIndex = Math.max(0, current);
    }
    this.#statusMessage = "";
    this.#requestRender();
  }

  #handleTocInput(data: string): void {
    const sequences = data.match(/\x1b\[[0-9;?]*[~A-Za-z]|[\s\S]/gu) ?? [];
    for (const sequence of sequences) {
      if (sequence === "t" || sequence === "q" || sequence === "\x1b") {
        this.#toggleToc();
        return;
      }
      if (sequence === "j" || sequence === "\x1b[B") {
        this.#tocIndex = Math.min(this.#layout.headings.length - 1, this.#tocIndex + 1);
        this.#requestRender();
      } else if (sequence === "k" || sequence === "\x1b[A") {
        this.#tocIndex = Math.max(0, this.#tocIndex - 1);
        this.#requestRender();
      } else if (sequence === "g") {
        this.#tocIndex = 0;
        this.#requestRender();
      } else if (sequence === "G") {
        this.#tocIndex = Math.max(0, this.#layout.headings.length - 1);
        this.#requestRender();
      } else if (sequence === "\r" || sequence === "\n") {
        const heading = this.#layout.headings[this.#tocIndex];
        this.#showToc = false;
        if (heading) {
          this.#offset = this.#clampOffset(heading.line);
          this.#statusMessage = heading.text;
        }
        this.#requestRender();
        return;
      }
    }
  }

  #closeFileList(): void {
    this.#fileLoadVersion += 1;
    this.#loadingFiles = false;
    this.#showFiles = false;
    this.#fileEntries = [];
    this.#fileParents = [];
    this.#fileQuery = "";
    this.#fileSearching = false;
    this.#statusMessage = "";
    this.#requestRender();
  }

  async #loadFileDirectory(directoryPath: string, selectedPath?: string): Promise<boolean> {
    const directory = resolve(directoryPath);
    const version = ++this.#fileLoadVersion;
    this.#loadingFiles = true;
    this.#fileSearching = false;
    this.#fileQuery = "";
    this.#statusMessage = "";
    this.#requestRender();
    try {
      const entries = await listReaderDirectory(directory);
      if (this.#closing || version !== this.#fileLoadVersion) return false;
      this.#fileDirectory = directory;
      this.#fileEntries = entries;
      const selected = selectedPath
        ? entries.findIndex((entry) => entry.path === resolve(selectedPath))
        : -1;
      this.#fileIndex = selected >= 0 ? selected : 0;
      return true;
    } catch (error) {
      if (version === this.#fileLoadVersion) {
        this.#statusMessage = `cannot open folder: ${error instanceof Error ? error.message : String(error)}`;
      }
      return false;
    } finally {
      if (version === this.#fileLoadVersion) {
        this.#loadingFiles = false;
        this.#requestRender();
      }
    }
  }

  async #toggleFileList(): Promise<void> {
    if (this.#showFiles || this.#loadingFiles) {
      this.#closeFileList();
      return;
    }
    this.#searching = false;
    this.#showToc = false;
    this.#fileRootDirectory = dirname(resolve(this.#document.path));
    this.#fileDirectory = this.#fileRootDirectory;
    this.#fileParents = [];
    this.#fileEntries = [];
    this.#fileIndex = 0;
    this.#fileQuery = "";
    this.#fileSearching = false;
    this.#showFiles = true;
    await this.#loadFileDirectory(this.#fileRootDirectory, this.#document.path);
  }

  #handleFileFilterInput(data: string): void {
    const sequences = data.match(/\x1b\[[0-9;?]*[~A-Za-z]|[\s\S]/gu) ?? [];
    for (const sequence of sequences) {
      if (sequence === "\x03") {
        this.#resolveExit?.(0);
        return;
      }
      if (sequence === "\r" || sequence === "\n") {
        this.#fileSearching = false;
        this.#requestRender();
        return;
      }
      if (sequence === "\x1b") {
        this.#fileSearching = false;
        this.#fileQuery = "";
        this.#fileIndex = 0;
        this.#requestRender();
        return;
      }
      if (sequence === "\x7f" || sequence === "\b") {
        const characters = Array.from(this.#fileQuery);
        if (characters.length > 0) this.#fileQuery = characters.slice(0, -1).join("");
        else this.#fileSearching = false;
        this.#fileIndex = 0;
        this.#requestRender();
      } else if (sequence.length === 1 && sequence >= " ") {
        this.#fileQuery += sequence;
        this.#fileIndex = 0;
        this.#requestRender();
      }
    }
  }

  async #goToParentFileDirectory(): Promise<void> {
    if (this.#loadingFiles) return;
    const parent = this.#fileParents.pop();
    if (!parent) {
      this.#closeFileList();
      return;
    }
    if (!await this.#loadFileDirectory(parent.directory, parent.selectedPath)) {
      this.#fileParents.push(parent);
      this.#requestRender();
    }
  }

  #handleFileInput(data: string): void {
    if (this.#fileSearching) {
      this.#handleFileFilterInput(data);
      return;
    }
    const sequences = data.match(/\x1b\[[0-9;?]*[~A-Za-z]|[\s\S]/gu) ?? [];
    for (const sequence of sequences) {
      if (sequence === "\x03") {
        this.#resolveExit?.(0);
        return;
      }
      if (sequence === "l" || sequence === "q" || sequence === "\x1b") {
        this.#closeFileList();
        return;
      }
      if (this.#loadingFiles) return;
      const entries = filterReaderDirectoryEntries(this.#fileEntries, this.#fileQuery);
      if (sequence === "j" || sequence === "\x1b[B") {
        this.#fileIndex = Math.min(entries.length - 1, this.#fileIndex + 1);
        this.#fileIndex = Math.max(0, this.#fileIndex);
        this.#requestRender();
      } else if (sequence === "k" || sequence === "\x1b[A") {
        this.#fileIndex = Math.max(0, this.#fileIndex - 1);
        this.#requestRender();
      } else if (sequence === "g" || sequence === "\x1b[H" || sequence === "\x1b[1~") {
        this.#fileIndex = 0;
        this.#requestRender();
      } else if (sequence === "G" || sequence === "\x1b[F" || sequence === "\x1b[4~") {
        this.#fileIndex = Math.max(0, entries.length - 1);
        this.#requestRender();
      } else if (sequence === "\x1b[6~") {
        this.#fileIndex = Math.min(
          Math.max(0, entries.length - 1),
          this.#fileIndex + Math.max(1, this.viewportRows - 3)
        );
        this.#requestRender();
      } else if (sequence === "\x1b[5~") {
        this.#fileIndex = Math.max(0, this.#fileIndex - Math.max(1, this.viewportRows - 3));
        this.#requestRender();
      } else if (sequence === "/") {
        this.#fileSearching = true;
        this.#requestRender();
      } else if (sequence === "\x1b[D" || sequence === "\x7f" || sequence === "h") {
        this.#trackViewTask(this.#goToParentFileDirectory());
        return;
      } else if (sequence === "\r" || sequence === "\n" || sequence === "\x1b[C") {
        this.#trackViewTask(this.#openSelectedFile());
        return;
      }
    }
  }

  #toggleRaw(): void {
    if (!this.#document.source) {
      this.#statusMessage = "this document has no text source";
      this.#requestRender();
      return;
    }
    const oldMaximum = Math.max(1, this.#layout.lines.length - this.contentViewportRows);
    const progress = this.#offset / oldMaximum;
    this.#rawMode = !this.#rawMode;
    this.#showToc = false;
    this.#relayout();
    const newMaximum = Math.max(0, this.#layout.lines.length - this.contentViewportRows);
    this.#offset = this.#clampOffset(Math.round(progress * newMaximum));
    this.#statusMessage = this.#rawMode ? "source view" : "rendered view";
    this.#requestRender();
  }

  #changeGridColumn(direction: -1 | 1): void {
    const grid = !this.#rawMode ? this.#document.grid : undefined;
    if (!grid) {
      if (direction > 0) {
        this.#statusMessage = "this document has no horizontal grid view";
        this.#requestRender();
      } else this.#goBack();
      return;
    }
    const next = Math.max(0, Math.min(grid.headers.length - 1, grid.columnOffset + direction));
    if (next === grid.columnOffset) {
      this.#statusMessage = direction < 0 ? "first table column" : "last table column";
      this.#requestRender();
      return;
    }
    grid.columnOffset = next;
    this.#document.viewKey = `grid:${next}`;
    this.#layoutCache.delete(this.#document);
    this.#relayout();
    this.#statusMessage = `column window starts at ${next + 1}/${grid.headers.length} · ←/→ scroll`;
    this.#requestRender();
  }

  async #togglePageView(): Promise<void> {
    if (this.#switchingView) return;
    if (!this.#document.pages) {
      this.#statusMessage = "this document has no alternate page view";
      this.#requestRender();
      return;
    }
    if (this.#document.pages.mode === "reflow" && !this.#graphicsAvailable) {
      this.#statusMessage = "PDF page view requires Kitty graphics; reflow text remains available";
      this.#requestRender();
      return;
    }
    this.#switchingView = true;
    this.#statusMessage = this.#document.pages.mode === "page"
      ? "switching to reflow view…"
      : `rendering PDF page ${this.#document.pages.current}…`;
    this.#requestRender();
    try {
      await toggleReaderPageView(this.#document);
      if (this.#closing) return;
      this.#rawMode = false;
      this.#showToc = false;
      this.#layoutCache.delete(this.#document);
      this.#relayout();
      this.#offset = 0;
      const pages = this.#document.pages;
      this.#statusMessage = pages.mode === "page"
        ? `page ${pages.current}/${pages.count} · ${pages.backend} · [/] navigate · v reflow`
        : "PDF reflow view · v page view";
    } catch (error) {
      this.#statusMessage = `cannot switch PDF view: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.#switchingView = false;
      this.#requestRender();
    }
  }

  async #changePage(direction: -1 | 1): Promise<void> {
    const pages = this.#document.pages;
    if (this.#switchingView || !pages || pages.mode !== "page") return;
    const target = Math.max(1, Math.min(pages.count, pages.current + direction));
    if (target === pages.current) {
      this.#statusMessage = direction < 0 ? "first PDF page" : "last PDF page";
      this.#requestRender();
      return;
    }
    this.#switchingView = true;
    this.#statusMessage = `rendering PDF page ${target}…`;
    this.#requestRender();
    try {
      await changeReaderPage(this.#document, direction);
      if (this.#closing) return;
      this.#layoutCache.delete(this.#document);
      this.#relayout();
      this.#offset = 0;
      this.#statusMessage = `page ${pages.current}/${pages.count} · ${pages.backend}`;
    } catch (error) {
      this.#statusMessage = `cannot render PDF page ${target}: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.#switchingView = false;
      this.#requestRender();
    }
  }

  #trackViewTask(task: Promise<void>): void {
    this.#viewTail = Promise.all([this.#viewTail, task]).then(() => undefined);
  }

  #cycleLink(direction: 1 | -1): void {
    const count = this.#layout.links.length;
    if (count === 0) {
      this.#statusMessage = "no links in this view";
      this.#requestRender();
      return;
    }
    const current = this.#activeLinkIndex ?? (direction > 0 ? -1 : 0);
    this.#activeLinkIndex = (current + direction + count) % count;
    const link = this.#layout.links[this.#activeLinkIndex]!;
    if (link.line < this.#offset || link.line >= this.#offset + this.contentViewportRows) {
      this.#offset = this.#clampOffset(link.line - Math.floor(this.viewportRows / 3));
    }
    this.#statusMessage = `${link.label.trim() || "link"} → ${link.href}`;
    this.#requestRender();
  }

  #jumpToFragment(fragment: string): boolean {
    let target = fragment;
    try {
      target = decodeURIComponent(fragment);
    } catch {
      // Keep the literal fragment when it contains a malformed escape.
    }
    const slug = headingSlug(target);
    const heading = this.#layout.headings.find((candidate) =>
      headingSlug(candidate.text) === slug
      || candidate.text.toLocaleLowerCase() === target.toLocaleLowerCase()
    );
    if (!heading) return false;
    this.#offset = this.#clampOffset(heading.line);
    this.#statusMessage = heading.text;
    return true;
  }

  async #openDocumentPath(
    targetPath: string,
    displayName: string,
    fragment = "",
    context = "document"
  ): Promise<void> {
    if (this.#openingDocument) return;
    this.#openingDocument = true;
    this.#fileLoadVersion += 1;
    this.#loadingFiles = false;
    this.#fileSearching = false;
    this.#showFiles = false;
    this.#statusMessage = `opening ${displayName}…`;
    this.#requestRender();
    try {
      const next = await loadReaderDocument(targetPath);
      if (this.#closing) {
        await disposeReaderDocument(next);
        return;
      }
      this.#ownedDocuments.add(next);
      this.#history.push({
        document: this.#document,
        offset: this.#offset,
        rawMode: this.#rawMode
      });
      this.#document = next;
      this.#offset = 0;
      this.#rawMode = false;
      this.#showToc = false;
      this.#showFiles = false;
      this.#fileEntries = [];
      this.#fileParents = [];
      this.#fileQuery = "";
      this.#relayout();
      this.#statusMessage = "";
      if (fragment && !this.#jumpToFragment(fragment)) {
        this.#statusMessage = `heading not found: ${fragment}`;
      }
      this.#requestRender();
    } catch (error) {
      this.#statusMessage = `cannot open ${context}: ${error instanceof Error ? error.message : String(error)}`;
      this.#requestRender();
    } finally {
      this.#openingDocument = false;
    }
  }

  async #openSelectedFile(): Promise<void> {
    const entries = filterReaderDirectoryEntries(this.#fileEntries, this.#fileQuery);
    const entry = entries[this.#fileIndex];
    if (!entry) return;
    if (entry.type === "directory") {
      const parent = { directory: this.#fileDirectory, selectedPath: entry.path };
      this.#fileParents.push(parent);
      if (!await this.#loadFileDirectory(entry.path)) {
        this.#fileParents.pop();
        this.#requestRender();
      }
      return;
    }
    await this.#openDocumentPath(entry.path, entry.name, "", "file");
  }

  async #openActiveLink(): Promise<void> {
    if (this.#openingDocument) return;
    const link = this.#activeLinkIndex === undefined
      ? undefined
      : this.#layout.links[this.#activeLinkIndex];
    if (!link) {
      this.#statusMessage = "press Tab to select a link";
      this.#requestRender();
      return;
    }
    const href = link.href.trim();
    if (/^[a-z][a-z\d+.-]*:/iu.test(href)) {
      this.#statusMessage = `external link: ${href}`;
      this.#requestRender();
      return;
    }
    const hash = href.indexOf("#");
    const targetPart = hash >= 0 ? href.slice(0, hash) : href;
    const fragment = hash >= 0 ? href.slice(hash + 1) : "";
    if (!targetPart) {
      if (!fragment || !this.#jumpToFragment(fragment)) {
        this.#statusMessage = fragment ? `heading not found: ${fragment}` : href;
      }
      this.#requestRender();
      return;
    }

    let decodedTarget = targetPart.split("?", 1)[0]!;
    try {
      decodedTarget = decodeURIComponent(decodedTarget);
    } catch {
      // Let the filesystem report malformed literal paths naturally.
    }
    const targetPath = resolve(dirname(this.#document.path), decodedTarget);
    await this.#openDocumentPath(targetPath, decodedTarget, fragment, "link");
  }

  #goBack(): void {
    const previous = this.#history.pop();
    if (!previous) {
      this.#statusMessage = "no previous document";
      this.#requestRender();
      return;
    }
    this.#document = previous.document;
    this.#rawMode = previous.rawMode;
    this.#offset = previous.offset;
    this.#showToc = false;
    this.#showFiles = false;
    this.#fileEntries = [];
    this.#fileParents = [];
    this.#fileQuery = "";
    this.#fileSearching = false;
    this.#relayout();
    this.#offset = this.#clampOffset(previous.offset);
    this.#statusMessage = "back";
    this.#requestRender();
  }

  #jumpHeading(direction: 1 | -1): void {
    const headings = direction > 0
      ? this.#layout.headings
      : [...this.#layout.headings].reverse();
    const heading = headings.find((candidate) => direction > 0
      ? candidate.line > this.#offset
      : candidate.line < this.#offset);
    if (!heading) return;
    this.#offset = this.#clampOffset(heading.line);
    this.#statusMessage = heading.text;
    this.#requestRender();
  }

  #find(direction: 1 | -1): void {
    const query = (this.#searchQuery || this.#lastSearch).trim();
    if (!query) {
      this.#statusMessage = "no search text";
      this.#requestRender();
      return;
    }
    this.#lastSearch = query;
    const needle = query.toLocaleLowerCase();
    const start = direction > 0 ? this.#offset + 1 : this.#offset - 1;
    for (let step = 0; step < this.#layout.lines.length; step += 1) {
      const rawIndex = start + step * direction;
      const index = (rawIndex % this.#layout.lines.length + this.#layout.lines.length)
        % this.#layout.lines.length;
      if (this.#layout.lines[index]!.plain.toLocaleLowerCase().includes(needle)) {
        this.#offset = this.#clampOffset(index);
        this.#statusMessage = `match: ${query}`;
        this.#requestRender();
        return;
      }
    }
    this.#statusMessage = `not found: ${query}`;
    this.#requestRender();
  }

  #handleSearchInput(data: string): void {
    const characters = Array.from(data);
    for (let index = 0; index < characters.length; index += 1) {
      const character = characters[index]!;
      if (character === "\r" || character === "\n") {
        this.#searching = false;
        this.#find(1);
        const remaining = characters.slice(index + 1).join("");
        if (remaining) this.#handleInput(remaining);
        return;
      } else if (character === "\x1b") {
        this.#searching = false;
        this.#statusMessage = "";
        this.#requestRender();
        const remaining = characters.slice(index + 1).join("");
        if (remaining) this.#handleInput(remaining);
        return;
      } else if (character === "\x7f" || character === "\b") {
        this.#searchQuery = Array.from(this.#searchQuery).slice(0, -1).join("");
        this.#requestRender();
      } else if (character >= " ") {
        this.#searchQuery += character;
        this.#requestRender();
      }
    }
  }

  #handleInput(data: string): void {
    if (!data || this.#closing) return;
    if (this.#showFiles) {
      this.#handleFileInput(data);
      return;
    }
    if (this.#showToc) {
      this.#handleTocInput(data);
      return;
    }
    if (this.#searching) {
      this.#handleSearchInput(data);
      return;
    }
    const sequences = data.match(/\x1b\[[0-9;?]*[~A-Za-z]|[\s\S]/gu) ?? [];
    for (let index = 0; index < sequences.length; index += 1) {
      const sequence = sequences[index]!;
      if (sequence === "q" || sequence === "\x03") {
        this.#resolveExit?.(0);
        return;
      }
      if (sequence === "j" || sequence === "\x1b[B") this.#scroll(1);
      else if (sequence === "k" || sequence === "\x1b[A") this.#scroll(-1);
      else if (sequence === " " || sequence === "\x06" || sequence === "\x1b[6~") {
        this.#scroll(Math.max(1, this.contentViewportRows - 2));
      } else if (sequence === "b" || sequence === "\x02" || sequence === "\x1b[5~") {
        this.#scroll(-Math.max(1, this.contentViewportRows - 2));
      } else if (sequence === "g" || sequence === "\x1b[H" || sequence === "\x1b[1~") {
        this.#jump(0);
      } else if (sequence === "G" || sequence === "\x1b[F" || sequence === "\x1b[4~") {
        this.#jump(this.#layout.lines.length);
      } else if (sequence === "/") {
        this.#searching = true;
        this.#searchQuery = "";
        this.#requestRender();
        const remaining = sequences.slice(index + 1).join("");
        if (remaining) this.#handleSearchInput(remaining);
        return;
      } else if (sequence === "n") this.#find(1);
      else if (sequence === "N") this.#find(-1);
      else if (sequence === "t") {
        this.#toggleToc();
        const remaining = sequences.slice(index + 1).join("");
        if (remaining && this.#showToc) this.#handleTocInput(remaining);
        return;
      }
      else if (sequence === "l") {
        this.#trackViewTask(this.#toggleFileList());
        return;
      }
      else if (sequence === "r") this.#toggleRaw();
      else if (sequence === "v") this.#trackViewTask(this.#togglePageView());
      else if (sequence === "+" || sequence === "=") this.#changeImageScale(1);
      else if (sequence === "-") this.#changeImageScale(-1);
      else if (sequence === "0") this.#changeImageScale(0);
      else if (sequence === "\t") this.#cycleLink(1);
      else if (sequence === "\x1b[Z") this.#cycleLink(-1);
      else if (sequence === "\r" || sequence === "\n") {
        this.#trackViewTask(this.#openActiveLink());
      }
      else if (sequence === "\x1b[C") this.#changeGridColumn(1);
      else if (sequence === "\x1b[D") this.#changeGridColumn(-1);
      else if (sequence === "h" || sequence === "\x7f") this.#goBack();
      else if (sequence === "]") {
        if (this.#document.pages?.mode === "page") this.#trackViewTask(this.#changePage(1));
        else this.#jumpHeading(1);
      } else if (sequence === "[") {
        if (this.#document.pages?.mode === "page") this.#trackViewTask(this.#changePage(-1));
        else this.#jumpHeading(-1);
      }
    }
  }

  readonly #onData = (chunk: Buffer | string): void => {
    if (this.#responseTailTimer) clearTimeout(this.#responseTailTimer);
    this.#responseTailTimer = undefined;
    const data = Buffer.isBuffer(chunk) ? this.#decoder.write(chunk) : chunk;
    const filtered = this.#responseFilter.push(data);
    const probeFiltered = this.#startupProbePending
      ? this.#startupResponseFilter.push(filtered.residual, true)
      : { residual: filtered.residual, responses: [] };
    if (this.#startupProbePending && probeFiltered.responses.length > 0) {
      this.#startupProbeCapture += probeFiltered.responses.join("");
    }
    for (const response of filtered.graphics) {
      if (response.imageId === KITTY_QUERY_IMAGE_ID) {
        this.#finishStartupProbeQuarantine(response.message);
        continue;
      }
      if (this.#closing) {
        if (response.placementId === undefined && response.message.trim().toUpperCase() === "OK") {
          this.#transmitter.markImageAccepted(response.imageId);
        }
        continue;
      }
      const uploaded = Array.from(this.#uploaded.values())
        .find(({ imageId }) => imageId === response.imageId);
      if (!uploaded) continue;
      const message = response.message.trim();
      if (message.toUpperCase() === "OK") {
        if (response.placementId === undefined) {
          this.#transmitter.markImageAccepted(response.imageId);
        }
        continue;
      }
      if (!message) continue;
      const temporary = response.placementId === undefined
        && this.#transmitter.wasTemporaryFileImage(response.imageId);
      if (temporary && this.#transmitter.fallbackToDirect()) {
        this.#uploaded.delete(uploaded.key);
        this.#statusMessage = "image transport changed to direct transfer";
      } else {
        this.#blockedAssets.add(uploaded.key);
        this.#graphicsAvailable = false;
        this.#relayout();
        this.#statusMessage = `graphics disabled after terminal error: ${message}`;
      }
      this.#requestRender();
    }
    this.#handleInput(probeFiltered.residual);
    if (this.#responseFilter.hasPending) {
      this.#responseTailTimer = setTimeout(() => {
        this.#responseTailTimer = undefined;
        this.#handleInput(this.#responseFilter.flush());
      }, this.#responseFilter.hasConfirmedGraphicsResponse ? 1_000 : 20);
    }
  };

  readonly #onEnd = (): void => this.#resolveExit?.(0);
  readonly #onSignal = (): void => this.#resolveExit?.(130);

  #finishStartupProbeQuarantine(kittyMessage?: string): void {
    if (!this.#startupProbePending) return;
    const captured = this.#startupProbeCapture;
    this.#startupProbeCapture = "";
    this.#startupProbePending = false;
    if (this.#startupProbeTimer) clearTimeout(this.#startupProbeTimer);
    this.#startupProbeTimer = undefined;
    const residual = this.#startupResponseFilter.flush(true);
    if (!this.#closing && kittyMessage?.trim().toUpperCase() === "OK") {
      const parsed = parseTerminalResponses(captured);
      const validCell = parsed.cell
        && parsed.cell.width > 0 && parsed.cell.height > 0
        ? parsed.cell
        : undefined;
      const validWindow = parsed.windowPixels
        && parsed.windowPixels.width > 0 && parsed.windowPixels.height > 0
        ? parsed.windowPixels
        : undefined;
      const nextCell = this.options.cellOverride
        ? { ...this.options.cellOverride, source: "override" as const }
        : validCell
          ? { ...validCell, source: "cell-query" as const }
          : validWindow
            ? {
                width: validWindow.width / this.columns,
                height: validWindow.height / this.rows,
                source: "window-query" as const
              }
            : this.capabilities.cell;
      this.capabilities.kittyGraphics = true;
      this.capabilities.cell = nextCell;
      this.capabilities.windowPixels = validWindow ?? this.capabilities.windowPixels;
      this.capabilities.foreground = parsed.foreground ?? this.capabilities.foreground;
      this.capabilities.background = parsed.background ?? this.capabilities.background;
      this.#graphicsAvailable = true;
      this.#relayout();
      this.#requestRender();
    }
    this.#handleInput(residual);
  }

  readonly #onResize = (): void => {
    if (this.#closing) return;
    const oldMaximum = Math.max(1, this.#layout.lines.length - this.contentViewportRows);
    const progress = this.#offset / oldMaximum;
    this.#relayout();
    const newMaximum = Math.max(0, this.#layout.lines.length - this.contentViewportRows);
    this.#offset = this.#clampOffset(Math.round(progress * newMaximum));
    this.#requestRender();
  };

  async run(pendingInput = ""): Promise<number> {
    const exit = new Promise<number>((resolveExit) => {
      this.#resolveExit = resolveExit;
    });
    this.#previousRaw = process.stdin.isRaw;
    if (typeof process.stdin.setRawMode === "function") process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", this.#onData);
    process.stdin.on("end", this.#onEnd);
    process.on("SIGWINCH", this.#onResize);
    process.on("SIGINT", this.#onSignal);
    process.on("SIGTERM", this.#onSignal);
    process.on("SIGHUP", this.#onSignal);
    if (this.#startupProbePending) {
      this.#startupProbeTimer = setTimeout(
        () => this.#finishStartupProbeQuarantine(),
        STARTUP_PROBE_QUARANTINE_MS
      );
    }
    const cleanup = this.#graphicsAvailable ? kittyDeleteByZIndex() : "";
    await this.#writer.write(synchronizedOutput(`${cleanup}${ENTER_ALTERNATE_SCREEN}`));
    if (pendingInput) this.#handleInput(pendingInput);
    this.#requestRender();

    const exitCode = await exit;
    await this.close();
    return exitCode;
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    this.#renderVersion += 1;
    process.off("SIGWINCH", this.#onResize);
    process.off("SIGINT", this.#onSignal);
    process.off("SIGTERM", this.#onSignal);
    process.off("SIGHUP", this.#onSignal);
    if (this.#startupProbeTimer) clearTimeout(this.#startupProbeTimer);
    this.#startupProbeTimer = undefined;
    this.#startupProbePending = false;
    this.#startupProbeCapture = "";
    this.#startupResponseFilter.flush(true);
    try {
      await Promise.all([this.#renderTail, this.#viewTail]);
      const cleanup = this.capabilities.kittyGraphics || this.#uploaded.size > 0
        ? `${Array.from(this.#uploaded.values(), ({ imageId }) => kittyDeleteImage(imageId)).join("")}${kittyDeleteByZIndex()}`
        : "";
      await this.#writer.write(synchronizedOutput(`${cleanup}${LEAVE_ALTERNATE_SCREEN}`));
      await this.#writer.flush();
    } finally {
      try {
        await this.#transmitter.dispose();
      } finally {
        process.stdin.off("data", this.#onData);
        process.stdin.off("end", this.#onEnd);
        if (this.#responseTailTimer) clearTimeout(this.#responseTailTimer);
        this.#responseTailTimer = undefined;
        this.#responseFilter.flush();
        process.stdin.pause();
        if (typeof process.stdin.setRawMode === "function" && !this.#previousRaw) {
          process.stdin.setRawMode(false);
        }
        await Promise.all([...this.#ownedDocuments].map((document) =>
          disposeReaderDocument(document)));
        this.#ownedDocuments.clear();
      }
    }
  }
}

export async function runReader(
  options: ReaderCliOptions,
  capabilities: TerminalCapabilities,
  pendingInput = "",
  startupProbePending = false,
  preloadedDocument?: ReaderDocument
): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const kind = readerFileKind(options.path);
    const directlyReadable = new Set([
      "markdown", "text", "json", "jsonl", "yaml", "toml", "xml",
      "csv", "tsv", "html", "notebook"
    ]);
    if (kind && directlyReadable.has(kind)) {
      process.stdout.write(await readFile(resolve(options.cwd, options.path), "utf8"));
      return 0;
    }
    const document = await loadReaderDocument(options.path, options.cwd);
    try {
      if (document.source) {
        process.stdout.write(document.source);
        return 0;
      }
      process.stderr.write(plainFallbackMessage(options.path));
      return 1;
    } finally {
      await disposeReaderDocument(document);
    }
  }
  const document = preloadedDocument ?? await loadReaderDocument(options.path, options.cwd);
  const reader = new TerminalReader(options, capabilities, document, startupProbePending);
  try {
    return await reader.run(pendingInput);
  } finally {
    await reader.close();
  }
}

/** Load reader resources while the independent terminal probe is in flight. */
export async function preloadReaderDocument(
  options: ReaderCliOptions
): Promise<ReaderDocument | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  return loadReaderDocument(options.path, options.cwd);
}

export const readerInternals = {
  canonicalImageRequest,
  filterReaderDirectoryEntries,
  fitStatus,
  isDarkColor,
  listReaderDirectory,
  readerDirectoryBreadcrumb,
  renderSpans,
  readerTerminalImageLimit,
  selectTerminalImageEvictions,
  sourceRectangleForVisiblePlacement,
  styleSequence,
  truncateStatus,
  visibleReaderPlacements
};
