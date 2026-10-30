import type { FilePart, Part } from "@opencode-ai/sdk/v2";
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui";
import { renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TFormulaImageSelection {
  protocol: "tformula.image-selection.v1";
  sessionID: string;
  path: string;
  partID?: string;
  messageID?: string;
  selectedAt: number;
}

type ImageCandidate = {
  path: string;
  title: string;
  description: string;
  partID?: string;
  messageID?: string;
};

const MARKDOWN_IMAGE = /!\[[^\]\r\n]*\]\((?:<([^<>\r\n]+)>|([^()\r\n]+))\)/gu;

function localPathFromPart(part: Part): string | undefined {
  if (part.type !== "file") return undefined;
  const file = part as FilePart;
  if (file.source?.type === "file") return file.source.path;
  if (file.url.startsWith("file://")) {
    try { return decodeURIComponent(new URL(file.url).pathname); } catch { return undefined; }
  }
  return undefined;
}

export function collectImageCandidates(api: TuiPluginApi, sessionID: string): readonly ImageCandidate[] {
  const candidates: ImageCandidate[] = [];
  const seen = new Set<string>();
  for (const message of api.state.session.messages(sessionID)) {
    for (const part of api.state.part(message.id)) {
      const path = localPathFromPart(part);
      if (path && !seen.has(path)) {
        seen.add(path);
        candidates.push({
          path,
          title: path.split("/").pop() || path,
          description: path,
          partID: part.id,
          messageID: part.messageID
        });
      }
      if (part.type !== "text") continue;
      for (const match of part.text.matchAll(MARKDOWN_IMAGE)) {
        const path = match[1] ?? match[2];
        if (!path || /^(?:https?:|data:|\/\/)/iu.test(path) || seen.has(path)) continue;
        seen.add(path);
        candidates.push({ path, title: path.split("/").pop() || path, description: path });
      }
    }
  }
  return candidates.reverse();
}

function sessionID(api: TuiPluginApi): string | undefined {
  const route = api.route.current;
  return route.name === "session" && typeof route.params?.sessionID === "string"
    ? route.params.sessionID
    : undefined;
}

async function showImageBoard(api: TuiPluginApi): Promise<void> {
  const currentSession = sessionID(api);
  if (!currentSession) {
    api.ui.toast({ message: "Image selection is available inside a session", variant: "warning" });
    return;
  }
  const candidates = collectImageCandidates(api, currentSession);
  if (candidates.length === 0) {
    api.ui.toast({ message: "No local images in this conversation", variant: "warning" });
    return;
  }
  api.ui.dialog.replace(() => api.ui.DialogSelect({
    title: "TFormula images",
    placeholder: "Select an image",
    options: candidates.map((candidate) => ({
      title: candidate.title,
      value: candidate.path,
      description: candidate.description
    })),
    onSelect: (option) => {
      const candidate = candidates.find((item) => item.path === option.value);
      if (!candidate) return;
      const selection: TFormulaImageSelection = {
        protocol: "tformula.image-selection.v1",
        sessionID: currentSession,
        path: candidate.path,
        partID: candidate.partID,
        messageID: candidate.messageID,
        selectedAt: Date.now()
      };
      // The plugin is deliberately transport-neutral. The TFormula wrapper can
      // consume this event through the documented bridge without owning the
      // OpenCode TUI renderer or duplicating Kitty placement state.
      api.kv.set("tformula.last-image-selection", selection);
      const selectionPath = join(tmpdir(), "tformula-opencode-image-selection.json");
      const temporaryPath = `${selectionPath}.${process.pid}.tmp`;
      writeFileSync(temporaryPath, `${JSON.stringify(selection)}\n`, { mode: 0o600 });
      renameSync(temporaryPath, selectionPath);
      api.ui.dialog.clear();
      api.ui.toast({ message: `Selected ${candidate.title}`, variant: "success" });
    }
  }));
}

export const id = "tformula-opencode";

export const tui: TuiPlugin = async (api) => {
  const command = {
    title: "TFormula: choose conversation image",
    id: "tformula.image-board",
    category: "TFormula",
    bind: "ctrl-\\",
    palette: true,
    slash: { name: "tformula-images", aliases: ["images"] },
    run: () => { void showImageBoard(api); }
  };
  const keymap = api.keymap as typeof api.keymap & {
    registerLayer?: (layer: { mode?: string; commands: typeof command[]; bindings?: string[] }) => () => void;
  };
  let unregister: (() => void) | undefined;
  if (typeof keymap.registerLayer === "function") {
    unregister = keymap.registerLayer({
      mode: "global",
      commands: [command],
      bindings: [command.id]
    });
  } else if (api.command?.register) {
    // Compatibility with older local plugin runtimes.
    unregister = api.command.register(() => [{
      title: command.title,
      value: command.id,
      category: command.category,
      keybind: command.bind,
      slash: command.slash,
      onSelect: command.run
    }]);
  }
  api.lifecycle?.onDispose?.(() => unregister?.());
};

// The v2 TUI module contract is an object containing the plugin id and setup
// function. OpenCode's local loader uses this shape for both package exports
// and direct local plugin directories.
export default { id, tui };
