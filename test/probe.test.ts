import { describe, expect, it } from "vitest";
import {
  isRuntimeProbeQueryId,
  parseTerminalResponses,
  probeInternals,
  RUNTIME_PROBE_QUERY_ID_MAX,
  RUNTIME_PROBE_QUERY_ID_MIN,
  runtimeProbeBarrier,
  runtimeProbeQueryId,
  TerminalProbeResponseFilter
} from "../src/probe.js";

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
    expect(parsed.primaryDeviceAttributes).toBe(false);
    expect(parsed.residual).toBe("typed");
  });

  it("confirms Kitty graphics and consumes only TFormula's query response", () => {
    const id = probeInternals.KITTY_QUERY_IMAGE_ID;
    const parsed = parseTerminalResponses([
      "before",
      `\x1b_Gi=${id};OK\x1b\\`,
      "\x1b[?62;4;6;22c",
      "\x1b_Gi=42;OK\x1b\\",
      "after"
    ].join(""));

    expect(parsed.kittyGraphics).toBe(true);
    expect(parsed.primaryDeviceAttributes).toBe(true);
    expect(parsed.residual).toBe("before\x1b_Gi=42;OK\x1b\\after");
  });

  it("parses equivalent 8-bit C1 probe responses", () => {
    const id = probeInternals.KITTY_QUERY_IMAGE_ID;
    const parsed = parseTerminalResponses([
      "before",
      `\u009fGi=${id};OK\u009c`,
      "\u009b6;20;10t",
      "\u009b4;1200;1800t",
      "\u009d10;rgb:dddd/eeee/ffff\u009c",
      "\u009d11;rgb:1111/2222/3333\u009c",
      "\u009b?62;4c",
      "after"
    ].join(""));

    expect(parsed.kittyGraphics).toBe(true);
    expect(parsed.cell).toEqual({ width: 10, height: 20 });
    expect(parsed.windowPixels).toEqual({ width: 1800, height: 1200 });
    expect(parsed.foreground).toBe("#ddeeff");
    expect(parsed.background).toBe("#112233");
    expect(parsed.primaryDeviceAttributes).toBe(true);
    expect(parsed.residual).toBe("beforeafter");
  });

  it("treats a Kitty query error as a definitive negative", () => {
    const parsed = parseTerminalResponses(
      `\x1b_Gi=${probeInternals.KITTY_QUERY_IMAGE_ID};EINVAL: unsupported\x1b\\\x1b[?1;2c`
    );
    expect(parsed.kittyGraphics).toBe(false);
    expect(parsed.primaryDeviceAttributes).toBe(true);
    expect(parsed.residual).toBe("");
    expect(probeInternals.KITTY_GRAPHICS_QUERY).toContain("a=q,t=d,f=24;AAAA");
  });

  it("recognizes Ghostty as a Kitty-graphics terminal", () => {
    expect(probeInternals.supportsKittyGraphics({ TERM: "xterm-ghostty" })).toBe(true);
    expect(probeInternals.supportsKittyGraphics({
      TERM: "tmux-256color",
      TERM_PROGRAM: "ghostty"
    })).toBe(false);
    expect(probeInternals.supportsKittyGraphics({
      TERM: "screen-256color",
      TERM_PROGRAM: "kitty"
    })).toBe(false);
    expect(probeInternals.supportsKittyGraphics({
      TERM: "xterm-256color",
      TERM_PROGRAM: "ghostty",
      TMUX: "/tmp/tmux.sock"
    })).toBe(false);
    expect(probeInternals.supportsKittyGraphics({
      TERM: "xterm-256color",
      TERM_PROGRAM: "ghostty",
      MOSH_CONNECTION: "client server"
    })).toBe(false);
  });

  it("fails closed unless the Kitty query explicitly succeeds", () => {
    expect(probeInternals.confirmedKittyGraphics(true, true)).toBe(true);
    expect(probeInternals.confirmedKittyGraphics(true, false)).toBe(false);
    expect(probeInternals.confirmedKittyGraphics(true, undefined)).toBe(false);
    expect(probeInternals.confirmedKittyGraphics(false, true)).toBe(false);
  });

  it("finishes an adaptive startup probe only at its ordered barrier", () => {
    const partial = parseTerminalResponses("\x1b[6;20;10t");
    const deviceBarrier = parseTerminalResponses("\x1b[?62;4c");
    const kittyBarrier = parseTerminalResponses(
      `\x1b_Gi=${probeInternals.KITTY_QUERY_IMAGE_ID};OK\x1b\\`
    );

    expect(probeInternals.startupProbeBarrierReceived(partial, false)).toBe(false);
    expect(probeInternals.startupProbeBarrierReceived(deviceBarrier, false)).toBe(true);
    expect(probeInternals.startupProbeBarrierReceived(deviceBarrier, true)).toBe(false);
    expect(probeInternals.startupProbeBarrierReceived(kittyBarrier, true)).toBe(true);
  });

  it("assigns tagged runtime barriers outside formula image ids and wraps safely", () => {
    expect(runtimeProbeQueryId(1)).toBe(RUNTIME_PROBE_QUERY_ID_MIN);
    const range = RUNTIME_PROBE_QUERY_ID_MAX - RUNTIME_PROBE_QUERY_ID_MIN + 1;
    expect(runtimeProbeQueryId(range)).toBe(RUNTIME_PROBE_QUERY_ID_MAX);
    expect(runtimeProbeQueryId(range + 1)).toBe(RUNTIME_PROBE_QUERY_ID_MIN);
    expect(runtimeProbeQueryId(-1)).toBeGreaterThanOrEqual(RUNTIME_PROBE_QUERY_ID_MIN);
    expect(runtimeProbeQueryId(-1)).toBeLessThanOrEqual(RUNTIME_PROBE_QUERY_ID_MAX);
    expect(RUNTIME_PROBE_QUERY_ID_MAX).toBeLessThanOrEqual(0xffff_ffff);
    expect(isRuntimeProbeQueryId(RUNTIME_PROBE_QUERY_ID_MIN)).toBe(true);
    expect(isRuntimeProbeQueryId(RUNTIME_PROBE_QUERY_ID_MAX)).toBe(true);
    expect(isRuntimeProbeQueryId(probeInternals.KITTY_QUERY_IMAGE_ID)).toBe(false);
    expect(runtimeProbeBarrier(RUNTIME_PROBE_QUERY_ID_MIN)).toContain(
      `i=${RUNTIME_PROBE_QUERY_ID_MIN}`
    );
  });

  it("streams probe replies across every split while forwarding keyboard input", () => {
    const responses = [
      "\x1b[6;20;10t",
      "\u009b4;1200;1800t",
      "\x1b]10;rgb:dddd/eeee/ffff\x1b\\",
      "\u009d11;rgb:1111/2222/3333\u009c"
    ];
    const foreign = "\x1b[?1;2c";
    const input = `typed${responses[0]}mid${responses[1]}${responses[2]}${foreign}${responses[3]}tail`;

    for (let split = 0; split <= input.length; split += 1) {
      const filter = new TerminalProbeResponseFilter();
      const first = filter.push(input.slice(0, split));
      const second = filter.push(input.slice(split));
      expect(first.residual + second.residual, `split ${split}`)
        .toBe(`typedmid${foreign}tail`);
      expect([...first.responses, ...second.responses], `split ${split}`).toEqual(responses);
      expect(filter.flush(), `split ${split}`).toBe("");
    }
  });

  it("drops a quarantined truncated response but preserves an ambiguous Escape key", () => {
    const response = new TerminalProbeResponseFilter();
    expect(response.push("typed\x1b[6;20;").residual).toBe("typed");
    expect(response.hasPending).toBe(true);
    expect(response.flush(true)).toBe("");

    const escape = new TerminalProbeResponseFilter();
    expect(escape.push("\x1b").residual).toBe("");
    expect(escape.flush(true)).toBe("\x1b");
  });

  it("captures a fragmented device-attributes barrier only during startup quarantine", () => {
    const startup = new TerminalProbeResponseFilter();
    const first = startup.push("typed\x1b[?62;", true);
    const second = startup.push("4;6;22ctail", true);
    expect(first.residual + second.residual).toBe("typedtail");
    expect([...first.responses, ...second.responses]).toEqual(["\x1b[?62;4;6;22c"]);

    const runtime = new TerminalProbeResponseFilter();
    expect(runtime.push("\x1b[?62;4;6;22c").residual).toBe("\x1b[?62;4;6;22c");
  });
});
