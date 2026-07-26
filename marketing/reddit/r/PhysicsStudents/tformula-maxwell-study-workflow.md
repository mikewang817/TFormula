# Reddit post — r/PhysicsStudents

**Status:** Draft; check the current self-promotion rules or ask the moderators
before submitting  
**Post type:** Image post  
**Suggested image:** `assets/tformula-maxwell.png`  
**Disclosure:** Post from the TFormula creator

## Title

I turned my terminal into a more readable workspace for studying equations

## Body

I have been experimenting with keeping an entire physics study loop in the
terminal: read a local note, ask a tool for another explanation, inspect a
derivation, edit the note, and reopen it without switching to a separate
document application.

The screenshot is a Maxwell’s-equations example. The program producing the
explanation happens to be Codex, but it could be another CLI assistant or any
command that prints TeX. Full disclosure: I built **TFormula**, the terminal
display layer used here.

TFormula itself has no connection to Codex or to any particular AI system. It
can wrap a single command or the whole login shell:

```bash
tformula --shell
tformula -- <command> [args...]
```

While a command runs, TFormula preserves the normal interactive terminal but
renders detected scientific LaTeX over the original source text. I can
therefore read a fraction, vector equation, matrix, or chemical equation in
place, while the underlying TeX remains selectable and copyable.

It also has a separate full-screen reader for local Markdown, text, and image
files:

```bash
tformula maxwell-equations.md
```

That has led to a study workflow I like:

1. Write or generate an initial Markdown outline of the topic.
2. Read it in the terminal with the notation rendered properly.
3. Pick one statement and test it with units, a limiting case, or a short
   derivation.
4. Add what I learned to the same local note and let the reader refresh.
5. Revisit the note later and try to reproduce the reasoning without help.

For Maxwell’s equations, some useful checkpoints were:

- Why does ∇·B = 0 not mean that B = 0?
- What inconsistency does the displacement-current term repair?
- Why does the magnetic Lorentz force change direction but not kinetic energy?
- Which assumptions enter the vacuum electromagnetic-wave derivation?

Readable notation does not make an explanation trustworthy. TFormula is only a
display and document-reading tool; it does not validate physics or modify the
content. I still compare results with a textbook, check dimensions, and solve
problems independently.

Implementation: https://github.com/mikewang817/TFormula

For those who study from a terminal, what would make this workflow genuinely
useful: better equation handling, diagrams, links between notes, or something
else?

