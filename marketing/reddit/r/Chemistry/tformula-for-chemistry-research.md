# Reddit post — r/Chemistry

**Status:** Draft  
**Disclosure:** Post from the TFormula creator

## Title

I made a terminal tool that renders chemical equations from CLI assistants in place

## Body

If you already use a CLI assistant for chemistry, a detailed answer can quickly turn into a wall of raw TeX: equilibria, fractions, subscripts, conditional constants, and reaction arrows all competing for space in the terminal.

I built **TFormula** to fix that display problem. It wraps the CLI tool you already use, detects visible TeX, and renders it directly over the source text in a compatible terminal. It does **not** generate chemistry or judge whether an answer is correct.

Some ways I think it could fit a chemistry research workflow:

- Read acid–base speciation, equilibrium, thermodynamics, and kinetics derivations without mentally parsing raw TeX.
- Display `mhchem` notation for ions, isotopes, reversible reactions, and reaction conditions.
- Keep the original TeX in terminal scrollback, so an equation remains selectable and copyable for a paper or lab note.
- Open a local Markdown notebook with equations, tables, and exported spectrum or chromatogram images using `tformula notes.md`.
- Use the same display layer with Codex, Claude Code, Gemini CLI, or another terminal-based assistant; TFormula has no agent-specific integration.

For example, after installing it:

```bash
npm install -g tformula --allow-scripts=node-pty --allow-scripts=sharp
tformula codex
```

You could ask:

```text
Derive the conditional formation constant for Ca–EDTA at pH 10.00.
Use \ce{...} for the equilibria, show the mass balances, and calculate pCa.
```

The assistant still produces the answer, while TFormula makes the equations readable in the live terminal. Formula rendering is local and does not use a CDN, but the privacy and data-handling rules of the wrapped assistant still apply. The usual scientific caveat also applies: readable output is not validated output, so constants, assumptions, units, and algebra still need checking.

TFormula currently supports macOS and Linux. Ghostty is recommended; Kitty and WezTerm also work through the Kitty graphics protocol.

Project: https://github.com/mikewang817/TFormula

Would this fit anywhere in your workflow? I would especially value examples of chemistry notation or long derivations that do not render well yet.
