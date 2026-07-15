import { describe, expect, it } from "vitest";
import type { ReaderDocument } from "../src/reader-document.js";
import {
  mathResourceKey,
  parseMarkdown
} from "../src/reader-document.js";
import {
  layoutReaderDocument,
  rescaleReaderImages
} from "../src/reader-layout.js";

const source = [
  "# Reader Title",
  "",
  "A **bold** [local link](guide.md) with $x^2$.",
  "",
  "> A useful quote.",
  "",
  "- [x] first item",
  "- second item",
  "",
  "| Name | Value |",
  "| :--- | ---: |",
  "| alpha | 42 |",
  "",
  "```ts",
  "const answer = 42;",
  "```",
  "",
  "$$",
  "\\frac{1}{2}",
  "$$",
  "",
  "![demo image](demo.png)"
].join("\n");

function document(): ReaderDocument {
  return {
    path: "/tmp/reader.md",
    title: "reader.md",
    source,
    root: parseMarkdown(source),
    images: new Map([["demo.png", {
      url: "demo.png",
      path: "/tmp/demo.png",
      width: 800,
      height: 400
    }]]),
    math: new Map([
      [mathResourceKey("x^2", false), {
        latex: "x^2",
        display: false,
        aspectRatio: 1.8,
        heightEx: 1.2
      }],
      [mathResourceKey("\\frac{1}{2}", true), {
        latex: "\\frac{1}{2}",
        display: true,
        aspectRatio: 0.8,
        heightEx: 3
      }]
    ])
  };
}

const options = {
  columns: 90,
  viewportRows: 24,
  cell: { width: 9, height: 18, source: "fallback" as const },
  scale: 1,
  graphics: true
};

describe("reader layout", () => {
  it("produces a rendered document view instead of visible Markdown syntax", () => {
    const layout = layoutReaderDocument(document(), options);
    const text = layout.lines.map(({ plain }) => plain).join("\n");

    expect(text).toContain("Reader Title");
    expect(text).toContain("│ A useful quote.");
    expect(text).toContain("☑ first item");
    expect(text).toContain("┌");
    expect(text).toContain("alpha");
    expect(text).toContain("const answer = 42;");
    expect(text).not.toContain("# Reader Title");
    expect(text).not.toContain("**bold**");
    expect(layout.headings).toEqual(expect.arrayContaining([
      expect.objectContaining({ depth: 1, text: "Reader Title" })
    ]));
    expect(layout.links).toEqual(expect.arrayContaining([
      expect.objectContaining({ href: "guide.md", label: "local link" })
    ]));
    expect(layout.placements.map(({ asset }) => asset.kind)).toEqual(
      expect.arrayContaining(["math", "image"])
    );
  });

  it("falls back to readable formula and image text without graphics", () => {
    const layout = layoutReaderDocument(document(), { ...options, graphics: false });
    const text = layout.lines.map(({ plain }) => plain).join("\n");

    expect(layout.placements).toEqual([]);
    expect(text).toContain("$x^2$");
    expect(text).toContain("$$ \\frac{1}{2} $$");
    expect(text).toContain("[Image: demo image (800×400)]");
  });

  it("falls back to source labels after a lazy formula or image render fails", () => {
    const failed = document();
    failed.math.get(mathResourceKey("x^2", false))!.error = "bad formula";
    failed.images.get("demo.png")!.error = "bad image";
    const layout = layoutReaderDocument(failed, options);
    const text = layout.lines.map(({ plain }) => plain).join("\n");

    expect(text).toContain("$x^2$");
    expect(text).toContain("[Image: demo image (800×400) — bad image]");
    expect(layout.placements.some(({ asset }) => asset.kind === "image")).toBe(false);
  });

  it("lays out unmeasured formulas without invoking eager MathJax", () => {
    const lazy = document();
    for (const resource of lazy.math.values()) {
      resource.aspectRatio = undefined;
      resource.heightEx = undefined;
    }
    const layout = layoutReaderDocument(lazy, options);
    const text = layout.lines.map(({ plain }) => plain).join("\n");

    expect(layout.placements.filter(({ asset }) => asset.kind === "math")).toHaveLength(2);
    expect(text).not.toContain("$x^2$");
    expect(text).not.toContain("$$ \\frac{1}{2} $$");
  });

  it("fits images to the terminal and scales them relative to that fitted size", () => {
    const square = document();
    square.images.set("demo.png", {
      url: "demo.png",
      path: "/tmp/demo.png",
      width: 800,
      height: 800
    });

    const fitted = layoutReaderDocument(square, options);
    const zoomed = layoutReaderDocument(square, { ...options, imageScale: 2 });
    const fittedImage = fitted.placements.find(({ asset }) => asset.kind === "image")!;
    const zoomedImage = zoomed.placements.find(({ asset }) => asset.kind === "image")!;

    expect(fittedImage.rows).toBeLessThanOrEqual(options.viewportRows - 3);
    expect(zoomedImage.rows).toBeGreaterThan(options.viewportRows);
    expect(zoomedImage.rows).toBeGreaterThan(fittedImage.rows);
    expect(zoomedImage.columns).toBeGreaterThan(fittedImage.columns);
    expect(zoomedImage.columns).toBeLessThanOrEqual(zoomed.contentWidth);
    expect(zoomedImage.columns * options.cell.width
      / (zoomedImage.rows * options.cell.height)).toBeCloseTo(1, 1);
    expect(fittedImage.asset).toEqual(expect.objectContaining({
      kind: "image",
      width: 800,
      height: 800
    }));
  });

  it("rescales image rows and downstream anchors without reflowing document text", () => {
    const sourceWithTail = [
      "# Before",
      "",
      "![demo image](demo.png)",
      "",
      "## After",
      "",
      "A [tail link](tail.md)."
    ].join("\n");
    const value: ReaderDocument = {
      ...document(),
      source: sourceWithTail,
      root: parseMarkdown(sourceWithTail),
      math: new Map()
    };
    const fitted = layoutReaderDocument(value, options);
    const partial = rescaleReaderImages(fitted, {
      viewportRows: options.viewportRows,
      cell: options.cell,
      imageScale: 2
    });
    const complete = layoutReaderDocument(value, { ...options, imageScale: 2 });

    expect(partial.lines.map(({ plain }) => plain)).toEqual(
      complete.lines.map(({ plain }) => plain)
    );
    expect(partial.placements.map(({ row, col, rows, columns, asset }) => ({
      row, col, rows, columns, kind: asset.kind
    }))).toEqual(complete.placements.map(({ row, col, rows, columns, asset }) => ({
      row, col, rows, columns, kind: asset.kind
    })));
    expect(partial.headings).toEqual(complete.headings);
    expect(partial.links).toEqual(complete.links);
  });

  it("sanitizes terminal control bytes from document text", () => {
    const unsafe = document();
    unsafe.source = "hello\x1b[2Jworld";
    unsafe.root = parseMarkdown(unsafe.source);
    const layout = layoutReaderDocument(unsafe, { ...options, graphics: false });
    expect(layout.lines.map(({ plain }) => plain).join("\n")).not.toContain("\x1b");
  });

  it("lays out table documents with a frozen header and horizontal column window", () => {
    const table: ReaderDocument = {
      ...document(),
      kind: "csv",
      grid: {
        headers: ["first", "second", "third", "fourth"],
        rows: [
          ["alpha", "a long second value", "3", "tail"],
          ["beta", "another long value", "4", "end"]
        ],
        columnOffset: 1
      }
    };
    const layout = layoutReaderDocument(table, { ...options, columns: 28 });
    const sticky = layout.stickyLines?.map(({ plain }) => plain).join("\n") ?? "";
    const body = layout.lines.map(({ spans }) => spans.map(({ text }) => text).join("")).join("\n");

    expect(layout.stickyLines).toHaveLength(3);
    expect(sticky).toContain("second");
    expect(sticky).not.toContain("first");
    expect(body).toContain("a long second value");
    expect(layout.placements).toEqual([]);
  });
});
