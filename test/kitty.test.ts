import { describe, expect, it } from "vitest";
import {
  kittyDeleteRange,
  kittyTransmitAndPlace,
  TFORMULA_IMAGE_ID_MAX,
  TFORMULA_IMAGE_ID_MIN
} from "../src/kitty.js";

describe("Kitty graphics encoding", () => {
  it("uses fixed cell placement without moving the cursor", () => {
    const encoded = kittyTransmitAndPlace(new Uint8Array([137, 80, 78, 71]), 42, 30, 3);
    expect(encoded).toContain("a=T,f=100");
    expect(encoded).toContain("i=42");
    expect(encoded).toContain("c=30,r=3,C=1");
    expect(encoded).toContain("iVBORw==");
  });

  it("can delete the complete reserved TFormula image-id range", () => {
    const encoded = kittyDeleteRange();
    expect(encoded).toContain("a=d,d=R");
    expect(encoded).toContain(`x=${TFORMULA_IMAGE_ID_MIN}`);
    expect(encoded).toContain(`y=${TFORMULA_IMAGE_ID_MAX}`);
  });
});
