import { describe, expect, it } from "vitest";
import {
  collectDocumentResources,
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

  it("recognizes implicit reader file types conservatively", () => {
    expect(readerFileKind("README.md")).toBe("markdown");
    expect(readerFileKind("notes.txt")).toBe("text");
    expect(readerFileKind("photo.WEBP")).toBe("image");
    expect(readerFileKind("codex")).toBeUndefined();
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
