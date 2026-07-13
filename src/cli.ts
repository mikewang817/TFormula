#!/usr/bin/env node
import process from "node:process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { probeTerminal } from "./probe.js";
import { runProxy } from "./proxy.js";
import type { CliOptions } from "./types.js";

const { version: VERSION } = createRequire(import.meta.url)("../package.json") as { version: string };

const HELP = `TFormula ${VERSION}

Render LaTeX produced by any terminal agent while preserving the original TUI.

Usage:
  tformula [options] [--] [command ...]
  tformula --shell

Examples:
  tformula codex
  tformula claude
  tformula -- gemini --model gemini-2.5-pro
  tformula --shell

Options:
  --shell                 Start the login shell (default when no command is given)
  --no-math               Run only as a transparent PTY proxy
  --scale <number>         Formula-to-terminal text scale, default 1.0
  --cell-size <WxH>        Override terminal cell pixels, for example 9x18
  -C, --cwd <directory>    Child working directory
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

export function parseArgs(argv: string[]): CliOptions | "help" | "version" {
  let cwd = process.cwd();
  let renderMath = true;
  let debug = false;
  let scale = Number(process.env.TFORMULA_SCALE ?? "1");
  let cellOverride: CliOptions["cellOverride"];
  let forceShell = false;
  const commandParts: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === "--") {
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
  const shell = process.env.SHELL || "/bin/zsh";
  const command = forceShell || commandParts.length === 0 ? shell : commandParts[0]!;
  const args = forceShell || commandParts.length === 0 ? ["-l"] : commandParts.slice(1);
  return { command, args, cwd, renderMath, debug, scale, cellOverride };
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

  const { capabilities, pendingInput } = await probeTerminal(parsed.cellOverride);
  const exitCode = await runProxy(parsed, capabilities, pendingInput);
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
