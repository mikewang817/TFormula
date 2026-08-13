# pi-math complete parity audit

Reference: `Fadouse/pi-math` commit `733182b` (`@fadouse/pi-math@0.2.0`).
Audit target: TFormula's generic PTY proxy and document reader.

“Parity” here means matching every portable invariant and explicitly recording
where Pi's private Markdown renderer cannot be copied without breaking the PTY
contract. TFormula must never alter child output, cursor coordinates, or
scrollback text merely to imitate an in-process Pi extension.

| Area | pi-math | TFormula parity result |
| --- | --- | --- |
| TeX layout | MathJax 3 SVG | MathJax 4 SVG; equivalent or newer |
| Rasterizer | Resvg | Resvg; equivalent |
| Source immutability | Temporarily patches `Markdown.render()`, restores source in `finally` | Child ANSI/text is never replaced; images are independent overlays; stronger PTY-level invariant |
| Delimiter scanner | Dollar/slash delimiters and display environments | Same explicit forms plus conservative recovery after TUI delimiter loss |
| Literal exclusions | Fences, indented/inline code, HTML code/pre/comments, TeX comments and `\verb` | Fences (including quote gutters), inline code, HTML code/pre/comments, TeX comments and `\verb`; terminal output has no reliable remaining distinction between Markdown indented code and ordinary TUI indentation, so style/cell semantics remain authoritative |
| Nested environments | Stack-balanced | Stack-balanced |
| Inline flow | Pi Markdown markers and Kitty Unicode virtual placements | Source-cell overlays plus reader natural-pixel placement; virtual placeholders are deliberately not used in proxy mode because they would rewrite child cells and coordinates |
| Display flow | Pi component rows | Semantic detection → physical source mapping → independent placement planner, including safe blank-row borrowing |
| Base sizing | `0.50 × cell height` px/ex | `0.45 × cell height × --scale`; same fixed-scale/minimum-fit invariant, calibrated to neighboring terminal x-height |
| Proportional fitting | Width fit; inline height fit | Width/height fit, reported `fitScale`, configurable readable fallback |
| Raster safety | 4096², 12 MB, nonempty alpha, edge clipping check | 4096², 12 MB, nonempty alpha and structured failures; Resvg is additionally contained in a restartable child process so a native panic cannot kill the PTY; exact alpha-edge rejection is not applied to opaque source masks because touching those mask edges is intentional |
| Macro expansion limit | 1,000 | 1,000 |
| Input limit | 20,000 | 20,000 |
| Macros/environments | Environment JSON config | `TFORMULA_MATH_MACROS` and `TFORMULA_MATH_ENVIRONMENTS`, validated and included in cache identity |
| Fonts | Explicit files and optional system discovery | `TFORMULA_FONT_FILES` and `TFORMULA_SYSTEM_FONTS`, with existence validation and lazy loading only for SVG text nodes |
| Unsafe TeX | SafeHandler and disabled URL/style access | Fixed local package list plus explicit rejection of external-resource, document and HTML/style commands; configured definitions receive the same validation |
| SVG cache | Weighted in-process cache | Validated content-addressed cross-process persistent cache with per-item locks, atomic writes and stale-lock fencing |
| PNG cache | Weighted in-process cache | Validated persistent PNG cache plus weighted in-process cache; exact geometry/theme/config in key |
| Negative cache | Structured failed entries | Structured MathJax failure LRU in process; failures are not persisted across runs |
| Cache controls | `/math-render clear/status` | `tformula cache clear/status`; rendering disable is `--no-math` |
| Resize | Pi rerender | Transactional replacement, source markers and scrollback-aware reflow |
| Theme color | Pi Markdown code color | Actual formula-cell foreground/background sampled from the terminal |
| Terminal protocols | Kitty/Ghostty inline; Kitty compatibility; iTerm display | Kitty graphics protocol, optimized for Ghostty/Kitty/WezTerm implementations; iTerm2 remains outside TFormula's stated runtime contract |
| Fallback | Original LaTeX | Original LaTeX and transparent PTY behavior |
| Extra TFormula capabilities | — | Formula history/export, Markdown/image reader, focus overlay, persistent cross-agent cache, generic command wrapping |

## Non-negotiable architecture boundaries

1. Proxy mode will not insert Kitty Unicode placeholder characters into child
   output. That would change copying, TUI cursor positions and Agent-visible
   terminal state.
2. TFormula will not monkey-patch Pi internals. Pi-specific users can install
   pi-math directly; TFormula remains usable with every CLI.
3. iTerm2 display-only images are not treated as equivalent to interactive
   Kitty placements and are not advertised as supported.
4. Detection consumes post-ANSI terminal cells, not original Markdown. Rules
   that require unavailable source syntax are not guessed when doing so could
   hide ordinary TUI content.

## Verification ownership

- Scanner and source immutability: `test/detect.test.ts`, `test/screen.test.ts`
- Configuration: `test/math-renderer-config.test.ts`
- Raster safety and structured failures: `test/math-renderer.test.ts`
- Weighted memory and persistent cache: `test/weighted-lru-cache.test.ts`,
  `test/formula-cache.test.ts`
- Cache CLI: `test/cli.test.ts`
- Scientific compatibility: `test/scientific-formulas.test.ts`,
  `test/scientific-detection.test.ts`
