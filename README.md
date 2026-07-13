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

Consecutive definition items such as `- (\rho)：电荷密度` are rendered as one
compact two-column MathJax array. This keeps symbols, colons, and descriptions
aligned even though their original TeX source strings have different widths.

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
