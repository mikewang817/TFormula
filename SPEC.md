# TFormula — Local Engineering Specification

**Repository:** `tformula`  
**Package version:** `0.2.1`  
**Runtime:** Node.js 20+ on macOS and Linux  
**Language:** TypeScript (ESM, strict)  
**Purpose:** Render scientific LaTeX in compatible terminals while preserving
the behavior and copyable text of a wrapped CLI program. It also provides a
full-screen local Markdown/text/image reader.

> This is a local working specification. It is deliberately ignored by Git;
> keep the public user-facing documentation in `README.md` and
> `README.zh-CN.md` in sync when behavior changes.

## Product boundary

TFormula is terminal- and agent-agnostic. It does not call an agent API or
depend on an agent-specific plugin. The main workflow wraps any CLI program in
a pseudo-terminal (PTY):

```text
user terminal ── stdin/stdout ── TFormula proxy ── PTY ── child CLI agent
                                      │
                                      ├─ headless xterm screen mirror
                                      ├─ TeX detection and layout planning
                                      ├─ MathJax → SVG → PNG rendering
                                      └─ Kitty graphics overlays
```

The child continues to see a normal terminal. TFormula preserves its ANSI text
output and puts Kitty images over detected source cells; the original TeX stays
in the terminal buffer for copying. When Kitty graphics are unavailable or a
formula cannot be rendered/readably placed, the raw TeX remains visible.

The second workflow is a reader:

```text
local document → Markdown AST/resources → responsive reader layout
               → ANSI text + Kitty formula/image placements → alternate screen
```

No remote document or image fetching is performed by the reader.

## User-facing commands

`src/cli.ts` is the executable entry point and dispatches the following modes:

| Mode | Example | Runtime owner |
|---|---|---|
| PTY proxy | `tformula codex`, `tformula -- <command>` | `runProxy()` in `src/proxy.ts` |
| Login shell | `tformula` or `tformula --shell` | PTY proxy |
| Document reader | `tformula README.md`, `tformula --read notes.txt` | `runReader()` in `src/reader.ts` |
| Formula history | `tformula history --json` | `src/formula-history.ts` |
| Clipboard export | `tformula copy mathml` | `src/formula-export.ts` |
| File export | `tformula save formula.png` / `tformula export --last --format html` | `src/formula-export.ts` |

The proxy supports normal agents such as Codex, Claude Code, Gemini CLI, and
any arbitrary command. It refuses nested TFormula proxy sessions through the
`TFORMULA_ACTIVE` guard because nested instances would compete for image IDs,
screen state, and graphics placements.

## Core architecture

### 1. CLI, probes, and terminal transport

- `src/cli.ts` parses options, starts terminal capability probing, and lazy-loads
  the chosen runtime. Reader document loading and probing run concurrently.
- `src/probe.ts` queries Kitty graphics support, terminal colours, cell pixel
  size, and window dimensions. It quarantines probe replies so they do not leak
  into the child process.
- `src/terminal-responses.ts` filters TFormula-owned Kitty responses from user
  input before forwarding the rest to the PTY or reader.
- `src/terminal-writer.ts` serializes writes to stdout, including generated
  graphics output, to preserve byte ordering.
- `src/terminal-output.ts` gates and transforms terminal control output and can
  hold cells during graphics-sensitive output transitions.
- `src/output-checkpoints.ts` splits long child output into scan checkpoints so
  stable formulas can be rendered before the next large output burst.

### 2. PTY proxy and screen mirror

`src/proxy.ts` owns the PTY lifecycle, raw terminal mode, resize propagation,
child stdout/input routing, delayed capability changes, focus-key routing, and
formula-history recording. It initializes a `FormulaScreen` only when math
rendering is enabled.

`src/screen.ts` is the central stateful rendering controller. It mirrors child
output with `@xterm/headless`, scans the mirror after a stability delay, tracks
logical formula placements across scrolling and resizing, and emits image
deletion/replacement sequences. It maintains a bounded terminal image set and
the recent-formula registry used by the focus overlay.

The screen module contains deliberate compatibility checks around private
xterm data used to reproduce ANSI rendition safely. Treat xterm upgrades as a
high-risk change: run the full terminal protocol and pseudo-terminal suites.

### 3. Formula pipeline

The formula model is intentionally split into three layers:

```text
terminal text
  → DetectedFormula          semantic TeX and intent only
  → MappedFormula            exact physical source-cell mapping
  → FormulaPlacementPlan     independent visual canvas/layout decision
  → RenderedFormula          terminal-ready PNG and pixel geometry
  → Kitty placement
```

- `src/detect.ts` recognizes only explicitly delimited TeX and complete
  supported display environments; classifies it as `inline`, `display`, or
  `embedded-display`; and emits semantic `DetectedFormula` objects.
- `src/screen-text.ts` reconstructs logical terminal lines across soft wraps
  and maps formulas precisely onto physical terminal cells.
- `src/formula-layout.ts` selects source, embedded, wrapped, compact, or
  borrowed blank-row canvases. Blank rows can be borrowed above, below, or on
  both sides only when safe.
- `src/math-renderer.ts` uses MathJax and `@resvg/resvg-js` to produce SVG and
  PNG. It calculates fit scale, source masks, natural geometry, readability
  fallback, and cached variants.
- `src/geometry.ts` holds terminal-cell and inline-quantization calculations.
- `src/kitty.ts` generates Kitty Graphics Protocol transmit/place/delete
  sequences, source rectangles, z-index settings, cursor movement, and
  synchronized-output wrappers.
- `src/image-transmitter.ts` chooses direct or temporary-file image transfer;
  Ghostty-specific behavior is handled here.
- `src/formula-focus.ts` parses the configured focus-key state machine. The
  actual focus overlay is managed by `FormulaScreen`.

Canonical shared types live in `src/types.ts`. Preserve the semantic → mapped
→ layout-plan boundary; detection must not choose a visual canvas and renderer
code must not reconstruct terminal source semantics.

### 4. Rendering, cache, history, and export

- `src/formula-cache.ts` provides content-addressed cache entries with a shared
  cache instance for terminal rendering.
- `src/formula-history.ts` stores rendered formula metadata and source in a
  user-local history directory with restrictive permissions. A session records
  each identical formula once.
- `src/formula-export-format.ts` normalizes export names and infers formats
  from output extensions.
- `src/formula-export.ts` exports raw/delimited LaTeX, Markdown, MathML, HTML,
  SVG, PNG, and TIFF; it also implements clipboard copy with platform tools.
- `src/sharp-loader.ts` lazy-loads `sharp` so image support does not increase
  the startup cost of every proxy session.

### 5. Reader pipeline

The reader is an alternate-screen interactive application, not a proxy.

- `src/reader-path.ts` recognizes reader file kinds and prevents document paths
  from being mistaken for child commands.
- `src/reader-document.ts` reads local documents, normalizes malformed
  PDF/OCR-oriented math delimiters, parses Markdown with GFM and math support,
  and collects local image/math resources.
- `src/reader-layout.ts` converts the document tree into reflowable terminal
  lines, headings, links, styled spans, formula placements, and image
  placements. It handles tables, nested lists, code, quotes, CJK widths, and
  responsive image geometry.
- `src/reader-image-cache.ts` normalizes images and formula assets into
  cacheable terminal-ready PNGs.
- `src/reader-watch.ts` watches the open document and referenced local images,
  debouncing atomic-save event bursts.
- `src/reader.ts` owns interaction, navigation, search, source/render toggle,
  table of contents, zoom, link navigation, live reload, viewport anchoring,
  clipping of large images, and LRU terminal-image eviction.

Reader reload must preserve a semantic viewport anchor where possible. It must
not automatically open HTTP links, load remote images, or emit graphics when
the terminal is not interactive/Kitty-capable.

## Terminal and safety invariants

1. **Text first:** child output must remain valid terminal text and source TeX
   must remain copyable under any rendering failure.
2. **Graphics are optional:** Kitty graphics failure, missing capability, or
   unreadable fit scale must degrade to ordinary TeX/text without terminating
   the child program.
3. **Output order is sacred:** all output paths go through the writer/control
   pipeline; do not write interleaving child output and generated graphics
   directly to stdout.
4. **Only own graphics are filtered/deleted:** image IDs lie in TFormula’s
   reserved range and response filters must leave unrelated terminal replies
   and user input intact.
5. **No unsafe overwrite:** borrowed blank-row canvases must never cover
   nonblank terminal text. Source masks hide only cells owned by the formula.
6. **Resize and scroll are normal:** placements are invalidated/rebuilt as
   terminal geometry changes. Old placements/images must be cleaned up without
   disturbing application state or an alternate screen.
7. **Do not expose sensitive input:** history metadata retains only the command
   executable, not command arguments; diagnostic output must not disturb a TUI.
8. **Local reader only:** remote/data images and external links remain inert.

## Build, test, and release workflow

```sh
npm install
npm run build       # TypeScript → dist/, marks dist/cli.js executable
npm test            # Vitest suite
npm run check       # build + test; expected pre-publish gate
npm run benchmark
npm run benchmark:reader
```

`package.json` publishes `dist/cli.js` as `tformula`. The package includes
`dist` and the Chinese README. `prepack` builds, and `prepublishOnly` runs the
full check.

The test directory is organized by behavior rather than source-tree mirroring:

| Test area | Primary coverage |
|---|---|
| `detect`, `scientific-detection`, `scientific-formulas` | TeX recognition and scientific corpus compatibility |
| `screen-text`, `formula-layout`, `geometry`, `math-renderer`, `screen` | mapping, placement, image geometry, renderer, lifecycle |
| `proxy-e2e`, `reader-e2e`, `streaming-resize`, `terminal-protocol-integrity` | pseudo-terminal integration and protocol safety |
| `reader*` | document parsing, layout, graphics viewport, cache, reload/watch |
| `probe`, `terminal-responses`, `terminal-output`, `terminal-writer`, `kitty` | terminal capabilities, filtering, output ordering, Kitty encoding |
| `formula-cache`, `formula-history`, `formula-export`, `cli` | persistence, output formats, and command parsing |
| `agent-output-golden`, `codex-chemistry-output` | captured real-agent terminal-cell regressions |

## Change guidance

For formula behavior changes, add or update the narrow detector/layout/renderer
test first, then cover the screen or pseudo-terminal integration boundary when
ANSI/placement sequencing is involved. Preserve fixture provenance in
`test/fixtures/agent-output/`; real-agent output is a regression corpus, not
an API contract to normalize away casually.

For reader changes, test parsing or layout as a pure function where possible,
then add reader integration coverage only for interactive state, rendering,
reload, or terminal-image behavior. Recheck narrow terminal widths, CJK text,
soft wrapping, image zoom/cropping, and no-Kitty fallback.

Use `npm run check` before considering a behavioral change complete. Run both
benchmark commands when altering scanning, rendering, caching, reader layout,
or terminal graphics reuse. Maintain the public README in English and Chinese
for user-visible changes. The current formula-layout work ledger is
`docs/formula-layout-ledger.md`; its remaining P5 task is a broader real-agent
output golden corpus.

## Repository map

```text
src/
  cli.ts                  command parsing and runtime dispatch
  proxy.ts                PTY wrapper and event coordination
  screen.ts               headless screen mirror and overlay lifecycle
  detect.ts               semantic formula detector
  screen-text.ts          physical terminal-cell mapper
  formula-layout.ts       visual canvas planner
  math-renderer.ts        MathJax and terminal PNG rendering
  reader*.ts              local document reader pipeline
  terminal-*.ts, probe.ts terminal I/O, protocol handling, and capability probes
  kitty.ts                Kitty Graphics Protocol serialization
  formula-*.ts            cache, history, export, and formats
  types.ts                cross-layer contracts
test/                     unit, regression corpus, and pseudo-terminal tests
benchmark/                proxy and reader performance measurements
docs/                     maintained design/work ledgers
assets/                   README example assets
```
