import { describe, expect, it } from "vitest";
import {
  kittyDeletePlacement,
  kittyDeleteRange,
  kittyPlaceImage,
  kittyTransmitImage,
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

  it("can upload once and create independent shared-image placements", () => {
    const transmission = kittyTransmitImage(new Uint8Array([137, 80, 78, 71]), 42);
    expect(transmission).toContain("a=t,f=100");
    expect(transmission).not.toContain("c=30");

    const placement = kittyPlaceImage(42, 7, 30, 3);
    expect(placement).toContain("a=p,i=42,p=7");
    expect(placement).toContain("c=30,r=3,C=1");
    expect(kittyDeletePlacement(42, 7)).toContain("a=d,d=i,i=42,p=7");
  });

  it("can delete the complete reserved TFormula image-id range", () => {
    const encoded = kittyDeleteRange();
    expect(encoded).toContain("a=d,d=R");
    expect(encoded).toContain(`x=${TFORMULA_IMAGE_ID_MIN}`);
    expect(encoded).toContain(`y=${TFORMULA_IMAGE_ID_MAX}`);
  });
});
