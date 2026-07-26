# Reddit post — r/SideProject

**Status:** Draft  
**Post type:** Image post  
**Suggested image:** `assets/tformula-maxwell.png`  
**Disclosure:** Post from the TFormula creator

## Title

I built a terminal-level display layer for scientific formulas—not another AI client

## Body

I use the terminal for both development and learning, but scientific content has
always felt like a second-class citizen there. A command can print a perfectly
good explanation, yet once it contains fractions, vectors, matrices, reaction
equations, or a long derivation, I am reading TeX source instead of the subject.

I built **TFormula** to address that display problem.

The screenshot shows Maxwell’s equations produced by Codex, but Codex is only
an example command. TFormula has no Codex integration and no dependency on any
agent API. It can wrap an arbitrary command or an entire login shell:

```bash
tformula -- <command> [args...]
tformula --shell
```

The proxy treats the child process as opaque. It forwards ANSI output, mirrors
the terminal in a headless xterm screen, detects visible TeX, renders the
formula locally with MathJax, and overlays the resulting image with the Kitty
graphics protocol. The source cells stay intact, so terminal interaction,
scrollback, and copying continue to work normally.

There is a second, independent mode for reading local material:

```bash
tformula notes.md
tformula diagram.png
```

The full-screen reader lays out Markdown, formulas, tables, links, code, and
local images for the current terminal width. It watches the document and its
images, so saving an edit refreshes the view while preserving the reading
position.

Together, the two modes give me one continuous learning workflow: explore a
topic with any terminal tool, copy useful equations into a local Markdown note,
and read the evolving note without losing the rendered notation.

Some design constraints that turned out to matter:

- Rendering is local and does not use a CDN.
- TFormula does not generate, rewrite, or validate the underlying content.
- Unsupported TeX remains visible instead of being silently approximated.
- A terminal without Kitty graphics falls back to ordinary terminal output.
- The same mechanism works whether the child is an agent, a shell, or another
  CLI program.

It currently runs on macOS and Linux. Ghostty is the primary development
target; Kitty and WezTerm are also supported.

GitHub: https://github.com/mikewang817/TFormula

I’d value feedback on the product boundary: should a tool like this stay a
transparent terminal layer, or would integrations with individual applications
be worth the added coupling?
