import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isTFormulaActive, parseArgs } from "../src/cli.js";

describe("CLI arguments", () => {
  it("wraps any command without agent-specific knowledge", () => {
    const options = parseArgs(["--scale", "1.1", "--", "claude", "--resume"]);
    expect(options).toMatchObject({ command: "claude", args: ["--resume"], scale: 1.1 });
  });

  it("starts a login shell by default", () => {
    const options = parseArgs([]);
    expect(options).not.toBe("help");
    expect(options).not.toBe("version");
    if (typeof options === "object") expect(options.args).toEqual(["-l"]);
  });

  it("opens known document paths in reader mode", () => {
    expect(parseArgs(["README.md"])).toMatchObject({
      mode: "reader",
      path: "README.md"
    });
    expect(parseArgs(["--read", "package.json"])).toMatchObject({
      mode: "reader",
      path: "package.json"
    });
  });

  it("keeps the command separator as an explicit proxy request", () => {
    expect(parseArgs(["--", "README.md"])).toMatchObject({
      mode: "proxy",
      command: "README.md"
    });
  });

  it("parses formula history utilities without starting a proxy", () => {
    expect(parseArgs(["history"])).toMatchObject({
      mode: "history",
      limit: 20,
      json: false,
      clear: false
    });
    expect(parseArgs(["history", "--limit", "5", "--json", "--debug"])).toMatchObject({
      mode: "history",
      limit: 5,
      json: true,
      debug: true
    });
    expect(parseArgs(["history", "--clear"])).toMatchObject({
      mode: "history",
      clear: true
    });
  });

  it("parses formula export selectors and formats", () => {
    expect(parseArgs(["export", "--last", "--format", "svg", "-o", "formula.svg"]))
      .toMatchObject({
        mode: "export",
        selector: "last",
        format: "svg",
        output: "formula.svg"
      });
    expect(parseArgs(["export", "abc123", "--format", "latex"]))
      .toMatchObject({
        mode: "export",
        selector: "abc123",
        format: "latex"
      });
  });

  it("infers a high-quality export format from a save path", () => {
    expect(parseArgs(["save", "formula.png"])).toMatchObject({
      mode: "export",
      selector: "last",
      format: "png",
      output: "formula.png"
    });
    expect(parseArgs([
      "save",
      "abc123",
      "formula.svg",
      "--scale",
      "2",
      "--color",
      "#123456",
      "--background",
      "white",
      "--padding",
      "12"
    ])).toMatchObject({
      mode: "export",
      selector: "abc123",
      format: "svg",
      output: "formula.svg",
      scale: 2,
      color: "#123456",
      background: "white",
      padding: 12
    });
    expect(parseArgs(["save", "formula.mathml"])).toMatchObject({ format: "mathml" });
    expect(parseArgs(["save", "formula.md"])).toMatchObject({ format: "markdown" });
  });

  it("parses one-step clipboard exports", () => {
    expect(parseArgs(["copy"])).toMatchObject({
      mode: "copy",
      selector: "last",
      format: "latex"
    });
    expect(parseArgs(["copy", "mathml"])).toMatchObject({
      mode: "copy",
      selector: "last",
      format: "mathml"
    });
    expect(parseArgs(["copy", "abc123", "markdown"])).toMatchObject({
      mode: "copy",
      selector: "abc123",
      format: "markdown"
    });
  });

  it("allows persistent formula history to be disabled for a proxy", () => {
    expect(parseArgs(["--no-history", "codex"])).toMatchObject({
      mode: "proxy",
      command: "codex",
      recordHistory: false
    });
  });

  it("detects an existing TFormula proxy", () => {
    expect(isTFormulaActive({ TFORMULA_ACTIVE: "1" })).toBe(true);
    expect(isTFormulaActive({ TFORMULA_ACTIVE: "0" })).toBe(false);
    expect(isTFormulaActive({})).toBe(false);
  });

  it("rejects a nested proxy before spawning its command", () => {
    const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
    const result = spawnSync(tsx, [
      "src/cli.ts",
      "--",
      process.execPath,
      "-e",
      "process.stdout.write('child-ran')"
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, TFORMULA_ACTIVE: "1" }
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("TFormula is already active");
    expect(result.stdout).not.toContain("child-ran");
  });

  it("still exposes version information inside a managed shell", () => {
    const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
    const result = spawnSync(tsx, ["src/cli.ts", "--version"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, TFORMULA_ACTIVE: "1" }
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/u);
  });

  it("lists and exports history without nesting another terminal proxy", () => {
    const root = mkdtempSync(join(tmpdir(), "tformula-cli-history-"));
    try {
      writeFileSync(join(root, "seed.jsonl"), `${JSON.stringify({
        version: 1,
        id: "1234567890abcdef",
        sessionId: "seed",
        recordedAt: "2026-07-16T10:00:00.000Z",
        latex: "\\int_0^1 x\\,dx",
        display: true,
        confidence: "explicit"
      })}\n`, { mode: 0o600 });
      const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
      const environment = {
        ...process.env,
        TFORMULA_ACTIVE: "1",
        TFORMULA_HISTORY_DIR: root
      };
      const listed = spawnSync(tsx, ["src/cli.ts", "history", "--json", "--debug"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: environment
      });
      expect(listed.status).toBe(0);
      expect(JSON.parse(listed.stdout)).toEqual([
        expect.objectContaining({ id: "1234567890abcdef", latex: "\\int_0^1 x\\,dx" })
      ]);
      expect(listed.stderr).toContain("formula history loaded 1 record(s)");
      expect(listed.stderr).not.toContain("\\int_0^1");

      const output = join(root, "formula.tex");
      const exported = spawnSync(tsx, [
        "src/cli.ts",
        "export",
        "123456",
        "--format",
        "latex",
        "--output",
        output
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: environment
      });
      expect(exported.status).toBe(0);
      expect(readFileSync(output, "utf8")).toBe("\\int_0^1 x\\,dx\n");

      const pngOutput = join(root, "formula.png");
      const saved = spawnSync(tsx, [
        "src/cli.ts",
        "save",
        "123456",
        pngOutput,
        "--scale",
        "2",
        "--debug"
      ], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: environment
      });
      expect(saved.status).toBe(0);
      expect(Array.from(readFileSync(pngOutput).subarray(0, 8))).toEqual([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
      ]);
      expect(saved.stderr).toContain("formula export generated png");
      expect(saved.stderr).not.toContain("\\int_0^1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
