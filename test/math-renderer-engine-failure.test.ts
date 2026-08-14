import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FormulaCache } from "../src/formula-cache.js";
import { MathRenderError, renderMathJaxSvg } from "../src/math-renderer.js";

// MathJax reports TeX problems inside the SVG it returns; a throw out of
// tex2svgPromise is the engine itself giving up, which is what a RangeError
// under memory pressure or a broken build looks like. The mock is file-scoped,
// so no test here reaches the real engine.
vi.mock("@mathjax/src", () => ({
  default: {
    init: () => Promise.resolve(undefined),
    tex2svgPromise: () => Promise.reject(new RangeError("Array buffer allocation failed")),
    startup: { adaptor: { tags: () => [], serializeXML: () => "" } }
  }
}));

describe("MathJax engine failures", () => {
  it("reports a throw out of typesetting as renderer-unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "tformula-math-engine-"));
    try {
      const cache = new FormulaCache({ root, maxDiskBytes: 0 });
      const error = await renderMathJaxSvg("E=mc^2", false, 160, cache)
        .then(() => undefined, (failure: unknown) => failure);
      expect(error).toBeInstanceOf(MathRenderError);
      // A tex-error here would let FormulaScreen record this LaTeX as
      // unparseable for the rest of the session over a fault the next attempt
      // could clear, and the message would blame a formula nothing has read.
      expect(error).toMatchObject({ code: "renderer-unavailable" });
      expect(error).toHaveProperty(
        "message",
        expect.stringContaining("Array buffer allocation failed")
      );
      expect(error).not.toHaveProperty("message", expect.stringContaining("parse"));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
