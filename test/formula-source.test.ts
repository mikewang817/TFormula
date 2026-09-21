import { readFile, mkdtemp, writeFile, appendFile, rm, realpath, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { FormulaSource, terminalMarkdownProjection } from "../src/formula-source.js";
import { CodexFormulaSource, discoverCodexSession, findCodexResumeSource } from "../src/codex-source.js";
import { FormulaScreen } from "../src/screen.js";
import { FormulaCache } from "../src/formula-cache.js";
import { MathRenderer } from "../src/math-renderer.js";

const formulas: string[] = JSON.parse(await readFile(new URL("./fixtures/opsd-formulas.json", import.meta.url), "utf8"));
const markdown = (latex: string) => `\\[\n${latex}\n\\]`;
const capabilities = {
  kittyGraphics: true, foreground: "#cdd6f4", background: "#1e1e2e",
  cell: { width: 9, height: 18, source: "cell-query" as const }
};
const root = await mkdtemp(join(tmpdir(), "tformula-source-test-"));
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe("OPSD source-backed formula recovery", () => {
  it.each([60, 100, 160])("renders all 19 regression formulas exactly at %i columns", async (cols) => {
    const source = new FormulaSource();
    source.addMarkdown(formulas.map(markdown).join("\n\n"));
    const renderer = new MathRenderer(new FormulaCache({ root: join(root, String(cols)), maxDiskBytes: 0 }));
    for (const latex of formulas) {
      const rendered: string[] = [];
      const graphics: Array<string | Uint8Array> = [];
      const screen = new FormulaScreen({ cols, rows: 70, capabilities, scale: 1,
        stabilityMs: 0, formulaSource: source, renderer,
        writeOuter: (data) => graphics.push(data), onFormulaRendered: (event) => rendered.push(event.latex) });
      try {
        const projected = terminalMarkdownProjection(markdown(latex));
        await screen.write(`Before\r\n\r\n${projected.replaceAll("\n", "\r\n")}\r\n\r\nAfter\r\n`);
        await screen.flushScan();
        expect(rendered, latex).toEqual([latex]);
        expect(screen.recentFormulas[0]?.degradationReason, latex).toBeUndefined();
        expect(graphics.length).toBeGreaterThan(0);
      } finally { screen.dispose(); }
    }
  }, 30_000);

  it("recovers hard wrapping and preserves the original underscore and double bar", () => {
    const latex = formulas[11]!;
    const source = new FormulaSource(); source.addMarkdown(markdown(latex));
    const lines = terminalMarkdownProjection(markdown(latex)).split("\n").flatMap((line) =>
      line.match(/.{1,18}/gu) ?? [""]);
    expect(source.resolve(lines).formulas.map((f) => f.latex)).toEqual([latex]);
  });

  it("restores one-line displays and does not infer math from ordinary brackets", () => {
    const source = new FormulaSource(); source.addMarkdown(markdown(String.raw`D(p_S\|p_T)`));
    expect(source.resolve(["[ D(p_S|p_T) ]"]).formulas[0]?.latex).toBe(String.raw`D(p_S\|p_T)`);
    expect(source.resolve(["[ordinary note]"]).formulas).toEqual([]);
  });

  it("preloads only an explicitly resumed UUID, including read-only sessions", async () => {
    const id = "12345678-1234-1234-1234-123456789012";
    const date = join(root, "sessions", "2026", "09", "20");
    await mkdir(date, { recursive: true });
    const file = join(date, `rollout-date-${id}.jsonl`);
    await writeFile(file, "");
    expect(await findCodexResumeSource(["resume", id], join(root, "sessions"))).toBe(file);
    expect(await findCodexResumeSource(["resume", "--last"], join(root, "sessions"))).toBeUndefined();
    expect(await findCodexResumeSource([id], join(root, "sessions"))).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("discovers the rollout held by its own child without scanning other sessions", async () => {
    const path = join(root, "rollout-discovery.jsonl");
    await writeFile(path, "");
    const child = spawn(process.execPath, ["-e",
      "require('fs').openSync(process.argv[1], 'r'); process.stdout.write('ready'); setInterval(()=>{},1000)", path],
      { stdio: ["ignore", "pipe", "ignore"] });
    try {
      await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); });
      expect(await discoverCodexSession(child.pid!)).toBe(await realpath(path));
    } finally { child.kill(); }
  });

  it("refuses ambiguous projections instead of guessing mathematical symbols", () => {
    const source = new FormulaSource();
    const a = String.raw`x = a \; b`, b = "x = a ; b";
    expect(terminalMarkdownProjection(markdown(a))).toBe(terminalMarkdownProjection(markdown(b)));
    source.addMarkdown(`${markdown(a)}\n\n${markdown(b)}`);
    const resolved = source.resolve(terminalMarkdownProjection(markdown(a)).split("\n"));
    expect(resolved.formulas).toEqual([]);
    expect(resolved.ownedRows.size).toBeGreaterThan(0);
  });

  it("does not use nearest matches, code examples, or unfinished heading blocks", () => {
    const source = new FormulaSource(); source.addMarkdown(markdown(formulas[11]!));
    const other = terminalMarkdownProjection(markdown(formulas[10]!)).split("\n");
    expect(source.resolve(other).formulas).toEqual([]);
    const matching = terminalMarkdownProjection(markdown(formulas[11]!));
    expect(source.resolve(["```", ...matching.split("\n"), "```"]).formulas).toEqual([]);
    const incomplete = source.resolve(matching.split("\n").slice(0, -1));
    expect(incomplete.formulas).toEqual([]);
    expect(incomplete.ownedRows.size).toBeGreaterThan(0);
  });

  it("reads only assistant records and handles incremental UTF-8, truncation and malformed records", async () => {
    const path = join(root, "rollout-source.jsonl");
    const record = (role: string, text: string) => JSON.stringify({ type: "response_item", payload: {
      type: "message", role, content: [{ type: "output_text", text }] } }) + "\n";
    await writeFile(path, record("user", markdown("x=2")) + "invalid JSON\n");
    const source = new CodexFormulaSource({ path });
    await source.refresh(); expect(source.size).toBe(0);
    const bytes = Buffer.from(record("assistant", markdown(String.raw`x=\text{学生}`)));
    const split = bytes.indexOf(Buffer.from("学生")) + 1;
    await appendFile(path, bytes.subarray(0, split)); await source.refresh();
    expect(source.size).toBe(0);
    await appendFile(path, bytes.subarray(split)); expect(await source.refresh()).toBe(true);
    expect(source.size).toBe(1);
    expect(await source.refresh()).toBe(false);
    await writeFile(path, record("assistant", markdown("y=3")));
    await source.refresh(); expect(source.size).toBe(1);
    expect(source.resolve(["[", "y=3", "]"]).formulas[0]?.latex).toBe("y=3");
    source.close(); expect(await source.refresh()).toBe(false);
  });
});
