import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin, { collectImageCandidates } from "../src/tui.js";

const selectionPath = join("/tmp/opencode", "tformula-plugin-test-selection.json");
afterEach(() => {
  delete process.env.TFORMULA_IMAGE_SELECTION_PATH;
  rmSync(selectionPath, { force: true });
});

const messages = [
  {
    id: "user-1", type: "user", text: "![diagram](/tmp/from-markdown.png)",
    files: [{ mime: "image/png", source: { type: "uri", uri: "file:///tmp/from-file.png" } }]
  },
  {
    id: "assistant-1", type: "assistant",
    content: [{ type: "text", text: "![same](/tmp/from-markdown.png)" }]
  }
] as any;

describe("OpenCode V2 TUI image board", () => {
  it("registers Ctrl-\\ and selects a current-session image", async () => {
    process.env.TFORMULA_IMAGE_SELECTION_PATH = selectionPath;
    let command: { bind: string; run: () => Promise<void> } | undefined;
    const select = vi.fn(async () => "/tmp/from-file.png");
    const context = {
      keymap: { layer: (factory: () => any) => { command = factory().commands[0]; } },
      data: {
        location: { default: () => ({ directory: "/tmp" }) },
        session: { message: { sync: async () => {}, list: () => messages } }
      },
      location: { directory: "/tmp" },
      ui: {
        router: { current: () => ({ type: "session", sessionID: "ses_test" }) },
        dialog: { select },
        toast: { show: vi.fn() }
      }
    } as any;
    await plugin.setup(context);
    expect(command?.bind).toBe("ctrl+\\");
    await command?.run();
    expect(select).toHaveBeenCalledWith(expect.objectContaining({
      title: "TFormula images",
      options: expect.arrayContaining([
        expect.objectContaining({ value: "/tmp/from-file.png" }),
        expect.objectContaining({ value: "/tmp/from-markdown.png" })
      ])
    }));
    expect(JSON.parse(readFileSync(selectionPath, "utf8"))).toMatchObject({
      protocol: "tformula.image-selection.v1",
      sessionID: "ses_test",
      path: "/tmp/from-file.png"
    });
  });

  it("deduplicates and rejects remote image references", () => {
    const candidates = collectImageCandidates([
      ...messages,
      { id: "user-2", type: "user", text: "![remote](https://example.org/x.png)" }
    ], "/tmp");
    expect(candidates.map((candidate) => candidate.path).sort()).toEqual([
      "/tmp/from-file.png", "/tmp/from-markdown.png"
    ]);
  });

  it("does not write a shared file when no TFormula wrapper is active", async () => {
    const select = vi.fn(async () => "/tmp/from-file.png");
    const toast = vi.fn();
    const { showImageBoard } = await import("../src/tui.js");
    await showImageBoard({
      location: { directory: "/tmp" },
      data: { session: { message: { sync: async () => {}, list: () => messages } } },
      ui: {
        router: { current: () => ({ type: "session", sessionID: "ses_test" }) },
        dialog: { select },
        toast: { show: toast }
      }
    } as any);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "warning" }));
    expect(() => readFileSync(selectionPath)).toThrow();
  });
});
