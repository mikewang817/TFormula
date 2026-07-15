#!/usr/bin/env node
import process from "node:process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { probeTerminal } from "./probe.js";
import { looksLikeReaderPath } from "./reader-path.js";
import type { CliOptions, ReaderCliOptions, TFormulaOptions } from "./types.js";

const { version: VERSION } = createRequire(import.meta.url)("../package.json") as { version: string };

const HELP = `TFormula ${VERSION}

Render LaTeX from terminal agents, or read Markdown, text, and image files.

Usage:
  tformula [options] [--] [command ...]
  tformula [options] <document.md|image>
  tformula --read <document>
  tformula --shell

Examples:
  tformula codex
  tformula claude
  tformula -- gemini --model gemini-2.5-pro
  tformula --shell
  tformula README.md
  tformula assets/diagram.png

Options:
  --shell                 Start the login shell (default when no command is given)
  --read <path>           Open a Markdown, text, or image file in the reader
  --no-math               Run only as a transparent PTY proxy
  --scale <number>         Formula-to-terminal text scale, default 1.0
  --cell-size <WxH>        Override terminal cell pixels, for example 9x18
  -C, --cwd <directory>    Child or reader working directory
  --debug                  Print diagnostics
  -h, --help               Show help
  -V, --version            Show version

TFormula queries the terminal's actual cell pixel size. Formulas keep their
natural MathJax proportions and are only reduced when they do not fit.
`;

function fail(message: string): never {
  process.stderr.write(`tformula: ${message}\n`);
  process.exit(2);
}

export function isTFormulaActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TFORMULA_ACTIVE === "1";
}

export function parseArgs(argv: string[]): TFormulaOptions | "help" | "version" {
  let cwd = process.cwd();
  let renderMath = true;
  let debug = false;
  let scale = Number(process.env.TFORMULA_SCALE ?? "1");
  let cellOverride: CliOptions["cellOverride"];
  let forceShell = false;
  let readerPath: string | undefined;
  let commandSeparator = false;
  const commandParts: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === "--") {
      commandSeparator = true;
      commandParts.push(...argv.slice(index + 1));
      break;
    }
    if (commandParts.length > 0 || !value.startsWith("-")) {
      commandParts.push(value);
      continue;
    }
    if (value === "-h" || value === "--help") return "help";
    if (value === "-V" || value === "--version") return "version";
    if (value === "--shell") forceShell = true;
    else if (value === "--read") readerPath = argv[++index] ?? fail("--read requires a file path");
    else if (value === "--no-math") renderMath = false;
    else if (value === "--debug") debug = true;
    else if (value === "--scale") scale = Number(argv[++index]);
    else if (value === "-C" || value === "--cwd") cwd = argv[++index] ?? fail(`${value} requires a directory`);
    else if (value === "--cell-size") {
      const raw = argv[++index] ?? fail("--cell-size requires WIDTHxHEIGHT");
      const match = raw.match(/^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/u);
      if (!match) fail("--cell-size must look like 9x18");
      cellOverride = { width: Number(match[1]), height: Number(match[2]) };
    } else fail(`unknown option ${value}`);
  }

  if (!Number.isFinite(scale) || scale < 0.5 || scale > 2) fail("--scale must be between 0.5 and 2");
  if (forceShell && commandParts.length > 0) fail("--shell cannot be combined with a command");
  if (readerPath && (forceShell || commandParts.length > 0)) {
    fail("--read cannot be combined with --shell or a command");
  }
  const implicitReaderPath = !commandSeparator && !forceShell && commandParts.length === 1
    && looksLikeReaderPath(commandParts[0]!)
    ? commandParts[0]
    : undefined;
  if (readerPath || implicitReaderPath) {
    const reader: ReaderCliOptions = {
      mode: "reader",
      path: readerPath ?? implicitReaderPath!,
      cwd,
      debug,
      scale,
      cellOverride
    };
    return reader;
  }
  const shell = process.env.SHELL || "/bin/zsh";
  const command = forceShell || commandParts.length === 0 ? shell : commandParts[0]!;
  const args = forceShell || commandParts.length === 0 ? ["-l"] : commandParts.slice(1);
  return { mode: "proxy", command, args, cwd, renderMath, debug, scale, cellOverride };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (parsed === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  // Every TFormula layer owns the same terminal, image-id range, and screen
  // mirror. Nesting two proxies makes them overwrite and delete each other's
  // images, and an older outer layer can expose direct-transfer Base64 as
  // ordinary text. Help/version remain available inside a managed shell, but
  // starting a second proxy must fail before probing or spawning a PTY.
  if (isTFormulaActive()) {
    process.stderr.write(
      "tformula: TFormula is already active; run the agent command directly inside the existing session\n"
    );
    process.exitCode = 2;
    return;
  }

  const { capabilities, pendingInput, startupProbePending } = await probeTerminal(
    parsed.cellOverride
  );
  const exitCode = parsed.mode === "reader"
    ? await import("./reader.js").then(({ runReader }) =>
        runReader(parsed, capabilities, pendingInput, startupProbePending))
    : await import("./proxy.js").then(({ runProxy }) =>
        runProxy(parsed, capabilities, pendingInput, startupProbePending));
  process.exitCode = exitCode;
}

let invokedDirectly = false;
if (process.argv[1]) {
  try {
    // npm link invokes this file through a symlink in the global bin folder.
    invokedDirectly = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    invokedDirectly = false;
  }
}

if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`tformula: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
