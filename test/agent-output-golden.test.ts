import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Terminal as XtermTerminal } from "@xterm/headless";
import { describe, expect, it } from "vitest";
import { planFormulaPlacements } from "../src/formula-layout.js";
import { detectScreenFormulaRegions } from "../src/screen-text.js";

const { Terminal } = createRequire(import.meta.url)("@xterm/headless") as {
  Terminal: typeof XtermTerminal;
};
const fixtureRoot = join(process.cwd(), "test", "fixtures", "agent-output");

interface AgentFixture {
  version: number;
  id: string;
  agent: string;
  provenance: { kind: "captured" | "session-derived"; note: string };
  geometry: { columns: number; rows: number };
  ansi: string;
  expected: unknown;
}

async function capturedFixtures(): Promise<AgentFixture[]> {
  const names = (await readdir(fixtureRoot))
    .filter((name) => name.endsWith(".json") && !name.endsWith(".pending.json"))
    .sort();
  return Promise.all(names.map(async (name) =>
    JSON.parse(await readFile(join(fixtureRoot, name), "utf8")) as AgentFixture
  ));
}

async function actualGolden(fixture: AgentFixture) {
  const terminal = new Terminal({
    cols: fixture.geometry.columns,
    rows: fixture.geometry.rows,
    allowProposedApi: true
  });
  try {
    await new Promise<void>((resolve) => terminal.write(fixture.ansi, resolve));
    const buffer = terminal.buffer.active;
    const physicalLines = Array.from({ length: terminal.rows }, (_, row) => {
      const line = buffer.getLine(buffer.viewportY + row);
      return {
        row,
        text: line?.translateToString(true) ?? "",
        isWrapped: line?.isWrapped ?? false
      };
    });
    const snapshot = detectScreenFormulaRegions(physicalLines, terminal.cols);
    const plans = planFormulaPlacements(snapshot.formulas, physicalLines, terminal.cols);
    return {
      cells: physicalLines,
      formulas: snapshot.formulas,
      plans,
      kitty: plans.map((plan) => ({
        row: plan.canvas.startRow + 1,
        column: plan.canvas.startCol + 1,
        columns: plan.canvas.endCol - plan.canvas.startCol,
        rows: plan.canvas.endRow - plan.canvas.startRow + 1
      }))
    };
  } finally {
    terminal.dispose();
  }
}

describe("captured Agent terminal-cell golden corpus", () => {
  it("contains only auditable captured/session-derived fixtures", async () => {
    const fixtures = await capturedFixtures();
    expect(fixtures.length).toBeGreaterThanOrEqual(2);
    expect(new Set(fixtures.map(({ agent }) => agent))).toEqual(new Set(["codex", "pi"]));
    for (const fixture of fixtures) {
      expect(fixture.version).toBe(1);
      expect(["captured", "session-derived"]).toContain(fixture.provenance.kind);
      expect(fixture.provenance.note.length).toBeGreaterThan(20);
      expect(fixture.ansi).not.toMatch(/(?:api[_-]?key|bearer\s+[a-z0-9]|\/Users\/|session[_-]?id)/iu);
    }
  });

  it("matches terminal cells, semantic mapping, plans, and Kitty geometry", async () => {
    for (const fixture of await capturedFixtures()) {
      expect(await actualGolden(fixture), fixture.id).toEqual(fixture.expected);
    }
  });

  it("keeps missing real Agent captures explicit rather than treating samples as evidence", async () => {
    const pending = (await readdir(fixtureRoot)).filter((name) => name.endsWith(".pending.json"));
    expect(pending.sort()).toEqual(["claude.pending.json", "gemini.pending.json"]);
  });
});
