import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import plugin, { collectImageCandidates } from "../src/tui.js";

const selectionPath = join(tmpdir(), "tformula-opencode-image-selection.json");

afterEach(() => { rmSync(selectionPath, { force: true }); });

function mockApi() {
  let commandFactory: (() => Array<{ onSelect?: () => void; keybind?: string }>) | undefined;
  let dialogProps: { options: Array<{ title: string; value: string; description?: string }>; onSelect?: (option: any) => void } | undefined;
  const api = {
    route: { current: { name: "session", params: { sessionID: "session-1" } } },
    state: {
      session: { messages: () => [{ id: "message-1" }] },
      part: () => [
        { id: "part-file", messageID: "message-1", type: "file", mime: "image/png", url: "file:///tmp/from-file.png", source: { type: "file", path: "/tmp/from-file.png" } },
        { id: "part-text", messageID: "message-1", type: "text", text: "![diagram](/tmp/from-markdown.png)" }
      ]
    },
    command: { register: (factory: typeof commandFactory) => { commandFactory = factory; return () => undefined; } },
    keymap: {},
    ui: {
      DialogSelect: (props: typeof dialogProps) => { dialogProps = props; return null; },
      dialog: { replace: (render: () => unknown) => { render(); }, clear: () => undefined },
      toast: () => undefined
    },
    kv: { set: () => undefined },
    lifecycle: { onDispose: () => () => undefined }
  } as any;
  return { api, get commandFactory() { return commandFactory; }, get dialogProps() { return dialogProps; } };
}

describe("OpenCode TUI image board", () => {
  it("registers Ctrl-\\, lists current-session images, and writes the bridge record", async () => {
    const mock = mockApi();
    await plugin.tui(mock.api, undefined, {} as any);
    const commands = mock.commandFactory?.() ?? [];
    expect(commands[0]?.keybind).toBe("ctrl-\\");
    commands[0]?.onSelect?.();
    const props = mock.dialogProps!;
    expect(props.options.map((option) => option.value)).toEqual([
      "/tmp/from-markdown.png",
      "/tmp/from-file.png"
    ]);
    props.onSelect?.(props.options[0]);
    const record = JSON.parse(readFileSync(selectionPath, "utf8"));
    expect(record).toMatchObject({
      protocol: "tformula.image-selection.v1",
      sessionID: "session-1",
      path: "/tmp/from-markdown.png"
    });
  });

  it("deduplicates local file parts and Markdown references", () => {
    const mock = mockApi();
    const candidates = collectImageCandidates(mock.api, "session-1");
    expect(candidates).toHaveLength(2);
    expect(new Set(candidates.map((candidate) => candidate.path)).size).toBe(2);
  });
});
