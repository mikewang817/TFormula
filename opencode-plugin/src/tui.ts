import { renameSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionMessageInfo } from "@opencode/client";
import { Plugin } from "@opencode/plugin/tui";
import type { Context } from "@opencode/plugin/tui/plugin";

export interface TFormulaImageSelection {
  protocol: "tformula.image-selection.v1";
  sessionID: string;
  path: string;
  partID?: string;
  messageID?: string;
  selectedAt: number;
}

type ImageCandidate = { path: string; title: string; description: string; messageID: string };
const MARKDOWN_IMAGE = /!\[[^\]\r\n]*\]\((?:<([^<>\r\n]+)>|([^()\r\n]+))\)/gu;
const IMAGE_SUFFIX = /\.(?:png|jpe?g|gif|webp|bmp|avif|tiff?)$/iu;

function localImagePath(value: string, directory: string): string | undefined {
  try {
    if (/^file:/iu.test(value)) {
      const path = fileURLToPath(value);
      return IMAGE_SUFFIX.test(path) ? path : undefined;
    }
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(value)) return undefined;
    const path = decodeURIComponent(value.replace(/\\([ ()])/gu, "$1"));
    if (!IMAGE_SUFFIX.test(path)) return undefined;
    return isAbsolute(path) ? path : resolve(directory, path);
  } catch {
    return undefined;
  }
}

export function collectImageCandidates(
  messages: readonly SessionMessageInfo[],
  directory: string
): ImageCandidate[] {
  const seen = new Set<string>();
  const result: ImageCandidate[] = [];
  const add = (value: string, messageID: string): void => {
    const path = localImagePath(value, directory);
    if (!path || seen.has(path)) return;
    seen.add(path);
    result.push({ path, title: basename(path), description: path, messageID });
  };
  const scanText = (text: string, id: string): void => {
    for (const match of text.matchAll(MARKDOWN_IMAGE)) add(match[1] ?? match[2] ?? "", id);
  };
  for (const message of messages) {
    if (message.type === "user") {
      scanText(message.text, message.id);
      for (const file of message.files ?? []) {
        if (file.mime.startsWith("image/") && file.source.type === "uri") {
          add(file.source.uri, message.id);
        }
      }
    }
    if (message.type !== "assistant") continue;
    for (const content of message.content) {
      if (content.type === "text") scanText(content.text, message.id);
      if (content.type !== "tool" || content.state.status !== "completed") continue;
      for (const item of content.state.content) {
        if (item.type === "text") scanText(item.text, message.id);
        if (item.type === "file" && item.mime.startsWith("image/")) add(item.uri, message.id);
      }
    }
  }
  return result.reverse();
}

function writeSelection(selection: TFormulaImageSelection): void {
  const path = process.env.TFORMULA_IMAGE_SELECTION_PATH;
  if (!path || !isAbsolute(path)) return;
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(selection)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export async function showImageBoard(context: Context): Promise<void> {
  const route = context.ui.router.current();
  if (route.type !== "session") {
    context.ui.toast.show({ message: "Image selection is available inside a session", variant: "warning" });
    return;
  }
  await context.data.session.message.sync(route.sessionID);
  const candidates = collectImageCandidates(
    context.data.session.message.list(route.sessionID),
    context.location?.directory ?? context.data.location.default().directory
  );
  if (!candidates.length) {
    context.ui.toast.show({ message: "No local images in this conversation", variant: "warning" });
    return;
  }
  const path = await context.ui.dialog.select({
    title: "TFormula images",
    options: [
      ...candidates.map((candidate) => ({
        title: candidate.title,
        value: candidate.path,
        description: candidate.description
      })),
      {
        title: "Close",
        value: "",
        description: "Return to the conversation without selecting an image"
      }
    ]
  });
  const candidate = candidates.find((item) => item.path === path);
  if (!candidate) return;
  if (!process.env.TFORMULA_IMAGE_SELECTION_PATH) {
    context.ui.toast.show({ message: "Launch OpenCode through TFormula to preview images", variant: "warning" });
    return;
  }
  writeSelection({
    protocol: "tformula.image-selection.v1",
    sessionID: route.sessionID,
    path: candidate.path,
    messageID: candidate.messageID,
    selectedAt: Date.now()
  });
}

export default Plugin.define({
  id: "tformula-opencode",
  setup(context) {
    context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "tformula.image-board",
        title: "Choose conversation image",
        group: "TFormula",
        bind: "ctrl+\\",
        palette: true,
        slash: { name: "tformula-images" },
        run: () => showImageBoard(context)
      }],
      bindings: ["tformula.image-board"]
    }));
  }
});
