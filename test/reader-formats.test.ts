import { rm } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import {
  htmlToMarkdown,
  loadArchiveFormat,
  loadBinaryFormat,
  loadEpubFormat,
  loadNotebookFormat,
  loadStructuredFormat,
  parseDelimited
} from "../src/reader-formats.js";

const PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+3MxZ5wAAAABJRU5ErkJggg==";

describe("reader format adapters", () => {
  it("converts inert HTML structure while dropping executable content", () => {
    const converted = htmlToMarkdown([
      "<!doctype html><title>Demo</title>",
      "<script>alert('no')</script><style>body{display:none}</style>",
      "<h1>Reader</h1><p>A <strong>bold</strong> <a href='guide.html'>link</a>.</p>",
      "<table><tr><th>Name</th><th>Value</th></tr><tr><td>x</td><td>42</td></tr></table>",
      "<img src='plot.png' alt='Plot'>"
    ].join(""));

    expect(converted.title).toBe("Demo");
    expect(converted.markdown).toContain("# Reader");
    expect(converted.markdown).toContain("**bold**");
    expect(converted.markdown).toContain("[link](guide.html)");
    expect(converted.markdown).toContain("| Name | Value |");
    expect(converted.markdown).toContain("![Plot](plot.png)");
    expect(converted.markdown).not.toContain("alert");
    expect(converted.markdown).not.toContain("display:none");
  });

  it("parses quoted CSV cells, delimiters, and embedded newlines", () => {
    const grid = parseDelimited('name,note,value\r\nalpha,"x,y",1\r\nbeta,"two\nlines",2\r\n', ",");
    expect(grid.headers).toEqual(["name", "note", "value"]);
    expect(grid.rows).toEqual([
      ["alpha", "x,y", "1"],
      ["beta", "two\nlines", "2"]
    ]);
  });

  it("normalizes structured documents and keeps malformed source readable", () => {
    const json = loadStructuredFormat("json", "/tmp/demo.json", '{"answer":42}');
    const yaml = loadStructuredFormat("yaml", "/tmp/demo.yaml", "answer: 42\n");
    const toml = loadStructuredFormat("toml", "/tmp/demo.toml", "answer = 42\n");
    const jsonl = loadStructuredFormat("jsonl", "/tmp/demo.jsonl", '{"name":"a","value":1}\n{"name":"b","value":2}\n');
    const malformed = loadStructuredFormat("json", "/tmp/broken.json", "{ nope");
    const malformedXml = loadStructuredFormat("xml", "/tmp/broken.xml", "<root><child></root>");

    expect(json.root?.children).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "code", value: expect.stringContaining('"answer": 42') })
    ]));
    expect(yaml.root?.children.some((node) => node.type === "code")).toBe(true);
    expect(toml.root?.children.some((node) => node.type === "code")).toBe(true);
    expect(jsonl.grid).toMatchObject({
      headers: ["name", "value"],
      rows: [["a", "1"], ["b", "2"]]
    });
    expect(malformed.root?.children.some((node) => node.type === "blockquote")).toBe(true);
    expect(malformedXml.root?.children.some((node) => node.type === "blockquote")).toBe(true);
    expect(malformed.source).toBe("{ nope");
  });

  it("turns notebook cells, rich output, and embedded images into one flow document", async () => {
    const source = JSON.stringify({
      metadata: { language_info: { name: "python" } },
      cells: [
        { cell_type: "markdown", source: ["# Analysis\n", "Inline $x^2$."], metadata: {} },
        {
          cell_type: "code",
          execution_count: 1,
          source: ["print('ok')"],
          outputs: [
            { output_type: "stream", name: "stdout", text: ["ok\n"] },
            { output_type: "display_data", data: { "image/png": PIXEL_PNG }, metadata: {} }
          ],
          metadata: {}
        }
      ],
      nbformat: 4,
      nbformat_minor: 5
    });
    const payload = await loadNotebookFormat("/tmp/analysis.ipynb", source);
    try {
      expect(payload.markdown).toContain("Cell 1 · Markdown");
      expect(payload.markdown).toContain("```python");
      expect(payload.markdown).toContain("ok");
      expect(payload.markdown).toMatch(/!\[Cell 2 output 2\]\([^)]*\.png\)/u);
      expect(payload.temporaryPaths).toHaveLength(1);
    } finally {
      await Promise.all((payload.temporaryPaths ?? []).map((path) =>
        rm(path, { recursive: true, force: true })));
    }
  });

  it("lists ZIP entries without extracting their contents", () => {
    const archive = zipSync({
      "docs/readme.txt": strToU8("hello"),
      "data/value.json": strToU8('{"x":1}')
    });
    const payload = loadArchiveFormat("demo.zip", archive);
    expect(payload.label).toBe("ZIP");
    expect(payload.grid?.headers).toEqual(["Path", "Type", "Compressed", "Size"]);
    expect(payload.grid?.rows.map(([name]) => name)).toEqual([
      "docs/readme.txt",
      "data/value.json"
    ]);
  });

  it("extracts EPUB spine text and only materializes referenced image assets", async () => {
    const epub = zipSync({
      mimetype: strToU8("application/epub+zip"),
      "META-INF/container.xml": strToU8(
        '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>'
      ),
      "OEBPS/content.opf": strToU8([
        '<package xmlns:dc="http://purl.org/dc/elements/1.1/">',
        "<metadata><dc:title>Demo Book</dc:title></metadata>",
        '<manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>',
        '<item id="pixel" href="images/pixel.png" media-type="image/png"/></manifest>',
        '<spine><itemref idref="chapter"/></spine></package>'
      ].join("")),
      "OEBPS/chapter.xhtml": strToU8(
        "<html><head><title>First</title></head><body><h1>Hello</h1><p>World.</p><img src='images/pixel.png' alt='Pixel'></body></html>"
      ),
      "OEBPS/images/pixel.png": Uint8Array.from(Buffer.from(PIXEL_PNG, "base64"))
    });
    const payload = await loadEpubFormat("demo.epub", epub);
    try {
      expect(payload.title).toBe("Demo Book");
      expect(payload.markdown).toContain("## EPUB Chapter 1");
      expect(payload.markdown).toContain("# Hello");
      expect(payload.markdown).toMatch(/!\[Pixel\]\(\/.*OEBPS\/images\/pixel\.png\)/u);
      expect(payload.temporaryPaths).toHaveLength(1);
    } finally {
      await Promise.all((payload.temporaryPaths ?? []).map((path) =>
        rm(path, { recursive: true, force: true })));
    }
  });

  it("provides a bounded hexadecimal fallback for arbitrary binary data", () => {
    const payload = loadBinaryFormat("sample.bin", Uint8Array.from([0, 1, 2, 0x41, 0x42, 0x43]));
    const code = payload.root?.children.find((node) => node.type === "code");
    expect(code).toEqual(expect.objectContaining({
      type: "code",
      value: expect.stringContaining("00000000")
    }));
    if (code?.type === "code") expect(code.value).toContain("ABC");
  });
});
