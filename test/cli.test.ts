import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli.js";

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
});
