import { describe, expect, it } from "vitest";
import { parseTerminalResponses, probeInternals } from "../src/probe.js";

describe("terminal probing", () => {
  it("extracts cell, window, and theme responses without losing typed input", () => {
    const parsed = parseTerminalResponses([
      "typed",
      "\x1b[6;20;10t",
      "\x1b[4;1200;1800t",
      "\x1b]10;rgb:dddd/eeee/ffff\x1b\\",
      "\x1b]11;rgb:1111/2222/3333\x07"
    ].join(""));
    expect(parsed.cell).toEqual({ width: 10, height: 20 });
    expect(parsed.windowPixels).toEqual({ width: 1800, height: 1200 });
    expect(parsed.foreground).toBe("#ddeeff");
    expect(parsed.background).toBe("#112233");
    expect(parsed.residual).toBe("typed");
  });

  it("recognizes Ghostty as a Kitty-graphics terminal", () => {
    expect(probeInternals.supportsKittyGraphics({ TERM: "xterm-ghostty" })).toBe(true);
  });
});
