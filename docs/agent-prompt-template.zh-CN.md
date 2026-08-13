# Agent 提示词模板：LaTeX 输出规范

[English](agent-prompt-template.md) | [简体中文](agent-prompt-template.zh-CN.md)

无论 Agent 输出什么形式的 LaTeX，TFormula 都会尽量渲染；但当 Agent 的数学
输出保持统一时，实际使用体验会更好。这份提示词模板要求 Agent 使用 TFormula
最容易稳定识别的定界符形式和推导写法。

模板是可选的。TFormula 本身不需要任何 Agent 侧配置。

模板由 [@CHENyiru3](https://github.com/CHENyiru3) 在
[PR #3](https://github.com/mikewang817/TFormula/pull/3) 的讨论中提供，来自其
日常配合 TFormula 使用的指令集。

## 使用方式

把模板复制到 Agent 已经会读取的指令文件里，然后照常通过 TFormula 启动
Agent：

| Agent | 文件 |
|---|---|
| OpenAI Codex | `AGENTS.md`（项目内或 `~/.codex/AGENTS.md`） |
| Claude Code | `CLAUDE.md`（项目内或 `~/.claude/CLAUDE.md`） |
| Gemini CLI | `GEMINI.md` |
| Cursor Agent | `AGENTS.md` 或项目规则 |
| 其他 | 任意 system prompt 或自定义指令输入框 |

```sh
cat docs/agent-prompt-template.md >> AGENTS.md   # 之后裁剪为模板正文
tformula codex
```

把模板粘贴到会话的第一条消息中同样有效。

## 模板

模板正文保持英文，便于直接放入 Agent 的指令文件：

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

## 这些规则为什么有用

- **优先使用 `\(...\)` 与 `\[...\]`。** TFormula 同样识别 `$...$` 和
  `$$...$$`，但单美元符号的内容必须先表现出足够的数学结构才会被渲染，这样
  `$12.50` 这类普通文本才不会被误判。显式定界符没有这种歧义。
- **显示公式的定界符独占一行。** 独立的显示公式会占用整行终端宽度，长推导
  因此不会被压缩到收尾的 `]` 那一行里。
- **正文留在定界符之外。** 不进入数学模式的句子在终端缓冲区里保持可读，而
  终端缓冲区正是复制时取到的内容。
- **只输出 TeX 片段。** `\usepackage`、`\documentclass`、`\includegraphics`、
  `\href`、`\require` 等导言区和外部资源命令会被 TFormula 的渲染器拒绝；提前
  要求 Agent 不要输出它们，可以避免出现明显渲染失败的公式。
- **遵循 MathJax 科学配置。** 支持的命令集合见
  [科学 LaTeX 兼容性](../README.zh-CN.md#科学-latex-兼容性)。遇到不支持的命令
  时，TFormula 会报告该命令并保留原始 TeX。
- **精确复现。** 当你要求 Agent 原样输出 TeX 时，TFormula 仍会原位渲染，而
  终端缓冲区保留逐字节一致的源字符。

[可识别的公式](../README.zh-CN.md#可识别的公式)中描述的兜底路径——裸 `[...]`
块、被改写成圆括号的行内公式、被折叠的 `\\` 换行符——依然保留，用于不遵循本
模板的 Agent，或在 TFormula 看到内容之前就改写了定界符的 TUI。

## 按需修改

模板是起点，不是规范。常见调整：

- 想要更短的回答时，可以删除 **Derivation requirements** 一节。
- 在样式规则旁补充领域宏，并通过 `TFORMULA_MATH_MACROS` 注册，使双方使用同一
  套记号。
- 如果 Agent 的 TUI 会破坏 `\(...\)`，可以只要求 `\[...\]` 显示公式；无论周围
  TUI 是否改写定界符，TFormula 都能渲染显示块。
