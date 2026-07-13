# TFormula

TFormula is a terminal-agnostic PTY proxy that renders LaTeX produced by any
CLI agent in Ghostty and other terminals that implement the Kitty graphics
protocol. It does not use Codex, Claude, Gemini, or any other agent-specific
API.

The child program still sees a normal terminal. TFormula forwards its ANSI
output unchanged, maintains a headless copy of the terminal screen, detects
visible TeX, renders it locally with MathJax, and places the result over the
source text using the Kitty graphics protocol. The original text remains in
the terminal buffer for copying.

## Requirements

- macOS or Linux
- Node.js 20 or newer
- Ghostty, Kitty, WezTerm, or another terminal with Kitty graphics support

The current implementation has been developed against Ghostty 1.3.1.

## Install from this checkout

```sh
npm install
npm run check
npm link
```

After `npm link`, start any agent through TFormula:

```sh
tformula codex
tformula claude
tformula gemini
tformula -- opencode --continue
```

To cover every command without adding aliases, start an enhanced login shell:

```sh
tformula --shell
```

Running `tformula` without arguments is equivalent to `tformula --shell`.

## Formula sizing

At startup and after terminal resize events, TFormula queries the terminal for
its cell dimensions in pixels. MathJax's natural `ex` dimensions are mapped to
the terminal cell height, so an ordinary mathematical symbol has approximately
the same visual size as neighboring terminal text. Fractions, sums, and other
tall constructs retain their natural proportions.

Formulas are never enlarged merely to fill the source rectangle. They are only
scaled down when they would exceed the columns or rows already occupied by the
source. This is necessary because inserting terminal rows behind a full-screen
TUI would desynchronize its cursor coordinates.

Formula scans are coalesced during streaming output instead of waiting for the
terminal to become completely idle. Unrelated status-bar or spinner updates do
not cancel formulas that remain unchanged on screen. Long PTY output bursts are
forwarded at line-boundary checkpoints of roughly one third of the terminal
height. TFormula completes a formula scan at each checkpoint before forwarding
more rows, so rendered images enter scrollback together with their source text
instead of being missed after an entire response scrolls past. When the terminal
grid or cell pixel size changes, TFormula replaces only the affected Kitty placements.
The underlying PNG is retained and shared by every placement with the same
formula, size, and colors. Normal resizing only replaces images still in the
live viewport; off-screen placements are preserved so the terminal can scroll
and scale them with its own scrollback. Replacement is transactional: the old
placement is deleted only after the new cached variant is ready, and xterm
markers track its source rows through terminal reflow. A rapid sequence of font
size changes therefore keeps the previous rendered formula instead of exposing
the underlying TeX. `CSI 2J` invalidates visible placements,
while `CSI 3J` and `RIS` invalidate all placements and cached terminal images.
TFormula reserves a private image-ID range and deletes that complete range on
full reset and shutdown, including interrupted transmissions.

When an agent emits display math as a single standalone `$$...$$` or
`\[...\]` line, TFormula borrows adjacent blank terminal rows when available.
This gives fractions and derivatives enough vertical space to retain the same
base glyph size as simple equations. Inline math and display delimiters mixed
with prose are never expanded, so neighboring text is not covered.

A trailing inline formula can similarly use one following blank row for tall
fraction content. TFormula absorbs terminal punctuation into that overlay so it
stays next to the rendered expression. The common reciprocal-root form
`1/\sqrt{...}` is typeset as `\frac{1}{\sqrt{...}}`; slashes in ordinary units
such as `m/s` are left unchanged.

If a terminal does not answer pixel-size queries, TFormula falls back to 9x18
pixels. You can override that explicitly:

```sh
tformula --cell-size 10x20 claude
```

The default text-relative scale is 1.0. It can be adjusted without changing the
terminal font:

```sh
tformula --scale 1.1 codex
TFORMULA_SCALE=0.9 tformula --shell
```

## Formula cache

Math rendering is content-addressed and shared by every TFormula-wrapped Agent
run for the current user. A normalized formula is typeset to SVG once. Each
terminal-ready PNG variant is then rasterized once for its exact display mode,
cell dimensions, scale, foreground, background, and source rectangle. Returning
to an earlier terminal font size reuses the existing PNG instead of invoking
MathJax or the rasterizer again.

Cache writes use per-item cross-process locks and atomic renames, so concurrent
Agents can safely request the same formula. In a live terminal session, one PNG
is uploaded once and reused by independent Kitty placements wherever the same
variant appears. The original TeX text remains in terminal scrollback.

On macOS the disk cache defaults to `~/Library/Caches/TFormula`; on Linux it
uses `$XDG_CACHE_HOME/tformula` or `~/.cache/tformula`. Override the location or
the default 256 MB limit with:

```sh
TFORMULA_CACHE_DIR=/path/to/cache tformula codex
TFORMULA_CACHE_MAX_MB=512 tformula claude
```

## Detection

TFormula recognizes these explicit forms:

```text
\[ ... \]
$$ ... $$
\( ... \)
$ ... $
```

Some agent TUIs consume the backslashes around `\[` and `\]` while rendering
Markdown. For that case TFormula conservatively recognizes a bare `[`/`]`
block only when its body contains strong TeX features such as `\frac`, `\sum`,
subscripts, superscripts, or braced arguments.

The same compatibility rule applies when a TUI turns inline delimiters such as
`\(\rho\)` into `(\rho)`. TFormula renders the parenthesized span only when its
contents contain a recognized TeX command or similarly strong math structure;
ordinary prose in parentheses remains unchanged.

Short equations such as `E=mc^2`, `p=0`, and `c^2` are also recognized from
their operator structure. A single letter is inferred only in a symbol
definition item, where forms such as `- (E)：energy` are unambiguous.

Consecutive definition items such as `- (\rho)：电荷密度` are rendered as one
compact two-column MathJax array. This keeps symbols, colons, and descriptions
aligned even though their original TeX source strings have different widths.
Math expressions embedded in a description, including units written with
`\text{...}`, remain mathematical content inside that array.

Single-dollar expressions also require mathematical structure, which prevents
ordinary prices such as `$12.50` from being rendered.

## Options

```text
--shell                 Start the login shell
--no-math               Run only as a transparent PTY proxy
--scale <number>        Formula-to-terminal text scale (0.5 to 2.0)
--cell-size <WxH>       Override terminal cell pixels
-C, --cwd <directory>  Child working directory
--debug                 Print detection and sizing diagnostics
```

Use `--` when an agent command or its arguments could be mistaken for TFormula
options:

```sh
tformula -- claude --resume
```

## Safety and fallback behavior

- MathJax and fonts are installed locally; rendering does not use a CDN.
- Formula length is limited to 8192 characters.
- Commands that can load or embed external content, including `\require`,
  `\href`, `\url`, and MathJax HTML/style commands, are rejected.
- A parse or render failure leaves the original LaTeX visible.
- On terminals without Kitty graphics support, TFormula remains a transparent
  PTY proxy.

## Development

```sh
npm run build
npm test
npm run check
```

The test suite covers delimiter inference, false-positive filtering, Unicode
column positions, terminal response parsing, text-relative geometry, Kitty
encoding, MathJax-to-PNG rendering, and generic command wrapping.

For an end-to-end diagnostic, add `--debug`. A successful render reports the
terminal cell size, source location, and generated pixel rectangle without
printing the formula image bytes.
