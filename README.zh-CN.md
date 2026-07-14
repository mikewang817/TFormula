# TFormula

[English](README.md) | [简体中文](README.zh-CN.md)

直接在终端中渲染**任意 CLI Agent** 输出的 LaTeX 公式。

> **推荐在 Ghostty 中使用。** TFormula 主要基于 Ghostty 开发和测试，也支持
> Kitty、WezTerm 等实现了 Kitty Graphics Protocol 的终端。

TFormula 是一个与 Agent 无关的 PTY 代理。它不调用 Codex、Claude、Gemini
或其他 Agent 的专用 API，因此只要 Agent 能在终端中运行，就可以尝试使用
TFormula 包装。

Agent 看到的仍然是普通终端。TFormula 原样转发 ANSI 输出，同时维护一份
headless 终端画面，检测其中的 TeX，使用本地 MathJax 渲染，再通过 Kitty
图形协议把公式图片覆盖到原始文字上。原始 LaTeX 仍保留在终端缓冲区中，
可以正常复制。

## 在 Ghostty 中快速开始

推荐使用以下命令全局安装。使用 npm 11 时，需要允许 `node-pty` 执行其
原生安装脚本：

```sh
npm install -g tformula --allow-scripts=node-pty
```

然后把 `tformula` 放在你平时使用的 Agent 命令前面：

| Agent | 命令 |
|---|---|
| OpenAI Codex | `tformula codex` |
| Claude Code | `tformula claude` |
| Cursor Agent | `tformula agent` |
| Pi coding agent | `tformula pi` |
| Gemini CLI | `tformula gemini` |
| OpenCode | `tformula opencode` |
| Aider | `tformula aider` |
| Goose | `tformula goose` |
| Qwen Code | `tformula qwen` |
| 任意其他 CLI Agent | `tformula -- <agent命令> [参数...]` |

相应的 Agent 本身需要已经安装，并且可以从当前 `PATH` 中找到。TFormula
只负责包装命令，不负责安装 Agent。

例如，可以这样启动不同的 Agent：

```sh
tformula codex
tformula claude
tformula agent
tformula gemini
tformula opencode
tformula aider
```

`--shell` 会启动一个增强的登录 Shell。在这个 Shell 中启动命令时，不需要
为每一个 Agent 单独创建别名：

```sh
tformula --shell
```

不带参数运行 `tformula` 等价于 `tformula --shell`。

## 环境要求

- 推荐 Ghostty；也支持 Kitty、WezTerm 或其他兼容 Kitty 图形协议的终端
- macOS 或 Linux
- Node.js 20 或更高版本
- 需要运行的 CLI Agent

当前实现主要基于 Ghostty 1.3.1 开发和验证。

## 从源码安装

```sh
git clone https://github.com/mikewang817/TFormula.git
cd TFormula
npm install
npm run check
npm link
tformula codex
```

## 公式大小

TFormula 会在启动时以及终端尺寸变化后查询单元格的像素尺寸，再把 MathJax
公式的自然 `ex` 高度映射到终端文字高度。因此普通数学符号会与周围文字大小
接近，而分式、求和与导数仍保留自然的上下结构。

公式不会为了填满源码区域而强制放大；只有在超出原始行列范围时才会缩小。
这是因为全屏 TUI 中不能随意插入额外行，否则会破坏 Agent 的光标坐标。

TeX 在终端边缘软换行，或终端 TUI 按自己的内容宽度插入硬换行时，TFormula 都会
重组完整公式，再用逐行透明切片覆盖源码；与公式共用首尾物理行的正文不会被图片
背景遮住。行内字形从源码区域左侧对齐，以贴近前面的正文。
独立 display 公式使用整个终端宽度；嵌入式 display 公式则在前缀和后缀之间的安全
几何范围内居中，因此不同 TeX 源码长度的公式会共用同一中心线。对于行内内容，
布局层从第一个公式到行尾通用组合“公式 token + 原样文字 token”，不理解周围文字
使用什么语言、表达什么语义。这样会把不可避免的源码宽度留白移到无影响的行尾，
同时保留底层终端单元格，以保持复制内容和 TUI 光标坐标正确。

对于很长的 Agent 输出，TFormula 大约每输出三分之一屏就建立一个检查点，
先完成公式检测和 placement，再继续输出。这样公式会与文字一起进入 scrollback，
不会因为整段回复一次滚过屏幕而漏掉。

当使用 `CMD +` 或 `CMD -` 改变字体大小时，新尺寸图片准备完成之前，旧公式
会继续保留。替换操作是事务式的：只有新 placement 可以创建时，才删除旧
placement。xterm marker 会在终端 reflow 后继续跟踪公式所在行，因此滚出屏幕
的已渲染公式不会退回 LaTeX 源码。

如果终端无法返回单元格像素尺寸，默认使用 9×18 像素。也可以手动指定：

```sh
tformula --cell-size 10x20 claude
```

默认公式比例为 1.0，可以独立调整：

```sh
tformula --scale 1.1 codex
TFORMULA_SCALE=0.9 tformula --shell
```

## 公式缓存

公式缓存采用内容寻址方式，并由当前用户启动的所有 TFormula Agent 进程共享：

- 同一个规范化公式只进行一次 MathJax SVG 排版。
- 每一种精确的字号、颜色、终端单元格和显示区域只生成一次 PNG。
- 多个 Agent 同时请求相同公式时，通过跨进程文件锁避免重复生成。
- 同一终端会话中的相同 PNG 只上传一次，不同位置共用图片数据并创建各自的
  placement。
- 缩放回之前使用过的字号时，直接复用已有 PNG。

macOS 默认缓存目录：

```text
~/Library/Caches/TFormula
```

Linux 默认使用：

```text
$XDG_CACHE_HOME/tformula
```

或：

```text
~/.cache/tformula
```

可以修改目录或默认的 256 MB 上限：

```sh
TFORMULA_CACHE_DIR=/path/to/cache tformula codex
TFORMULA_CACHE_MAX_MB=512 tformula claude
```

## 可识别的公式

TFormula 支持这些显式形式：

```text
\[ ... \]
$$ ... $$
\( ... \)
$ ... $
\begin{equation} ... \end{equation}
\begin{align} ... \end{align}
```

标准的 equation、align、gather、cases 和 matrix 等环境无论外层是否带美元
符号分隔符，均可识别。

某些 Agent TUI 在渲染 Markdown 时会吃掉 `\[`、`\]` 或 `\(`、`\)` 外层的
反斜杠。为兼容这种情况，TFormula 也会谨慎识别：

- 包含 `\frac`、`\sum`、上下标或花括号参数的裸 `[` / `]` 公式块；
- 包含明确 TeX 命令或数学结构的 `(\rho)` 等括号表达式；
- `E=mc^2`、`p=0`、`c^2` 等短方程；
- `- (\rho)：电荷密度` 等符号定义项；
- 连续符号定义列表，并将其渲染为对齐的两列表格。

普通文字括号和 `$12.50` 等价格不会被当作公式。

## 命令选项

```text
--shell                 启动登录 Shell
--no-math               仅作为透明 PTY 代理，不渲染公式
--scale <number>        公式相对终端文字的比例，范围 0.5～2.0
--cell-size <WxH>       手动指定终端单元格像素尺寸
-C, --cwd <directory>  指定 Agent 的工作目录
--debug                 输出检测与尺寸调试信息
```

当 Agent 参数可能被误认为 TFormula 参数时，使用 `--` 分隔：

```sh
tformula -- claude --resume
tformula -- opencode --continue
```

## 安全与降级行为

- MathJax 和字体全部在本地运行，不使用 CDN。
- 单个公式最长 8192 个字符。
- 禁止 `\require`、`\href`、`\url` 以及 MathJax HTML/样式命令等可能加载
  外部内容的命令。
- 解析或渲染失败时保留原始 LaTeX，不阻断 Agent。
- 终端不支持 Kitty 图形协议时，TFormula 会退化为透明 PTY 代理。

## 开发

```sh
npm run build
npm test
npm run check
```

需要端到端诊断时添加 `--debug`。成功渲染会报告终端单元格尺寸、源码位置和
最终像素矩形，但不会打印图片数据。
