import { spawnSync } from "node:child_process";
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
    expect(parseArgs(["paper.pdf"])).toMatchObject({ mode: "reader", path: "paper.pdf" });
    expect(parseArgs(["notebook.ipynb"])).toMatchObject({ mode: "reader", path: "notebook.ipynb" });
    expect(parseArgs(["data.csv"])).toMatchObject({ mode: "reader", path: "data.csv" });
  });

  it("does not take over source-code paths implicitly", () => {
    expect(parseArgs(["app.ts"])).toMatchObject({
      mode: "proxy",
      command: "app.ts"
    });
  });

  it("keeps the command separator as an explicit proxy request", () => {
    expect(parseArgs(["--", "README.md"])).toMatchObject({
      mode: "proxy",
      command: "README.md"
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
});
