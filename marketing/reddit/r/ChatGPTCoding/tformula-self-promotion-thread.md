# Reddit comment — r/ChatGPTCoding self-promotion thread

**Status:** Draft; submit as a comment in the current self-promotion thread,
not as a standalone promotional post  
**Disclosure:** Comment from the TFormula creator

## Comment

Disclosure: I built **TFormula**, a terminal-side display layer for scientific
LaTeX. It works with Codex, Claude Code, Gemini CLI, OpenCode, Aider, or any
other command that runs in a terminal.

It is not an agent integration. TFormula does not call model APIs or depend on
a prompt/response format. It wraps a command in a PTY, forwards its ANSI output,
mirrors the visible terminal screen, renders detected TeX locally with MathJax,
and places the formula over the source text through the Kitty graphics
protocol. The original text stays in scrollback and remains copyable.

You can wrap one agent:

```bash
tformula codex
tformula claude
```

Or start one TFormula-managed shell and run whichever tools you want inside it:

```bash
tformula --shell
```

I use it as a learning environment as much as an agent accessory. For example,
the screenshot shows a Maxwell’s-equations explanation, but the useful part is
the continuous workflow: read live formulas from any command, save the result
to Markdown, and reopen the note in TFormula’s local document reader.

```bash
tformula maxwell-equations.md
```

The reader handles Markdown structure, equations, tables, links, code, and
local images. TFormula only changes how content is displayed; it neither
generates nor validates the answer.

macOS/Linux; Ghostty is the primary target, with Kitty and WezTerm also
supported.

GitHub: https://github.com/mikewang817/TFormula

I’d welcome examples of scientific notation, terminal programs, or document
workflows that the generic layer should support better.
