import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  exportFormulaEntry,
  formulaExportInternals,
  inferFormulaExportFormat
} from "../src/formula-export.js";
import type { FormulaHistoryEntry } from "../src/formula-history.js";

const displayEntry: FormulaHistoryEntry = {
  version: 1,
  id: "export-entry",
  sessionId: "session-d",
  recordedAt: "2026-07-16T10:00:00.000Z",
  latex: "E=mc^2",
  display: true,
  confidence: "explicit"
};

describe("formula export", () => {
  it("provides direct text variants for common authoring workflows", async () => {
    await expect(exportFormulaEntry(displayEntry, { format: "latex" }))
      .resolves.toBe("E=mc^2\n");
    await expect(exportFormulaEntry(displayEntry, { format: "latex-inline" }))
      .resolves.toBe("\\(E=mc^2\\)\n");
    await expect(exportFormulaEntry(displayEntry, { format: "latex-display" }))
      .resolves.toBe("\\[\nE=mc^2\n\\]\n");
    await expect(exportFormulaEntry(displayEntry, { format: "markdown" }))
      .resolves.toBe("$$\nE=mc^2\n$$\n");

    const mathml = await exportFormulaEntry(displayEntry, { format: "mathml" });
    expect(mathml).toMatch(/^<math xmlns="http:\/\/www\.w3\.org\/1998\/Math\/MathML"/u);
    expect(mathml).toContain("<msup");
    expect(mathml).toContain('display="block"');

    const html = await exportFormulaEntry(displayEntry, { format: "html" });
    expect(html).toMatch(/^<div class="tformula-math">/u);
    expect(html).toContain("<math ");
    expect(html).toMatch(/<\/div>\n$/u);
  });

  it("creates a self-contained styled SVG canvas", async () => {
    const svg = await exportFormulaEntry(displayEntry, {
      format: "svg",
      scale: 2,
      color: "#123456",
      background: "white",
      padding: 12
    });
    expect(typeof svg).toBe("string");
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u);
    expect(svg).toContain('color="#123456"');
    expect(svg).toContain('fill="#123456"');
    expect(svg).toContain('<rect width="100%" height="100%" fill="white"/>');
    expect(svg).toContain('x="12" y="12"');
    expect(svg).not.toContain('vertical-align:');
  });

  it("uses a high-resolution transparent PNG preset by default", async () => {
    const png = await exportFormulaEntry(displayEntry, { format: "png" });
    expect(png).toBeInstanceOf(Uint8Array);
    expect(Array.from((png as Uint8Array).subarray(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
    ]);
    const metadata = await sharp(png as Uint8Array).metadata();
    expect(metadata.width).toBeGreaterThan(200);
    expect(metadata.height).toBeGreaterThan(50);
    expect(metadata.hasAlpha).toBe(true);
  });

  it("exports an opaque background and TIFF when requested", async () => {
    const png = await exportFormulaEntry(displayEntry, {
      format: "png",
      scale: 2,
      background: "#ffffff",
      padding: 4
    });
    const { data, info } = await sharp(png as Uint8Array)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(Array.from(data.subarray(0, info.channels))).toEqual([255, 255, 255, 255]);

    const tiff = await exportFormulaEntry(displayEntry, { format: "tiff", scale: 2 });
    expect((await sharp(tiff as Uint8Array).metadata()).format).toBe("tiff");
  });

  it("infers formats from familiar output extensions", () => {
    expect(inferFormulaExportFormat("formula.tex")).toBe("latex");
    expect(inferFormulaExportFormat("formula.md")).toBe("markdown");
    expect(inferFormulaExportFormat("formula.mathml")).toBe("mathml");
    expect(inferFormulaExportFormat("formula.html")).toBe("html");
    expect(inferFormulaExportFormat("formula.svg")).toBe("svg");
    expect(inferFormulaExportFormat("formula.png")).toBe("png");
    expect(inferFormulaExportFormat("formula.tiff")).toBe("tiff");
    expect(inferFormulaExportFormat("formula.unknown")).toBeUndefined();
  });

  it("selects native clipboard commands without shell interpolation", () => {
    expect(formulaExportInternals.clipboardCandidates("darwin", {}, "text/plain"))
      .toEqual([{ command: "pbcopy", args: [] }]);
    expect(formulaExportInternals.clipboardCandidates("linux", {
      WAYLAND_DISPLAY: "wayland-0",
      DISPLAY: ":0"
    }, "application/mathml+xml")).toEqual([
      { command: "wl-copy", args: ["--type", "application/mathml+xml"] },
      { command: "xclip", args: ["-selection", "clipboard", "-t", "application/mathml+xml"] },
      { command: "xsel", args: ["--clipboard", "--input"] }
    ]);
  });
});
