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

  it("does not reserve a full extra cell around measured inline symbols", () => {
    const inlineSource = "A $i$ B $c_{ij}$ C";
    const inlineDocument: ReaderDocument = {
      ...document(),
      source: inlineSource,
      root: parseMarkdown(inlineSource),
      images: new Map(),
      math: new Map([
        [mathResourceKey("i", false), {
          latex: "i",
          display: false,
          aspectRatio: 0.5138,
          heightEx: 1.52
        }],
        [mathResourceKey("c_{ij}", false), {
          latex: "c_{ij}",
          display: false,
          aspectRatio: 1.4265,
          heightEx: 1.667
        }]
      ])
    };
    const layout = layoutReaderDocument(inlineDocument, options);
    const inlineMath = layout.placements.filter(({ asset }) => asset.kind === "math");

    expect(inlineMath.map(({ columns }) => columns)).toEqual([1, 3]);
    expect(layout.lines[0]?.plain).toBe("  A B   C");
  });

  it("uses vertically fitted formula width instead of stacking source spaces", () => {
    const inlineSource = "其中， $X_{ij}$ 为数据";
    const inlineDocument: ReaderDocument = {
      ...document(),
      source: inlineSource,
      root: parseMarkdown(inlineSource),
      images: new Map(),
      math: new Map([[mathResourceKey("X_{ij}", false), {
        latex: "X_{ij}",
        display: false,
        aspectRatio: 1.4785,
        heightEx: 2.213
      }]])
    };
    const layout = layoutReaderDocument(inlineDocument, options);

    expect(layout.placements[0]?.columns).toBe(3);
    expect(layout.lines[0]?.plain).toBe("  其中，   为数据");
  });

  it("keeps an inline formula with following CJK prose at a wrap boundary", () => {
    const inlineSource = "1234567890 $w$ 为行均值，即所求权重；";
    const inlineDocument: ReaderDocument = {
      ...document(),
      source: inlineSource,
      root: parseMarkdown(inlineSource),
      images: new Map(),
      math: new Map([[mathResourceKey("w", false), {
        latex: "w",
        display: false,
        aspectRatio: 1.5805,
        heightEx: 1.025
      }]])
    };
    const layout = layoutReaderDocument(inlineDocument, { ...options, columns: 14 });
    const placement = layout.placements.find(({ asset }) => asset.kind === "math")!;
    const suffix = layout.lines[placement.row]!.plain
      .slice(placement.col + placement.columns)
      .trimStart();

    expect(placement.row).toBeGreaterThan(0);
    expect(suffix).toMatch(/^为/u);
    expect(layout.lines.every(({ plain }) => !/^\s*[，。；：！？、）》】”’]/u.test(plain))).toBe(true);
  });

  it("renders an image even when OCR text trails it in the same paragraph", () => {
    const mixedSource = "![page](demo.png)CN 115689114 A\n";
    const mixed: ReaderDocument = {
      ...document(),
      source: mixedSource,
      root: parseMarkdown(mixedSource),
      math: new Map()
    };
    const layout = layoutReaderDocument(mixed, options);

    expect(layout.placements).toEqual([
      expect.objectContaining({ asset: expect.objectContaining({ kind: "image" }) })
    ]);
    expect(layout.lines.map(({ plain }) => plain).join("\n")).toContain("CN 115689114 A");
    expect(layout.lines.map(({ plain }) => plain).join("\n")).not.toContain("[image:");
  });

  it("wraps long table cells vertically instead of discarding their tails", () => {
    const tableSource = [
      "| 项目 | 内容 |",
      "| --- | --- |",
      "| A | 这是一段非常长的表格内容，缩窄终端时末尾文字也不能丢失 |"
    ].join("\n");
    const tableDocument: ReaderDocument = {
      ...document(),
      source: tableSource,
      root: parseMarkdown(tableSource),
      images: new Map(),
      math: new Map()
    };
    const layout = layoutReaderDocument(tableDocument, { ...options, columns: 32 });
    const text = layout.lines.map(({ plain }) => plain).join("\n");

    const compact = text.replace(/[\s│]/gu, "");
    expect(compact).toContain("这是一段非常长的表格内容，缩窄终端时末尾文字也不能丢失");
    expect(text).not.toContain("…");
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
});
