import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectDocumentResources,
  loadReaderDocument,
  mathResourceKey,
  parseMarkdown,
  readerFileKind
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

  it("repairs OCR page headers attached to display closers and decodes TeX entities", () => {
    const root = parseMarkdown([
      "$$",
      "\\begin{array}{cc} a &amp; b \\\\ c &amp; d \\end{array}",
      "$$CN 115689114 A",
      "说明书 1/2 页",
      "",
      "# Restored heading",
      "",
      "![figure](figure.png)"
    ].join("\n"));
    const resources = collectDocumentResources(root);

    expect(resources.formulas).toEqual([{
      latex: "\\begin{array}{cc} a & b \\\\ c & d \\end{array}",
      display: true
    }]);
    expect(resources.imageUrls).toEqual(["figure.png"]);
    expect(root.children.map(({ type }) => type)).toEqual([
      "math",
      "paragraph",
      "heading",
      "paragraph"
    ]);
    expect(root.children).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "heading", depth: 1 })
    ]));
  });

  it("promotes patent-numbered standalone equations out of one-row inline layout", () => {
    const root = parseMarkdown([
      "[0025] 判断矩阵为：",
      "",
      "[0026]  $C_1 = \\left[ \\begin{array}{cc}1 &amp; a \\\\ b &amp; 1 \\end{array} \\right]$",
      "",
      "[0027] 其中，$a$ 为系数。"
    ].join("\n"));

    expect(root.children.map(({ type }) => type)).toEqual([
      "paragraph",
      "paragraph",
      "math",
      "paragraph"
    ]);
    expect(root.children[2]).toMatchObject({
      type: "math",
      value: expect.stringContaining("\\begin{array}{cc}1 & a")
    });
    expect(collectDocumentResources(root).formulas).toEqual(expect.arrayContaining([
      expect.objectContaining({ display: true, latex: expect.stringContaining("C_1") }),
      { display: false, latex: "a" }
    ]));
  });

  it("separates patent page headers attached to closing inline math", () => {
    const root = parseMarkdown("[0036]  $X^{*} = X / X_{\\max}$CN 115689114 A\n说明书\n3/11 页");

    expect(root.children.map(({ type }) => type)).toEqual([
      "paragraph",
      "math",
      "paragraph"
    ]);
    expect(root.children[1]).toMatchObject({ type: "math", value: "X^{*} = X / X_{\\max}" });
  });

  it("makes embedded and adjacent display-dollar boundaries block safe", () => {
    const root = parseMarkdown([
      "Metrics: \\[ \\begin{split}a&=1\\\\",
      "b&=2\\end{split} \\] (10)",
      "",
      "More:$$c=3$$$$d=4,$$ after.",
      "",
      "`$$not math$$` and a literal \\$\\$ pair.",
      "",
      "# Surviving heading"
    ].join("\n"));
    const formulas = collectDocumentResources(root).formulas;

    expect(formulas).toHaveLength(3);
    expect(formulas).toEqual(expect.arrayContaining([
      { latex: " \\begin{split}a&=1\\\\\nb&=2\\end{split}", display: true },
      { latex: "c=3", display: true },
      { latex: "d=4,", display: true }
    ]));
    expect(root.children).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "heading", depth: 1 })
    ]));
  });

  it("promotes standalone single-dollar scientific equations for readable sizing", () => {
    const root = parseMarkdown([
      "$\\hat{x}=\\sum_{i=1}^{N}x_i$",
      "",
      "$y=\\frac{a}{b}$ (4)"
    ].join("\n"));

    expect(root.children.map(({ type }) => type)).toEqual([
      "math",
      "math",
      "paragraph"
    ]);
    expect(collectDocumentResources(root).formulas).toEqual([
      { latex: "\\hat{x}=\\sum_{i=1}^{N}x_i", display: true },
      { latex: "y=\\frac{a}{b}", display: true }
    ]);
  });

  it("recognizes implicit reader file types conservatively", () => {
    expect(readerFileKind("README.md")).toBe("markdown");
    expect(readerFileKind("notes.txt")).toBe("text");
    expect(readerFileKind("photo.WEBP")).toBe("image");
    expect(readerFileKind("codex")).toBeUndefined();
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
