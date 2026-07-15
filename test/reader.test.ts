import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readerInternals } from "../src/reader.js";
import type { ReaderPlacement } from "../src/reader-layout.js";

describe("reader viewport graphics", () => {
  it("lists folders first and excludes unsupported regular files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tformula-reader-files-"));
    try {
      await Promise.all([
        writeFile(join(directory, "notes.md"), "# Notes\n"),
        writeFile(join(directory, "data.csv"), "value\n1\n"),
        writeFile(join(directory, "photo.png"), "not inspected while listing"),
        writeFile(join(directory, "app.ts"), "export {};\n"),
        writeFile(join(directory, "unknown.dat"), "unknown\n"),
        mkdir(join(directory, "chapter.md"))
      ]);

      const entries = await readerInternals.listReaderDirectory(
        directory
      );

      expect(entries.map(({ name, type, kind }) => [name, type, kind])).toEqual([
        ["chapter.md", "directory", undefined],
        ["data.csv", "file", "csv"],
        ["notes.md", "file", "markdown"],
        ["photo.png", "file", "image"]
      ]);
      expect(entries[2]?.path).toBe(resolve(directory, "notes.md"));
      expect(readerInternals.filterReaderDirectoryEntries(entries, "PHO"))
        .toEqual([entries[3]]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("compacts deep directory breadcrumbs while preserving the active levels", () => {
    expect(readerInternals.readerDirectoryBreadcrumb(
      "/workspace/project",
      "/workspace/project/alpha/beta/gamma",
      80
    )).toBe("  Files  project / alpha / beta / gamma");
    expect(readerInternals.readerDirectoryBreadcrumb(
      "/workspace/project",
      "/workspace/project/alpha/beta/gamma",
      35
    )).toBe("  Files  project / … / beta / gamma");
  });

  it("crops zoomed images to visible rows while keeping formulas atomic", () => {
    const image: ReaderPlacement = {
      row: 10,
      col: 3,
      columns: 20,
      rows: 30,
      asset: {
        kind: "image",
        key: "image\0/tmp/demo.png",
        path: "/tmp/demo.png",
        width: 1_800,
        height: 2_700
      }
    };
    const completeFormula: ReaderPlacement = {
      row: 22,
      col: 5,
      columns: 8,
      rows: 2,
      asset: {
        kind: "math",
        key: "display\0x^2",
        latex: "x^2",
        display: true
      }
    };
    const clippedFormula: ReaderPlacement = {
      ...completeFormula,
      row: 18,
      rows: 4
    };

    const visible = readerInternals.visibleReaderPlacements(
      [image, completeFormula, clippedFormula],
      20,
      10
    );

    expect(visible).toHaveLength(2);
    expect(visible[0]).toEqual({
      placement: image,
      screenRow: 0,
      rows: 10,
      sourceRow: 10
    });
    expect(visible[1]).toEqual({
      placement: completeFormula,
      screenRow: 2,
      rows: 2
    });
  });

  it("keeps fractional-cell crop rectangles inside the uploaded PNG", () => {
    const image: ReaderPlacement = {
      row: 0,
      col: 0,
      columns: 3,
      rows: 2,
      asset: {
        kind: "image",
        key: "image\0demo",
        path: "/tmp/demo.png",
        width: 29,
        height: 35
      }
    };

    const [bottomHalf] = readerInternals.visibleReaderPlacements(
      [image],
      1,
      1
    );
    const source = readerInternals.sourceRectangleForVisiblePlacement(
      bottomHalf!,
      29,
      35
    );

    expect(bottomHalf?.sourceRow).toBe(1);
    expect(source).toEqual({ x: 0, y: 18, width: 29, height: 17 });
    expect(source!.y + source!.height).toBe(35);
  });

  it("uses one quantized source resolution across zoom and small terminal resizes", () => {
    const asset = {
      kind: "image" as const,
      key: "image\0/tmp/wide.png",
      path: "/tmp/wide.png",
      width: 4_000,
      height: 1_000
    };
    const cell = { width: 9, height: 18, source: "fallback" as const };

    const request = readerInternals.canonicalImageRequest(asset, 76, 23, cell);
    const nearbyResize = readerInternals.canonicalImageRequest(asset, 75, 23, cell);

    expect(request).toMatchObject({
      maxWidth: 768,
      maxHeight: 256
    });
    expect(request.cacheKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(request.key).toBe(`${asset.key}\0canonical-png-v2:${request.cacheKey}`);
    expect(nearbyResize).toEqual(request);
  });

  it("invalidates persistent image variants when the source fingerprint changes", () => {
    const base = {
      kind: "image" as const,
      key: "image\0/tmp/photo.png",
      path: "/tmp/photo.png",
      width: 2_000,
      height: 1_000,
      size: 50_000,
      mtimeMs: 100
    };
    const cell = { width: 9, height: 18, source: "fallback" as const };
    const first = readerInternals.canonicalImageRequest(base, 76, 23, cell);
    const modified = readerInternals.canonicalImageRequest(
      { ...base, mtimeMs: 101 },
      76,
      23,
      cell
    );

    expect(modified.cacheKey).not.toBe(first.cacheKey);
    expect(modified.key).not.toBe(first.key);
  });

  it("selects only non-visible least-recently-used terminal images for eviction", () => {
    expect(readerInternals.selectTerminalImageEvictions(
      ["old", "visible", "recent", "new"],
      new Set(["visible"]),
      2
    )).toEqual(["old", "recent"]);
    expect(readerInternals.readerTerminalImageLimit({
      TFORMULA_READER_MAX_IMAGES: "7"
    })).toBe(7);
  });
});
