import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FormulaCache } from "../src/formula-cache.js";
import {
  canonicalImageRequest,
  ReaderImageCache,
  readPngDimensions
} from "../src/reader-image-cache.js";

describe("reader image cache", () => {
  it("reuses a terminal-ready PNG across processes without reading the source again", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tformula-reader-image-cache-"));
    const source = join(directory, "source.png");
    const cacheRoot = join(directory, "cache");
    await copyFile(join(process.cwd(), "assets", "tformula-maxwell.png"), source);
    const info = await stat(source);
    const asset = {
      kind: "image" as const,
      key: `image\0${source}`,
      path: source,
      width: 2_570,
      height: 2_194,
      size: info.size,
      mtimeMs: info.mtimeMs
    };
    const request = canonicalImageRequest(asset, 76, 23, {
      width: 9,
      height: 18,
      source: "fallback"
    });

    try {
      const firstCache = new ReaderImageCache(new FormulaCache({ root: cacheRoot }));
      const first = await firstCache.prepare(asset, request);
      firstCache.release(request.key);
      expect(readPngDimensions(first.png)).toEqual({
        width: first.width,
        height: first.height
      });

      await rm(source);
      const secondCache = new ReaderImageCache(new FormulaCache({ root: cacheRoot }));
      const second = await secondCache.prepare(asset, request);
      expect(second.png).toEqual(first.png);
      expect({ width: second.width, height: second.height }).toEqual({
        width: first.width,
        height: first.height
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("deduplicates concurrent preparation requests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tformula-reader-image-dedupe-"));
    const source = join(directory, "source.png");
    await copyFile(join(process.cwd(), "assets", "tformula-maxwell.png"), source);
    const info = await stat(source);
    const asset = {
      kind: "image" as const,
      key: `image\0${source}`,
      path: source,
      width: 2_570,
      height: 2_194,
      size: info.size,
      mtimeMs: info.mtimeMs
    };
    const request = canonicalImageRequest(asset, 76, 23, {
      width: 9,
      height: 18,
      source: "fallback"
    });
    try {
      const cache = new ReaderImageCache(new FormulaCache({
        root: join(directory, "cache")
      }));
      const left = cache.prepare(asset, request);
      const right = cache.prepare(asset, request);
      expect(left).toBe(right);
      await expect(Promise.all([left, right])).resolves.toHaveLength(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
