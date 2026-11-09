import { describe, expect, it } from "vitest";
import { FormulaFocusInput } from "../src/formula-focus.js";

describe("FormulaFocusInput", () => {
  it("passes ordinary input through until the configured prefix", () => {
    const input = new FormulaFocusInput("\x1d");
    expect(input.handle("abc")).toEqual({ residual: "abc", actions: [] });
    expect(input.handle("x\x1d")).toEqual({ residual: "x", actions: ["open"] });
    expect(input.active).toBe(true);
  });

  it("consumes navigation, unknown, and exit keys while focused", () => {
    const input = new FormulaFocusInput("\x1d");
    input.handle("\x1d");
    expect(input.handle("n?p")).toEqual({
      residual: "",
      actions: ["next", "previous"]
    });
    expect(input.handle("qtail")).toEqual({ residual: "tail", actions: ["close"] });
    expect(input.active).toBe(false);
  });

  it("allows the same prefix to close without leaking bytes", () => {
    const input = new FormulaFocusInput("\x1d");
    expect(input.handle("\x1d\x1d")).toEqual({
      residual: "",
      actions: ["open", "close"]
    });
  });

  it("swallows whole arrow-key sequences and closes only on a bare ESC", () => {
    const input = new FormulaFocusInput("\x1d");
    input.handle("\x1d");
    expect(input.handle("\x1b[A\x1bOB\x1b[1;5C")).toEqual({ residual: "", actions: [] });
    expect(input.active).toBe(true);
    expect(input.handle("\x1b")).toEqual({ residual: "", actions: ["close"] });
    expect(input.active).toBe(false);
  });

  it("accepts the Kitty keyboard protocol form of the prefix", () => {
    const input = new FormulaFocusInput("\x1d");
    expect(input.handle("a\x1b[93;5u")).toEqual({ residual: "a", actions: ["open"] });
    expect(input.handle("\x1b[93;5u")).toEqual({ residual: "", actions: ["close"] });
    expect(new FormulaFocusInput("\x01").handle("\x1b[97;5u").actions).toEqual(["open"]);
  });

  it("is transparent when focus is disabled", () => {
    const input = new FormulaFocusInput("");
    expect(input.handle("\x1dtext")).toEqual({ residual: "\x1dtext", actions: [] });
  });
});
