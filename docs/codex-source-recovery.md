# Recovering Codex display formulas from their source

## Why terminal text alone is insufficient

A valid formula can be altered before TFormula sees the terminal screen:

```latex
\[
D_{\mathrm{KL}}(p_S\|p_T)
=
\sum_{v\in V} p_S(v)\log\frac{p_S(v)}{p_T(v)}
\]
```

CommonMark interprets the lone `=` as a setext heading underline and consumes
the escaping backslashes in `\[` and `\|`. Underscores in other formulas can
be consumed as emphasis delimiters. The screen can contain `# [` followed by
several independently detected fragments instead of a single complete formula.
Changing the equals-sign layout alone does not recover the missing symbols.

The source adapter restores authored TeX only when a complete terminal block
matches one unique source projection. It does not invent missing mathematical
operators or perform fuzzy/nearest-neighbor matching.

## Usage and session selection

```sh
tformula codex
tformula codex resume <session-UUID>
tformula --codex-session /path/to/rollout-session.jsonl codex resume <session-UUID>
tformula --no-codex-source codex
```

TFormula options precede the child command. Source recovery is enabled for
directly wrapped `codex`/`codex.js` commands, or when a source path is explicitly
supplied. Other agents and the standalone document reader keep their existing
behavior. A Codex command launched later inside `tformula --shell` is not
automatically attached by this adapter.

Selection proceeds as follows:

1. An explicit `--codex-session` path takes precedence and is loaded before
   spawning the child.
2. `codex resume <UUID>` searches **filenames** under `$CODEX_HOME/sessions`
   (default `~/.codex/sessions`) for that exact UUID. Only a unique match is
   loaded. This also handles resumed sessions that are read-only because
   another application owns them.
3. Otherwise, `ps` and `lsof` identify a rollout file held open by the wrapped
   child or its descendants. The nearest process is preferred over deeper
   subagents; equally near, conflicting paths are rejected.

There is no newest-file or working-directory heuristic that could silently
attach another conversation. Automatic process discovery needs `ps` and
`lsof`; explicit paths and UUID preloading do not need `lsof`.

## Source ingestion and matching

- Open the selected JSONL file read-only and incrementally consume complete
  `response_item` records whose payload is an assistant `message` and whose
  content part is `output_text`. User, tool and system records are ignored.
- Preserve partial UTF-8/JSON records between reads. File replacement or
  truncation resets the catalogue. Malformed and oversized records are skipped.
- Use the document reader's math-aware parser to extract display math, then
  index both the original delimiters and their CommonMark text projection.
- Normalize presentation whitespace and terminal gutters for matching while
  preserving mathematical punctuation and commands. Multiple different TeX
  sources with the same normalized projection are ambiguous and are not
  rendered through the source adapter.
- Map the recovered formula onto the existing logical/physical terminal rows.
  The source-backed region takes precedence over overlapping fragment
  detections. Existing canvas planning, image transport, resizing, history and
  source-cell masks still handle placement.

The reader consumes chunks of up to 256 KiB, limits JSON records to 8 MiB,
and limits the catalogue to 4,096 formulas of at most 20,000 characters each.
It polls for new records and also refreshes before processing a queued output
batch, so completed source data can be used before output checkpoints scroll
the matching block out of view.

No credentials, cloud API calls or writes to the Codex session are involved.
Restored formulas participate in the existing formula-history behavior;
`--no-history` still disables that history.

## Limits and fallback behavior

- Recovery currently targets display blocks, including one-line displays.
  Inline math retains the existing inference path.
- Codex must persist the original message before it can be used. A new live
  response may finish scrolling before its source is written. Recovery does
  not retroactively rewrite arbitrary terminal scrollback; resume/replay or
  the document reader can display the persisted answer again.
- CommonMark projection is a compatibility model, not a copy of every Codex
  TUI renderer. Unsupported transformations remain unmatched. Damaged heading
  blocks and ambiguous matched blocks are withheld from fragment inference.
- A source file is bound for the proxy's lifetime. Switching conversations
  inside the same child should use a fresh TFormula invocation.
- This change does not alter Ghostty configuration or solve image-mask color
  differences on translucent backgrounds. An opaque terminal background can
  avoid that separate visual issue.

## Regression coverage

`test/fixtures/opsd-formulas.json` contains 19 isolated formula examples covering
losses, nested expectations, forward/reverse KL, JSD, subscripts, escaped double
bars, gradients and Chinese text. The examples are derived from a reproduction
and generalized where needed; no session metadata or conversation log is
included.

The tests pass their Markdown projections through the terminal mirror, mapping,
MathJax and rasterization at 60, 100 and 160 columns, asserting that the renderer
receives the original TeX rather than a visually plausible fragment. Additional
tests cover hard wrapping, one-line displays, ambiguous projections, fenced
code, incomplete blocks, incremental UTF-8, log truncation, process discovery
and UUID-based preloading.
