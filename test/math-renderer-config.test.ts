import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadMathRendererConfig } from "../src/math-renderer-config.js";

describe("Math renderer configuration", () => {
  it("loads validated macros, environments, fonts, and system-font policy", () => {
    const directory = mkdtempSync(join(tmpdir(), "tformula-math-config-"));
    const first = join(directory, "math.ttf");
    const second = join(directory, "text.otf");
    writeFileSync(first, "fixture");
    writeFileSync(second, "fixture");
    try {
      const config = loadMathRendererConfig({
        TFORMULA_MATH_MACROS: JSON.stringify({
          RR: "\\mathbb{R}",
          "\\vect": ["\\mathbf{#1}", 1]
        }),
        TFORMULA_MATH_ENVIRONMENTS: JSON.stringify({
          braced: ["\\left\\{", "\\right\\}"]
        }),
        TFORMULA_FONT_FILES: `${first}${delimiter}${second}`,
        TFORMULA_SYSTEM_FONTS: "false"
      });
      expect(config.macros).toEqual({
        RR: "\\mathbb{R}",
        vect: ["\\mathbf{#1}", 1]
      });
      expect(config.environments).toEqual({
        braced: ["\\left\\{", "\\right\\}"]
      });
      expect(config.fontFiles).toEqual([first, second]);
      expect(config.loadSystemFonts).toBe(false);
      expect(config.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("applies configured macros in an isolated renderer process", () => {
    const cache = mkdtempSync(join(tmpdir(), "tformula-config-render-"));
    try {
      const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
      const result = spawnSync(tsx, [
        "-e",
        "import('./src/math-renderer.ts').then(async m => { const svg = await m.renderMathJaxSvg('x\\\\in\\\\RR,\\\\begin{braced}y\\\\end{braced}', false, 240); process.stdout.write(svg.includes('data-mml-node=\\\"math\\\"') ? 'ok' : 'bad') }).catch(e => { console.error(e); process.exit(1) })"
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          TFORMULA_MATH_MACROS: JSON.stringify({ RR: "\\mathbb{R}" }),
          TFORMULA_MATH_ENVIRONMENTS: JSON.stringify({
            braced: ["\\left\\{", "\\right\\}"]
          }),
          TFORMULA_CACHE_DIR: cache
        }
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("ok");
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it("rejects malformed, external-content, and missing-font configuration", () => {
    expect(() => loadMathRendererConfig({ TFORMULA_MATH_MACROS: "[]" }))
      .toThrow("must be a JSON object");
    expect(() => loadMathRendererConfig({
      TFORMULA_MATH_MACROS: JSON.stringify({ remote: "\\href{https://example.com}{x}" })
    })).toThrow("contains a disabled command");
    expect(() => loadMathRendererConfig({
      TFORMULA_MATH_MACROS: JSON.stringify({ nested: ["#1", 1, ["\\url{bad}"]] })
    })).toThrow("contains a disabled command");
    expect(() => loadMathRendererConfig({
      TFORMULA_FONT_FILES: join(tmpdir(), "tformula-missing-font.ttf")
    })).toThrow("does not exist");
  });
});
