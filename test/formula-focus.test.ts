import { describe, expect, it } from "vitest";
import { FormulaFocusInput } from "../src/formula-focus.js";

describe("FormulaFocusInput", () => {
  it("passes ordinary input through until the configured prefix", () => {
    const input = new FormulaFocusInput("\x1d");
    expect(input.handle("abc")).toEqual({ residual: "abc", actions: [] });
    expect(input.handle("x\x1d")).toEqual({ residual: "x", actions: ["open"] });
    expect(input.active).toBe(true);
  });

  it("consumes arrow navigation tokens and exit keys while focused", () => {
    const input = new FormulaFocusInput("\x1d");
    input.handle("\x1d");
    expect(input.handle("\x0e?\x10")).toEqual({
      residual: "",
      actions: ["next", "previous"]
    });
    expect(input.handle("q")).toEqual({ residual: "", actions: [] });
    expect(input.handle("\x1b")).toEqual({ residual: "", actions: ["close"] });
    expect(input.active).toBe(false);
  });

  it("does not treat letter navigation shortcuts as commands", () => {
    const input = new FormulaFocusInput("\x1d");
    input.handle("\x1d");
    expect(input.handle("njtabpk")).toEqual({ residual: "", actions: [] });
  });

  it("swallows the same prefix while focused", () => {
    const input = new FormulaFocusInput("\x1d");
    expect(input.handle("\x1d\x1d")).toEqual({
      residual: "",
      actions: ["open"]
    });
    expect(input.active).toBe(true);
  });

  it("is transparent when focus is disabled", () => {
    const input = new FormulaFocusInput("");
    expect(input.handle("\x1dtext")).toEqual({ residual: "\x1dtext", actions: [] });
  });

  it("consumes arrows and Escape after external image focus activation", () => {
    const input = new FormulaFocusInput("");
    input.setActive(true);
    expect(input.handle("\x0e\x10\x1b")).toEqual({
      residual: "",
      actions: ["next", "previous", "close"]
    });
    expect(input.active).toBe(false);
  });
});
