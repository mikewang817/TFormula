import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FormulaCache } from "../src/formula-cache.js";
import { MathRenderError, renderMathJaxSvg } from "../src/math-renderer.js";

// Typesetting resolves here, so this is not the engine giving up the way
// math-renderer-engine-failure.test.ts models it: the engine hands back a node
// the adaptor finds no <svg> root in, which is what a build missing output/svg
// or an adaptor mismatched to the output jax looks like. The mock is
// file-scoped, so no test here reaches the real engine.
const engine = vi.hoisted(() => ({ attempts: 0 }));

vi.mock("@mathjax/src", () => ({
  default: {
    init: () => Promise.resolve(undefined),
    tex2svgPromise: () => {
      engine.attempts += 1;
      return Promise.resolve({});
    },
    startup: { adaptor: { tags: () => [], serializeXML: () => "" } }
  }
}));

describe("MathJax typesetting without an SVG root", () => {
  it("reports a missing SVG root as renderer-unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "tformula-math-no-svg-"));
    try {
      const cache = new FormulaCache({ root, maxDiskBytes: 0 });
      const error = await renderMathJaxSvg("E=mc^2", false, 160, cache)
        .then(() => undefined, (failure: unknown) => failure);
      expect(error).toBeInstanceOf(MathRenderError);
      // invalid-svg is a verdict on serialized output, and FormulaScreen holds
      // it against the LaTeX for the rest of the session on the first
      // occurrence, with no retry ladder. Nothing here read the formula.
      expect(error).toMatchObject({ code: "renderer-unavailable" });
      expect(error).toHaveProperty(
        "message",
        expect.stringContaining("no <svg> root")
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("lets a later attempt reach the engine again", async () => {
    const root = await mkdtemp(join(tmpdir(), "tformula-math-no-svg-"));
    try {
      const cache = new FormulaCache({ root, maxDiskBytes: 0 });
      const before = engine.attempts;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await renderMathJaxSvg("a^2+b^2", false, 160, cache).catch(() => undefined);
      }
      // renderFailureCache answers later calls for this key without running the
      // engine, so a code that is not a verdict on the source must stay out of
      // it: a repaired build has to be able to reach the engine again.
      expect(engine.attempts - before).toBe(2);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
