import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readerFileKind } from "./reader-path.js";
import { loadSharp } from "./sharp-loader.js";
import type { CellMetrics } from "./types.js";

const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 40_000_000;
// Inline previews may use a large contiguous blank area. The actual size is
// still bounded by the terminal width and available rows at the reference.
const MAX_PREVIEW_COLUMNS = 128;
const MAX_PREVIEW_ROWS = 128;
const LOW_RES_PREVIEW_COLUMNS = 128;
const LOW_RES_PREVIEW_ROWS = 128;
const MAX_CACHED_PREVIEWS = 8;
const MAX_CACHED_PREVIEW_BYTES = 32 * 1024 * 1024;

export interface LocalImageReference {
  text: string;
  path: string;
}

/** Resolve only local image targets; never fetch network URLs from Agent output. */
export function localImagePath(raw: string, cwd: string): string | undefined {
  if (!raw || /^(?:https?:|data:|\/\/)/iu.test(raw)) return undefined;
  try {
    const path = /^file:/iu.test(raw)
      ? fileURLToPath(raw)
      : /^(?:[a-z][a-z\d+.-]*:)/iu.test(raw)
        ? undefined
        : decodeURIComponent(raw.replace(/\\([ ()])/gu, "$1"));
    if (!path || readerFileKind(path) !== "image") return undefined;
    return isAbsolute(path) ? path : resolve(cwd, path);
  } catch {
    return undefined;
  }
}

/** Only a complete, standalone Markdown image owns the cells it may cover. */
export function localImageReference(text: string, cwd: string): LocalImageReference | undefined {
  if (text.length > 2_048 || !/^ {0,3}!\[[^\]\r\n]*\]\(/u.test(text)) return undefined;
  const match = /^ {0,3}!\[[^\]\r\n]*\]\((?:<([^<>\r\n]+)>|([^()\r\n]+))\)\s*$/u.exec(text);
  if (!match) return undefined;
  const path = localImagePath((match[1] ?? match[2] ?? "").trim(), cwd);
  return path ? { text, path } : undefined;
}

export interface PreparedAgentImage {
  key: string;
  png: Uint8Array;
  columns: number;
  rows: number;
}

/** Size-bound local raster preview; no network fetch or persistent copy. */
export class AgentImagePreviews {
  readonly #cache = new Map<string, PreparedAgentImage>();
  readonly #metadata = new Map<string, { width: number; height: number }>();
  #cacheBytes = 0;

  async prepare(
    path: string,
    sourceColumns: number,
    terminalColumns: number,
    availableRows: number,
    cell: CellMetrics,
    background: string,
    focus = false
  ): Promise<PreparedAgentImage | undefined> {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0 || info.size > MAX_SOURCE_BYTES) return undefined;
    const sharp = await loadSharp();
    const sourceKey = JSON.stringify([path, info.size, info.mtimeMs]);
    let dimensions = this.#metadata.get(sourceKey);
    if (!dimensions) {
      const metadata = await sharp(path, { animated: false, limitInputPixels: MAX_SOURCE_PIXELS })
        .metadata();
      dimensions = {
        width: metadata.autoOrient?.width ?? metadata.width,
        height: metadata.autoOrient?.height ?? metadata.height
      };
      this.#metadata.set(sourceKey, dimensions);
      if (this.#metadata.size > MAX_CACHED_PREVIEWS * 4) {
        this.#metadata.delete(this.#metadata.keys().next().value!);
      }
    }
    const { width, height } = dimensions;
    if (!width || !height || width * height > MAX_SOURCE_PIXELS) return undefined;

    const cellWidth = Math.max(1, cell.width);
    const cellHeight = Math.max(1, cell.height);
    const maxColumns = focus
      ? terminalColumns
      : Math.min(terminalColumns, Math.min(MAX_PREVIEW_COLUMNS, LOW_RES_PREVIEW_COLUMNS));
    const maxRows = focus
      ? availableRows
      : Math.min(availableRows, Math.min(MAX_PREVIEW_ROWS, LOW_RES_PREVIEW_ROWS));
    if (maxRows < 1 || sourceColumns > terminalColumns) return undefined;
    const scale = Math.min(1, maxColumns * cellWidth / width, maxRows * cellHeight / height);
    const imageColumns = Math.max(1, Math.ceil(width * scale / cellWidth));
    const imageRows = Math.max(1, Math.ceil(height * scale / cellHeight));
    // The preview canvas must follow the fitted image, not the width of the
    // Markdown source line. Otherwise a tall image squeezed into one row gets
    // a wide background-only tail beside the actual pixels.
    const columns = focus ? terminalColumns : imageColumns;
    const rows = focus ? availableRows : imageRows;
    const canvasWidth = Math.max(1, Math.floor(columns * cellWidth));
    const canvasHeight = Math.max(1, Math.floor(rows * cellHeight));
    const imageWidth = Math.max(1, Math.min(canvasWidth, Math.floor(width * scale)));
    const imageHeight = Math.max(1, Math.min(canvasHeight, Math.floor(height * scale)));
    const key = JSON.stringify([
      path, info.size, info.mtimeMs, columns, rows, canvasWidth, canvasHeight,
      imageWidth, imageHeight, background, focus
    ]);
    const cached = this.#cache.get(key);
    if (cached) {
      // Map insertion order is the LRU order: move a hit to the newest end.
      this.#cache.delete(key);
      this.#cache.set(key, cached);
      return cached;
    }

    const image = await sharp(path, { animated: false, limitInputPixels: MAX_SOURCE_PIXELS })
      .rotate()
      .resize(imageWidth, imageHeight, { fit: "inside", withoutEnlargement: true })
      // Keep the image alpha channel. Flattening here paints the terminal
      // background into every pixel and makes transparent padding look like a
      // black rectangle after the image is placed and scaled.
      .ensureAlpha()
      .png({ palette: false })
      .toBuffer();
    // Always construct the placement canvas independently from the terminal
    // background. Kitty composites transparent PNG pixels with the terminal
    // itself; using the detected OSC 11 color here would destroy wallpaper
    // and translucent terminal backgrounds.
    const png = await sharp({
      create: {
        width: canvasWidth,
        height: canvasHeight,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    }).composite([{
      input: image,
      left: focus ? Math.floor((canvasWidth - imageWidth) / 2) : 0,
      top: focus ? Math.floor((canvasHeight - imageHeight) / 2) : 0
    }]).png({ palette: false }).toBuffer();
    const prepared = { key, png, columns, rows };
    this.#cache.set(key, prepared);
    this.#cacheBytes += png.byteLength;
    while (this.#cache.size > MAX_CACHED_PREVIEWS || this.#cacheBytes > MAX_CACHED_PREVIEW_BYTES) {
      const oldestKey = this.#cache.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.#cache.get(oldestKey);
      this.#cache.delete(oldestKey);
      this.#cacheBytes -= oldest?.png.byteLength ?? 0;
    }
    return prepared;
  }
}
