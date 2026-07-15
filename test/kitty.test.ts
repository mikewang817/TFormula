import { describe, expect, it } from "vitest";
import {
  kittyDeletePlacement,
  kittyDeletePlacementsByZIndex,
  kittyPlaceImage,
  kittyTransmitImage,
  kittyTransmitImageFile,
  kittyTransmitAndPlace
} from "../src/kitty.js";

describe("Kitty graphics encoding", () => {
  it("uses fixed cell placement without moving the cursor", () => {
    const encoded = kittyTransmitAndPlace(new Uint8Array([137, 80, 78, 71]), 42, 30, 3);
    expect(encoded).toContain("a=T,f=100");
    expect(encoded).toContain("i=42");
    expect(encoded).toContain("c=30,r=3,C=1");
    expect(encoded).toContain("iVBORw==");
    expect(encoded).toContain("q=0");
  });

  it("can upload once and create independent shared-image placements", () => {
    const transmission = kittyTransmitImage(new Uint8Array([137, 80, 78, 71]), 42);
    expect(transmission).toContain("a=t,f=100");
    expect(transmission).not.toContain("c=30");

    const placement = kittyPlaceImage(42, 7, 30, 3);
    expect(placement).toContain("a=p,i=42,p=7");
    expect(placement).toContain("c=30,r=3,C=1");
    expect(transmission).toContain("q=0");
    expect(placement).toContain("q=0");
    const cropped = kittyPlaceImage(42, 8, 30, 5, {
      x: 0,
      y: 36,
      width: 270,
      height: 90
    });
    expect(cropped).toContain("c=30,r=5,x=0,y=36,w=270,h=90");
    expect(kittyDeletePlacement(42, 7)).toContain("a=d,d=i,i=42,p=7");
    expect(kittyDeletePlacementsByZIndex()).toContain("a=d,d=z");
  });

  it("keeps every direct-transmission payload within the Kitty chunk limit", () => {
    const png = Uint8Array.from({ length: 10_000 }, (_, index) => index % 251);
    const encoded = kittyTransmitImage(png, 42);
    const packets = Array.from(
      encoded.matchAll(/\x1b_G([^;]+);([A-Za-z0-9+/=]*)\x1b\\/gu),
      (match) => ({ controls: match[1]!, payload: match[2]! })
    );

    expect(packets.length).toBeGreaterThan(1);
    expect(packets.every(({ payload }) => payload.length <= 4096)).toBe(true);
    expect(packets.slice(0, -1).every(({ payload }) => payload.length % 4 === 0)).toBe(true);
    expect(packets.slice(0, -1).every(({ controls }) => controls.includes("q=1"))).toBe(true);
    expect(packets.at(-1)?.controls).toContain("m=0");
    expect(packets.at(-1)?.controls).toContain("q=0");
    expect(Buffer.from(packets.map(({ payload }) => payload).join(""), "base64"))
      .toEqual(Buffer.from(png));
  });

  it("encodes a terminal-owned temporary-file path instead of PNG bytes", () => {
    const path = "/tmp/tformula-tty-graphics-protocol-test/image.png";
    const encoded = kittyTransmitImageFile(path, 42);
    const payload = encoded.match(/;([A-Za-z0-9+/=]+)\x1b\\$/u)?.[1];

    expect(encoded).toContain("a=t,f=100,t=t,i=42");
    expect(encoded).toContain("q=0");
    expect(Buffer.from(payload ?? "", "base64").toString("utf8")).toBe(path);
  });
});
