import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  changeReaderPage,
  collectDocumentResources,
  disposeReaderDocument,
  loadReaderDocument,
  mathResourceKey,
  parseMarkdown,
  readerFileKind,
  toggleReaderPageView,
  type ReaderDocument,
  type ReaderDocumentContent
} from "../src/reader-document.js";

describe("reader document parsing", () => {
  it("parses GFM blocks, links, images, and math into one document tree", () => {
    const root = parseMarkdown([
      "# Reader",
      "",
      "A [link](guide.md) with $x^2$.",
      "",
      "| A | B |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "$$",
      "\\frac{1}{2}",
      "$$",
      "",
      "![demo](demo.png)",
      "",
      "![reference image][figure]",
      "",
      "[figure]: reference.webp"
    ].join("\n"));

    expect(root.children.map(({ type }) => type)).toEqual([
      "heading",
      "paragraph",
      "table",
      "math",
      "paragraph",
      "paragraph",
      "definition"
    ]);
    const resources = collectDocumentResources(root);
    expect(resources.imageUrls).toEqual(["demo.png", "reference.webp"]);
    expect(resources.formulas).toEqual(expect.arrayContaining([
      { latex: "x^2", display: false },
      { latex: "\\frac{1}{2}", display: true }
    ]));
    expect(mathResourceKey("x", false)).not.toBe(mathResourceKey("x", true));
  });

  it("recognizes implicit reader file types conservatively", () => {
    expect(readerFileKind("README.md")).toBe("markdown");
    expect(readerFileKind("notes.txt")).toBe("text");
    expect(readerFileKind("photo.WEBP")).toBe("image");
    expect(readerFileKind("data.csv")).toBe("csv");
    expect(readerFileKind("notebook.ipynb")).toBe("notebook");
    expect(readerFileKind("book.epub")).toBe("epub");
    expect(readerFileKind("paper.PDF")).toBe("pdf");
    expect(readerFileKind("bundle.tar.gz")).toBe("archive");
    expect(readerFileKind("server.log")).toBe("text");
    expect(readerFileKind("app.ts")).toBeUndefined();
    expect(readerFileKind("codex")).toBeUndefined();
  });

  it("loads HTML and delimited tables through their format adapters", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tformula-reader-formats-"));
    const htmlPath = join(directory, "page.html");
    const csvPath = join(directory, "data.csv");
    await writeFile(htmlPath, "<!doctype html><title>Demo</title><h1>Hello</h1><p>World</p>");
    await writeFile(csvPath, "name,value\nalpha,42\nbeta,7\n");
    try {
      const html = await loadReaderDocument(htmlPath);
      const csv = await loadReaderDocument(csvPath);
      expect(html).toMatchObject({ kind: "html", title: "Demo", label: "HTML" });
      expect(html.root.children).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "heading", depth: 1 })
      ]));
      expect(csv).toMatchObject({ kind: "csv", label: "CSV" });
      expect(csv.grid).toMatchObject({
        headers: ["name", "value"],
        rows: [["alpha", "42"], ["beta", "7"]]
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("sniffs unknown explicit files without treating binary bytes as UTF-8", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tformula-reader-sniff-"));
    const jsonPath = join(directory, "structured-data");
    const binaryPath = join(directory, "mystery-data");
    await writeFile(jsonPath, '{"answer":42}');
    await writeFile(binaryPath, Buffer.from([0xff, 0x00, 0x80, 0x41, 0x42, 0x43]));
    try {
      const json = await loadReaderDocument(jsonPath);
      const binary = await loadReaderDocument(binaryPath);
      expect(json.kind).toBe("json");
      expect(binary.kind).toBe("binary");
      expect(binary.source).toBe("");
      expect(binary.root.children).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "code", lang: "hex" })
      ]));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("hydrates embedded notebook image output for the existing graphics pipeline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tformula-reader-notebook-"));
    const path = join(directory, "analysis.ipynb");
    const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+3MxZ5wAAAABJRU5ErkJggg==";
    await writeFile(path, JSON.stringify({
      metadata: { language_info: { name: "python" } },
      cells: [{
        cell_type: "code",
        source: ["1 + 1"],
        outputs: [{ output_type: "display_data", data: { "image/png": pixel }, metadata: {} }],
        metadata: {}
      }],
      nbformat: 4,
      nbformat_minor: 5
    }));
    let document: ReaderDocument | undefined;
    try {
      document = await loadReaderDocument(path);
      expect(document.kind).toBe("notebook");
      expect(document.images.size).toBe(1);
      expect([...document.images.values()][0]).toEqual(expect.objectContaining({
        width: 1,
        height: 1,
        path: expect.stringContaining("tformula-notebook-")
      }));
    } finally {
      if (document) await disposeReaderDocument(document);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("switches PDF-style documents between reflow and lazily cached pages", async () => {
    const content = (name: string): ReaderDocumentContent => ({
      root: { type: "root", children: [{ type: "heading", depth: 1, children: [{ type: "text", value: name }] }] },
      images: new Map(),
      math: new Map()
    });
    const reflow = content("Reflow");
    const loaded: number[] = [];
    const document: ReaderDocument = {
      path: "/tmp/paper.pdf",
      title: "paper.pdf",
      kind: "pdf",
      label: "PDF reflow",
      source: "page text",
      ...reflow,
      pages: {
        mode: "reflow",
        current: 1,
        count: 3,
        backend: "test",
        reflow,
        cache: new Map(),
        load: async (page) => {
          loaded.push(page);
          return content(`Page ${page}`);
        }
      }
    };

    await expect(toggleReaderPageView(document)).resolves.toBe(true);
    expect(document.pages?.mode).toBe("page");
    expect(document.viewKey).toBe("page:1");
    expect(document.label).toBe("PDF page 1/3");
    await expect(changeReaderPage(document, 1)).resolves.toBe(true);
    expect(document.viewKey).toBe("page:2");
    await expect(changeReaderPage(document, -1)).resolves.toBe(true);
    expect(document.viewKey).toBe("page:1");
    expect(loaded).toEqual([1, 2]);
    await expect(toggleReaderPageView(document)).resolves.toBe(true);
    expect(document.root).toBe(reflow.root);
    expect(document.pages?.mode).toBe("reflow");
  });

  it("defers MathJax measurement until formulas enter the viewport", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tformula-lazy-math-"));
    const path = join(directory, "lazy.md");
    await writeFile(path, "Before $x^2$.\n\n$$\\frac{a}{b}$$\n");
    try {
      const document = await loadReaderDocument(path);
      expect(document.math.size).toBe(2);
      expect([...document.math.values()]).toEqual(expect.arrayContaining([
        expect.objectContaining({ latex: "x^2", display: false }),
        expect.objectContaining({ latex: "\\frac{a}{b}", display: true })
      ]));
      expect([...document.math.values()].every((resource) =>
        resource.aspectRatio === undefined && resource.heightEx === undefined
      )).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves explicit LaTeX delimiters before CommonMark can consume them", () => {
    const root = parseMarkdown([
      "Inline \\( P(x) \\) and `\\(literal\\)`.",
      "",
      "\\[",
      "K L (P | | Q) = \\sum_ {i = 1} ^ {n} P(x) \\log \\frac{P(x)}{Q(x)} \\tag {2}",
      "\\]",
      "",
      "$$z_i = \\lambda z_{i-1}$$",
      "",
      "[",
      "J S(P | | Q) = \\sum_{i=1}^{n} P(x) \\log \\frac{P(x)}{Q(x)}",
      "]",
      "",
      "```tex",
      "\\[not parsed inside code\\]",
      "```"
    ].join("\n"));
    const formulas: Array<{ type: string; value: string }> = [];
    const code: string[] = [];
    const visit = (node: typeof root | (typeof root.children)[number]): void => {
      if (node.type === "math" || node.type === "inlineMath") {
        formulas.push({ type: node.type, value: node.value });
      }
      if (node.type === "code") code.push(node.value);
      if ("children" in node) {
        for (const child of node.children) visit(child as (typeof root.children)[number]);
      }
    };
    visit(root);

    expect(formulas.filter(({ type }) => type === "math")).toHaveLength(3);
    expect(formulas).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "inlineMath", value: "P(x)" }),
      expect.objectContaining({ type: "math", value: expect.stringContaining("\\tag {2}") }),
      expect.objectContaining({ type: "math", value: expect.stringContaining("z_i") }),
      expect.objectContaining({ type: "math", value: expect.stringContaining("J S(P | | Q)") })
    ]));
    expect(code).toEqual(["\\[not parsed inside code\\]"]);
  });
});
