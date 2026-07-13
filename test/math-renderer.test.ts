import { describe, expect, it } from "vitest";
import { MathRenderer, readSvgDimensions } from "../src/math-renderer.js";

describe("MathRenderer", () => {
  it("reads MathJax ex dimensions", () => {
    expect(readSvgDimensions('<svg width="10ex" height="2.5ex" viewBox="0 0 4000 1000"></svg>'))
      .toEqual({ aspectRatio: 4, heightEx: 2.5 });
  });

  it("renders a PNG exactly matching the terminal cell rectangle", async () => {
    const rendered = await new MathRenderer().render(
      {
        startRow: 0,
        endRow: 2,
        startCol: 0,
        endCol: 40,
        latex: "D_{KL}(P\\|M)=\\frac12\\sum_i P_i",
        display: true,
        confidence: "explicit"
      },
      40,
      3,
      {
        kittyGraphics: true,
        foreground: "#eeeeee",
        background: "#202030",
        cell: { width: 9, height: 18, source: "cell-query" }
      },
      1
    );
    const png = Buffer.from(rendered.png);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(360);
    expect(png.readUInt32BE(20)).toBe(54);
  });
});
