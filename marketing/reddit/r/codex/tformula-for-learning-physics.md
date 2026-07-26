# Reddit post — r/codex

**Status:** Draft  
**Post type:** Image post  
**Suggested image:** `assets/tformula-maxwell.png`  
**Disclosure:** Post from the TFormula creator

## Title

I made my terminal render the equations in Codex answers instead of showing raw TeX

## Body

I sometimes use a terminal session as a study workspace: ask for an overview,
stop at one equation, ask what each term means, check a limiting case, and save
the useful result as a local note.

The screenshot shows Codex introducing Maxwell’s equations. Full disclosure: I
built the formula-rendering tool in the screenshot. It is called **TFormula**.

The important architectural detail is that TFormula is not a Codex integration.
It does not call a Codex API, install a Codex plugin, or inspect a Codex-specific
response format. Codex is simply the child command shown in this example.

TFormula is a generic PTY display layer. It forwards a command’s ANSI output,
keeps a headless mirror of the terminal screen, detects visible TeX, renders it
locally with MathJax, and places the result over the source text through the
Kitty graphics protocol. The command still sees a normal terminal, and the
original TeX remains in scrollback for selection and copying.

That means the same wrapper can be used with Codex, Claude Code, Gemini CLI,
OpenCode, Aider, a custom command, or an entire login shell:

```bash
tformula codex
tformula --shell
tformula -- <any-command> [args...]
```

For learning, I use both sides of TFormula:

- The PTY mode keeps live formulas readable while I ask follow-up questions.
- The document mode opens the Markdown note afterward with equations, tables,
  links, and local images laid out inside the terminal.

```bash
tformula maxwell-equations.md
```

For this Maxwell session, one useful follow-up was why the magnetic part of the
Lorentz force can bend a particle’s path without changing its kinetic energy.
Seeing the cross products and dot products as notation, rather than TeX source,
made it easier for me to concentrate on the physical argument.

TFormula only changes presentation. It neither generates the explanation nor
checks whether it is correct, so I still verify definitions, assumptions, and
derivations against textbooks or primary sources.

Project: https://github.com/mikewang817/TFormula

For people who use Codex for scientific or mathematical work: would a
terminal-level display layer fit your workflow better than an integration tied
to one agent?
