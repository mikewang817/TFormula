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
const engine = vi.hoisted(() => ({ attempts: 0 }));

vi.mock("@mathjax/src", () => ({
  default: {
    init: () => Promise.resolve(undefined),
    tex2svgPromise: () => {
      engine.attempts += 1;
      return Promise.reject(new RangeError("Array buffer allocation failed"));
    },
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

  it("lets a later attempt reach the engine again", async () => {
    const root = await mkdtemp(join(tmpdir(), "tformula-math-engine-"));
    try {
      const cache = new FormulaCache({ root, maxDiskBytes: 0 });
      const before = engine.attempts;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await renderMathJaxSvg("a^2+b^2", false, 160, cache).catch(() => undefined);
      }
      // renderFailureCache answers later calls for this key without running
      // the engine, so caching a code that is not a verdict on the source
      // would leave the retry ladder renderer-unavailable was deliberately
      // kept on spinning against the cache: the engine would never be asked
      // a second time, and the retries could not clear anything.
      expect(engine.attempts - before).toBe(2);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
