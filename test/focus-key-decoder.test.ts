import { describe, expect, it } from "vitest";
import { FocusKeyDecoder } from "../src/focus-key-decoder.js";

describe("FocusKeyDecoder", () => {
  it("accepts fragmented Kitty Ctrl-backslash and ignores its release", () => {
    const decoder = new FocusKeyDecoder(new Set(["\x1c"]));
    expect(decoder.push("ordinary\x1b[92;", false)).toBe("ordinary");
    expect(decoder.hasPending).toBe(true);
    expect(decoder.push("5:1u", false)).toBe("\x1c");
    expect(decoder.push("\x1b[92;5:3u", true)).toBe("");
    expect(decoder.push("\x1b[92;5:2u", true)).toBe("");
    expect(decoder.hasPending).toBe(false);
  });

  it("passes unrelated terminal input to the child unchanged outside focus", () => {
    const decoder = new FocusKeyDecoder(new Set(["\x1c"]));
    const input = "\x1b[?1u\x1b[A\x1b[97;5u\x1b[92;3u";
    expect(decoder.push(input, false)).toBe(input);
    expect(decoder.push("\x1b", false)).toBe("");
    expect(decoder.flush()).toBe("\x1b");
  });

  it("recognizes Ctrl-F with NumLock or CapsLock and still rejects Ctrl-Alt-F", () => {
    const decoder = new FocusKeyDecoder(new Set(["\x06"]));
    expect(decoder.push("\x1b[102;133u", false)).toBe("\x06");
    expect(decoder.push("\x1b[102;197:1u", false)).toBe("\x06");
    expect(decoder.push("\x1b[102;133:3u", false)).toBe("");
    expect(decoder.push("\x1b[102;135u", false)).toBe("\x1b[102;135u");
    expect(decoder.push("\x1b[113;129u", true)).toBe("q");
  });

  it("decodes navigation and Escape while focus is active", () => {
    const decoder = new FocusKeyDecoder(new Set(["\x1c"]));
    expect(decoder.push("\x1b[110u\x1b[9u\x1b[27u", true)).toBe("n\t\x1b");
    expect(decoder.push("\x1b[113;1:3u\x1b[A", true)).toBe("");
  });
});
