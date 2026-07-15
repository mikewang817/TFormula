import { FormulaCache, formulaCacheKey } from "./formula-cache.js";
import type { ReaderImageAsset } from "./reader-layout.js";
import { loadSharp } from "./sharp-loader.js";
import type { CellMetrics } from "./types.js";

const IMAGE_CACHE_VERSION = "reader-image-sharp-0.34.5-png-v2";
const IMAGE_RESOLUTION_BUCKET = 256;
const MAX_IMAGE_RESOLUTION = 4096;
const MAX_PENDING_IMAGE_PREPARATIONS = 8;
const MAX_READER_IMAGE_SCALE = 3;

export interface CanonicalImageRequest {
  /** Terminal-side identity for this source image and resolution tier. */
  key: string;
  /** Content-addressed persistent-cache key. */
  cacheKey: string;
  maxWidth: number;
  maxHeight: number;
}

export interface PreparedReaderImage {
  key: string;
  png: Uint8Array;
  width: number;
  height: number;
}

function imageResolutionBucket(value: number): number {
  const pixels = Math.max(1, Math.ceil(value));
  return Math.min(
    MAX_IMAGE_RESOLUTION,
    Math.max(IMAGE_RESOLUTION_BUCKET, Math.ceil(pixels / IMAGE_RESOLUTION_BUCKET)
      * IMAGE_RESOLUTION_BUCKET)
  );
}

/** Pick one reusable source resolution that covers every reader zoom level. */
export function canonicalImageRequest(
  asset: ReaderImageAsset,
  contentWidth: number,
  viewportRows: number,
  cell: CellMetrics
): CanonicalImageRequest {
  const sourceWidth = Math.max(1, Math.round(asset.width));
  const sourceHeight = Math.max(1, Math.round(asset.height));
  const availableWidthPx = Math.max(1, Math.floor(contentWidth) * cell.width);
  const availableHeightPx = Math.max(1, Math.max(2, Math.floor(viewportRows) - 3)
    * cell.height);
  const fitScale = Math.min(
    1,
    availableWidthPx / sourceWidth,
    availableHeightPx / sourceHeight
  );
  const maximumRenderedScale = Math.min(
    fitScale * MAX_READER_IMAGE_SCALE,
    availableWidthPx / sourceWidth
  );
  const sampledScale = Math.max(Number.EPSILON, Math.min(1, maximumRenderedScale));
  const maxWidth = Math.min(
    sourceWidth,
    imageResolutionBucket(sourceWidth * sampledScale)
  );
  const maxHeight = Math.min(
    sourceHeight,
    imageResolutionBucket(sourceHeight * sampledScale)
  );
  const cacheKey = formulaCacheKey({
    version: IMAGE_CACHE_VERSION,
    path: asset.path,
    size: asset.size ?? null,
    mtimeMs: asset.mtimeMs ?? null,
    sourceWidth,
    sourceHeight,
    maxWidth,
    maxHeight,
    autoOrient: true
  });
  return {
    key: `${asset.key}\0canonical-png-v2:${cacheKey}`,
    cacheKey,
    maxWidth,
    maxHeight
  };
}

export function readPngDimensions(png: Uint8Array): { width: number; height: number } {
  const data = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (data.length < 24 || !data.subarray(0, 8).equals(signature)
    || data.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error("cached reader image is not a valid PNG");
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (width === 0 || height === 0) throw new Error("cached reader image has invalid dimensions");
  return { width, height };
}

/** Persistent, concurrency-deduplicated cache for terminal-ready reader images. */
export class ReaderImageCache {
  readonly #pending = new Map<string, Promise<PreparedReaderImage>>();

  constructor(
    readonly persistent = new FormulaCache({ memoryEntries: 8 }),
    readonly maxPending = MAX_PENDING_IMAGE_PREPARATIONS
  ) {}

  prepare(
    asset: ReaderImageAsset,
    request: CanonicalImageRequest
  ): Promise<PreparedReaderImage> {
    const cached = this.#pending.get(request.key);
    if (cached) return cached;
    const preparation = this.persistent.getOrCreatePng(request.cacheKey, async () => {
      const sharp = await loadSharp();
      const { data } = await sharp(asset.path, { animated: false })
        .rotate()
        .resize({
          width: request.maxWidth,
          height: request.maxHeight,
          fit: "inside",
          withoutEnlargement: true
        })
        .png({ compressionLevel: 6, adaptiveFiltering: true })
        .toBuffer({ resolveWithObject: true });
      return data;
    }).then((png) => ({
      key: request.key,
      png,
      ...readPngDimensions(png)
    }));
    this.#pending.set(request.key, preparation);
    while (this.#pending.size > Math.max(1, this.maxPending)) {
      const oldest = this.#pending.keys().next().value;
      if (oldest === undefined) break;
      this.#pending.delete(oldest);
    }
    void preparation.catch(() => {
      if (this.#pending.get(request.key) === preparation) this.#pending.delete(request.key);
    });
    return preparation;
  }

  release(key: string): void {
    this.#pending.delete(key);
  }
}
