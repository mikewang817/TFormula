#!/usr/bin/env node
import process from "node:process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  inferFormulaExportFormat,
  normalizeFormulaExportFormat
} from "./formula-export-format.js";
import { probeTerminal } from "./probe.js";
import { looksLikeReaderPath } from "./reader-path.js";
import type {
  CliOptions,
  FormulaExportFormat,
  ReaderCliOptions,
  TFormulaOptions
} from "./types.js";

const { version: VERSION } = createRequire(import.meta.url)("../package.json") as { version: string };

const HELP = `TFormula ${VERSION}

Render LaTeX from terminal agents, or read Markdown, text, and image files.

Usage:
  tformula [options] [--] [command ...]
  tformula [options] <document.md|image>
  tformula --read <document>
  tformula --shell
  tformula history [--limit <count>] [--json]
  tformula copy [<id>] [latex|markdown|mathml|html|svg|png|tiff]
  tformula save [<id>] <path> [formula export options]
  tformula export [<id>|--last] [--format <format>] [-o <path>]

Examples:
  tformula codex
  tformula claude
  tformula -- gemini --model gemini-2.5-pro
  tformula --shell
  tformula README.md
  tformula assets/diagram.png
  tformula history
  tformula copy mathml
  tformula save formula.png
  tformula save 2f83a1 formula.svg --color navy --padding 12

Options:
  --shell                 Start the login shell (default when no command is given)
  --read <path>           Open a Markdown, text, or image file in the reader
  --no-math               Run only as a transparent PTY proxy
  --no-history            Do not persist successfully rendered formulas
  --scale <number>         Formula-to-terminal text scale, default 1.0
  --cell-size <WxH>        Override terminal cell pixels, for example 9x18
  -C, --cwd <directory>    Child or reader working directory
  --debug                  Print diagnostics
  -h, --help               Show help
  -V, --version            Show version

Formula export options:
  --format, --as <format>  latex, latex-inline, latex-display, markdown,
                           mathml, html, svg, png, or tiff
  --scale <number>         Visual output scale, from 0.25 to 16
  --color <color>          Formula color, default black
  --background <color>     Canvas color, default transparent
  --padding <pixels>       Canvas padding (PNG/TIFF default 16)

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

function parseHistoryArgs(argv: string[]): TFormulaOptions {
  let limit = 20;
  let json = false;
  let clear = false;
  let debug = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === "--limit") {
      limit = Number(argv[++index] ?? fail("history --limit requires a count"));
    } else if (value === "--json") json = true;
    else if (value === "--clear") clear = true;
    else if (value === "--debug") debug = true;
    else fail(`unknown history option ${value}`);
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    fail("history --limit must be an integer between 1 and 1000");
  }
  if (clear && json) fail("history --clear cannot be combined with --json");
  return { mode: "history", limit, json, clear, debug };
}

interface ParsedTransferArgs {
  selectorIsLast: boolean;
  format?: FormulaExportFormat;
  output?: string;
  positionals: string[];
  debug: boolean;
  scale?: number;
  color?: string;
  background?: string;
  padding?: number;
}

function parseTransferArgs(
  argv: string[],
  command: "copy" | "export" | "save",
  allowOutput: boolean
): ParsedTransferArgs {
  let selectorIsLast = false;
  let format: FormulaExportFormat | undefined;
  let output: string | undefined;
  const positionals: string[] = [];
  let debug = false;
  let scale: number | undefined;
  let color: string | undefined;
  let background: string | undefined;
  let padding: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (value === "--last") {
      if (selectorIsLast) fail(`${command} accepts --last only once`);
      selectorIsLast = true;
    } else if (value === "--format" || value === "--as") {
      if (format) fail(`${command} accepts only one export format`);
      const candidate = argv[++index] ?? fail(`${command} ${value} requires a format`);
      format = normalizeFormulaExportFormat(candidate)
        ?? fail(`unsupported formula export format: ${candidate}`);
    } else if (allowOutput && (value === "-o" || value === "--output")) {
      if (output) fail(`${command} accepts only one output path`);
      output = argv[++index] ?? fail(`${value} requires a file path`);
    } else if (value === "--scale") {
      scale = Number(argv[++index] ?? fail(`${command} --scale requires a number`));
    } else if (value === "--color") {
      color = argv[++index] ?? fail(`${command} --color requires a CSS color`);
    } else if (value === "--background") {
      background = argv[++index] ?? fail(`${command} --background requires a CSS color`);
    } else if (value === "--padding") {
      padding = Number(argv[++index] ?? fail(`${command} --padding requires a pixel count`));
    } else if (value === "--debug") debug = true;
    else if (value === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    } else if (!value.startsWith("-")) positionals.push(value);
    else fail(`unknown ${command} option ${value}`);
  }
  if (scale !== undefined && (!Number.isFinite(scale) || scale < 0.25 || scale > 16)) {
    fail(`${command} --scale must be between 0.25 and 16`);
  }
  if (padding !== undefined
    && (!Number.isSafeInteger(padding) || padding < 0 || padding > 512)) {
    fail(`${command} --padding must be an integer between 0 and 512`);
  }
  return {
    selectorIsLast,
    format,
    output,
    positionals,
    debug,
    scale,
    color,
    background,
    padding
  };
}

function visualTransferOptions(parsed: ParsedTransferArgs): Pick<
  ParsedTransferArgs,
  "scale" | "color" | "background" | "padding"
> {
  return {
    ...(parsed.scale === undefined ? {} : { scale: parsed.scale }),
    ...(parsed.color === undefined ? {} : { color: parsed.color }),
    ...(parsed.background === undefined ? {} : { background: parsed.background }),
    ...(parsed.padding === undefined ? {} : { padding: parsed.padding })
  };
}

function parseExportArgs(argv: string[], save = false): TFormulaOptions {
  const command = save ? "save" : "export";
  const parsed = parseTransferArgs(argv, command, true);
  let selector = parsed.selectorIsLast ? "last" : undefined;
  let output = parsed.output;

  if (save) {
    if (output) {
      if (parsed.positionals.length > 1) fail("save accepts at most one formula selector");
      if (parsed.positionals.length === 1) {
        if (selector) fail("save accepts only one formula selector");
        selector = parsed.positionals[0];
      }
    } else if (parsed.positionals.length === 1) {
      output = parsed.positionals[0];
    } else if (parsed.positionals.length === 2) {
      if (selector) fail("save accepts only one formula selector");
      [selector, output] = parsed.positionals;
    } else if (parsed.positionals.length === 0) {
      fail("save requires an output path");
    } else {
      fail("save accepts [formula-id] <output-path>");
    }
  } else {
    if (parsed.positionals.length > 1) fail("export accepts only one formula selector");
    if (parsed.positionals.length === 1) {
      if (selector) fail("export accepts only one formula selector");
      selector = parsed.positionals[0];
    }
  }

  const inferred = output ? inferFormulaExportFormat(output) : undefined;
  const format = parsed.format ?? inferred ?? (save
    ? fail("cannot infer an export format from the output path; use --as <format>")
    : "latex");
  return {
    mode: "export",
    selector: selector ?? "last",
    format,
    ...(output ? { output } : {}),
    cwd: process.cwd(),
    debug: parsed.debug,
    ...visualTransferOptions(parsed)
  };
}

function parseCopyArgs(argv: string[]): TFormulaOptions {
  const parsed = parseTransferArgs(argv, "copy", false);
  let selector = parsed.selectorIsLast ? "last" : undefined;
  let format = parsed.format;
  if (parsed.positionals.length === 1) {
    const positionalFormat = normalizeFormulaExportFormat(parsed.positionals[0]!);
    if (positionalFormat) {
      if (format) fail("copy accepts only one export format");
      format = positionalFormat;
    } else {
      if (selector) fail("copy accepts only one formula selector");
      selector = parsed.positionals[0];
    }
  } else if (parsed.positionals.length === 2) {
    if (selector) fail("copy accepts only one formula selector");
    if (format) fail("copy accepts only one export format");
    selector = parsed.positionals[0];
    format = normalizeFormulaExportFormat(parsed.positionals[1]!)
      ?? fail(`unsupported formula export format: ${parsed.positionals[1]}`);
  } else if (parsed.positionals.length > 2) {
    fail("copy accepts [formula-id] [format]");
  }
  return {
    mode: "copy",
    selector: selector ?? "last",
    format: format ?? "latex",
    debug: parsed.debug,
    ...visualTransferOptions(parsed)
  };
}

export function parseArgs(argv: string[]): TFormulaOptions | "help" | "version" {
  if (argv[0] === "history") return parseHistoryArgs(argv.slice(1));
  if (argv[0] === "export") return parseExportArgs(argv.slice(1));
  if (argv[0] === "save") return parseExportArgs(argv.slice(1), true);
  if (argv[0] === "copy") return parseCopyArgs(argv.slice(1));
  let cwd = process.cwd();
  let renderMath = true;
  let recordHistory = true;
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
    else if (value === "--no-history") recordHistory = false;
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
  return {
    mode: "proxy",
    command,
    args,
    cwd,
    renderMath,
    recordHistory,
    debug,
    scale,
    cellOverride
  };
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

  if (parsed.mode === "history" || parsed.mode === "export" || parsed.mode === "copy") {
    const debug = (message: string): void => {
      if (parsed.debug) process.stderr.write(`[tformula] ${message}\n`);
    };
    if (parsed.mode === "history") {
      const history = await import("./formula-history.js");
      process.exitCode = await history.runHistoryCommand(parsed, debug);
    } else {
      const exporter = await import("./formula-export.js");
      process.exitCode = parsed.mode === "export"
        ? await exporter.runExportCommand(parsed, debug)
        : await exporter.runCopyCommand(parsed, debug);
    }
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

  const probe = probeTerminal(parsed.cellOverride, parsed.mode === "reader" ? 80 : 180);
  let exitCode: number;
  if (parsed.mode === "reader") {
    const readerModule = import("./reader.js");
    const document = readerModule.then(({ preloadReaderDocument }) =>
      preloadReaderDocument(parsed));
    const [probeResult, reader, preloaded] = await Promise.all([probe, readerModule, document]);
    exitCode = await reader.runReader(
      parsed,
      probeResult.capabilities,
      probeResult.pendingInput,
      probeResult.startupProbePending,
      preloaded
    );
  } else {
    const [probeResult, { runProxy }] = await Promise.all([probe, import("./proxy.js")]);
    exitCode = await runProxy(
      parsed,
      probeResult.capabilities,
      probeResult.pendingInput,
      probeResult.startupProbePending
    );
  }
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
