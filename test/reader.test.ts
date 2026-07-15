import { describe, expect, it } from "vitest";
import { readerInternals } from "../src/reader.js";
import type { ReaderPlacement } from "../src/reader-layout.js";

describe("reader viewport graphics", () => {
  it("crops zoomed images to visible rows while keeping formulas atomic", () => {
    const image: ReaderPlacement = {
      row: 10,
      col: 3,
      columns: 20,
      rows: 30,
      asset: {
        kind: "image",
        key: "image\0/tmp/demo.png",
        path: "/tmp/demo.png"
      }
    };
    const completeFormula: ReaderPlacement = {
      row: 22,
      col: 5,
      columns: 8,
      rows: 2,
      asset: {
        kind: "math",
        key: "display\0x^2",
        latex: "x^2",
        display: true
      }
    };
    const clippedFormula: ReaderPlacement = {
      ...completeFormula,
      row: 18,
      rows: 4
    };

    const visible = readerInternals.visibleReaderPlacements(
      [image, completeFormula, clippedFormula],
      20,
      10,
      { width: 9, height: 18, source: "fallback" }
    );

    expect(visible).toHaveLength(2);
    expect(visible[0]).toEqual({
      placement: image,
      screenRow: 0,
      rows: 10,
      source: { x: 0, y: 180, width: 180, height: 180 }
    });
    expect(visible[1]).toEqual({
      placement: completeFormula,
      screenRow: 2,
      rows: 2
    });
  });

  it("keeps fractional-cell crop rectangles inside the uploaded PNG", () => {
    const image: ReaderPlacement = {
      row: 0,
      col: 0,
      columns: 3,
      rows: 2,
      asset: { kind: "image", key: "image\0demo", path: "/tmp/demo.png" }
    };

    const [bottomHalf] = readerInternals.visibleReaderPlacements(
      [image],
      1,
      1,
      { width: 9.5, height: 17.5, source: "window-query" }
    );

    expect(bottomHalf?.source).toEqual({ x: 0, y: 18, width: 29, height: 17 });
    expect(bottomHalf!.source!.y + bottomHalf!.source!.height).toBe(35);
  });
});
