# Agent prompt template: LaTeX output standard

[English](agent-prompt-template.md) | [简体中文](agent-prompt-template.zh-CN.md)

TFormula renders whatever LaTeX an agent happens to emit, but agents are more
useful when their math output is consistent. This prompt template asks the
agent for the delimiter forms and the derivation style that TFormula detects
most reliably.

The template is optional. TFormula requires no agent-side configuration.

It was contributed by [@CHENyiru3](https://github.com/CHENyiru3) in the
discussion on [PR #3](https://github.com/mikewang817/TFormula/pull/3), from an
instruction set already in daily use with TFormula.

## How to use it

Copy the template into the instruction file your agent already reads, then
start the agent through TFormula as usual:

| Agent | File |
|---|---|
| OpenAI Codex | `AGENTS.md` (project or `~/.codex/AGENTS.md`) |
| Claude Code | `CLAUDE.md` (project or `~/.claude/CLAUDE.md`) |
| Gemini CLI | `GEMINI.md` |
| Cursor Agent | `AGENTS.md` or project rules |
| Others | Any system-prompt or custom-instructions field |

```sh
cat docs/agent-prompt-template.md >> AGENTS.md   # then trim to the template body
tformula codex
```

Pasting the template into the first message of a session works too.

## Template

```markdown
# LaTeX Output Standard

Follow these rules for all generated mathematical output.

## Output contract

- Use `\(...\)` for inline math.
- Use `\[` and `\]` for display math.
- Put display delimiters on their own otherwise-empty lines.
- Do not generate `$...$`, `$$...$$`, bare `(TeX)`, bare `[TeX]`, or delimiter-free equations.
- Keep prose and punctuation outside inline delimiters.
- Emit TeX fragments only: never include a document preamble, `\documentclass`, `\usepackage`, or external-resource commands.
- Use only commands supported by the configured MathJax scientific profile.
- If an expression cannot be represented safely, leave it as plain text rather than inventing syntax.

## Exact reproduction

When the user says "output exactly," "do not change whitespace," or equivalent:

- Reproduce the supplied text byte-for-byte.
- Do not normalize delimiters, correct TeX, add explanations, or wrap content in a code block.
- This rule overrides the output contract.

## Mathematical style

- Use `\mathrm{}` for upright units and named constants where appropriate.
- Use `\mathbf{}` or `\boldsymbol{}` consistently for vectors and tensors.
- Use `\operatorname{}` for nonstandard named operators.
- Prefer `aligned` for multi-line derivations:

\[
\begin{aligned}
L(w)
&= \frac{1}{2n}(Xw-y)^\top(Xw-y) \\
&= \frac{1}{2n}\left(w^\top X^\top Xw - 2y^\top Xw + y^\top y\right).
\end{aligned}
\]

- State dimensions outside the equation unless they are part of the result.

## Derivation requirements

When asked to derive a result:

1. Expand the stated expression before differentiating.
2. Show enough intermediate algebra to justify the result.
3. State the final result in a display block.
4. State the shape of vector or matrix results explicitly.

Example:

\[
\nabla_w L(w)=\frac{1}{n}X^\top(Xw-y),
\qquad
\nabla_w L(w)\in\mathbb{R}^{d\times 1}.
\]
```

## Why these rules help TFormula

- **`\(...\)` and `\[...\]` first.** TFormula also detects `$...$` and
  `$$...$$`, but single-dollar spans must prove they are mathematical before
  they render, so that ordinary text such as `$12.50` is left alone. The
  explicit forms carry no such ambiguity.
- **Display delimiters on their own lines.** A standalone display reserves the
  full terminal width, which keeps long derivations from being compressed into
  the closing `]` line.
- **Prose outside the delimiters.** Sentences kept out of math mode stay
  readable in the terminal buffer, which is what gets copied.
- **TeX fragments only.** Preamble and external-resource commands such as
  `\usepackage`, `\documentclass`, `\includegraphics`, `\href`, and `\require`
  are rejected by TFormula's renderer; asking the agent not to emit them avoids
  a formula that visibly fails to render.
- **The MathJax scientific profile.** The supported command set is listed in
  [Scientific LaTeX compatibility](../README.md#scientific-latex-compatibility).
  Unsupported commands are reported and the original TeX stays visible.
- **Exact reproduction.** When you ask an agent to echo TeX verbatim, TFormula
  still renders it in place while the terminal buffer keeps the exact source
  characters.

The recovery paths described under
[Detection](../README.md#detection)—bare `[...]` blocks, parenthesized inline
spans, and collapsed `\\` row separators—remain in place for agents that do not
follow this template, or for TUIs that rewrite the delimiters before TFormula
sees them.

## Adapting it

The template is a starting point, not a specification. Useful edits:

- Drop the **Derivation requirements** section if you want shorter answers.
- Add domain macros next to the style rules, and register them with
  `TFORMULA_MATH_MACROS` so both sides agree on the notation.
- If your agent's TUI mangles `\(...\)`, ask for `\[...\]` display math only;
  TFormula renders display blocks whether or not the surrounding TUI rewrites
  them.
