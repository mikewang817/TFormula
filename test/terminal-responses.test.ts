import { describe, expect, it } from "vitest";
import { TFORMULA_IMAGE_ID_MIN } from "../src/kitty.js";
import { TerminalResponseFilter } from "../src/terminal-responses.js";

const response = `\x1b_Gi=${TFORMULA_IMAGE_ID_MIN};ENOENT: image not found\x1b\\`;

describe("TerminalResponseFilter", () => {
  it("removes TFormula graphics errors while preserving typed input", () => {
    const filter = new TerminalResponseFilter();
    const filtered = filter.push(`before${response}after`);

    expect(filtered.residual).toBe("beforeafter");
    expect(filtered.graphics).toEqual([{
      imageId: TFORMULA_IMAGE_ID_MIN,
      message: "ENOENT: image not found",
      raw: response
    }]);
  });

  it("preserves graphics responses owned by other applications", () => {
    const filter = new TerminalResponseFilter();
    const foreign = "\x1b_Gi=42;EINVAL: foreign\x1b\\";
    expect(filter.push(foreign)).toEqual({ residual: foreign, graphics: [] });
  });

  it("reports placement ids and can restrict responses to allocated images", () => {
    const filter = new TerminalResponseFilter((imageId) => imageId === 99);
    const owned = "\x1b_Gi=99,p=7;EINVAL: placement\x1b\\";
    const foreign = `\x1b_Gi=${TFORMULA_IMAGE_ID_MIN};ENOENT\x1b\\`;
    expect(filter.push(`${owned}${foreign}`)).toEqual({
      residual: foreign,
      graphics: [{ imageId: 99, placementId: 7, message: "EINVAL: placement", raw: owned }]
    });
  });

  it("recognizes a response across every possible chunk boundary", () => {
    for (let split = 0; split <= response.length; split += 1) {
      const filter = new TerminalResponseFilter();
      const first = filter.push(`typed${response.slice(0, split)}`);
      const second = filter.push(`${response.slice(split)}tail`);
      expect(first.residual + second.residual, `split ${split}`).toBe("typedtail");
      expect([...first.graphics, ...second.graphics], `split ${split}`).toHaveLength(1);
      expect(filter.flush(), `split ${split}`).toBe("");
    }
  });

  it("recognizes 8-bit APC and ST responses across every chunk boundary", () => {
    const eightBit = `\u009fGi=${TFORMULA_IMAGE_ID_MIN};ENOENT: missing\u009c`;
    for (let split = 0; split <= eightBit.length; split += 1) {
      const filter = new TerminalResponseFilter();
      const first = filter.push(`typed${eightBit.slice(0, split)}`);
      const second = filter.push(`${eightBit.slice(split)}tail`);
      expect(first.residual + second.residual, `split ${split}`).toBe("typedtail");
      expect([...first.graphics, ...second.graphics], `split ${split}`).toHaveLength(1);
      expect(filter.flush(), `split ${split}`).toBe("");
    }
  });

  it("flushes an incomplete non-response APC without losing bytes", () => {
    const filter = new TerminalResponseFilter();
    expect(filter.push("typed\x1b_").residual).toBe("typed");
    expect(filter.hasPending).toBe(true);
    expect(filter.flush()).toBe("\x1b_");
    expect(filter.hasPending).toBe(false);
  });

  it("distinguishes an ambiguous Escape prefix from a confirmed Kitty response", () => {
    const filter = new TerminalResponseFilter();
    filter.push("\x1b_");
    expect(filter.hasPending).toBe(true);
    expect(filter.hasConfirmedGraphicsResponse).toBe(false);
    filter.push(`Gi=${TFORMULA_IMAGE_ID_MIN};ENOENT`);
    expect(filter.hasConfirmedGraphicsResponse).toBe(true);
  });

  it("bounds an unterminated response instead of buffering input forever", () => {
    const filter = new TerminalResponseFilter(undefined, 256);
    expect(filter.push(`\x1b_Gi=${TFORMULA_IMAGE_ID_MIN};${"x".repeat(300)}`).residual)
      .toContain("x".repeat(300));
    expect(filter.hasPending).toBe(false);
  });
});
