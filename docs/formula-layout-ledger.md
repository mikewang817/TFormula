# TFormula 公式布局改造台账

> 建立日期：2026-07-25
> 台账状态：执行中
> 对应分支：`main`
> 验证基线：`npm run check`（28 个测试文件，444 passed，1 expected fail）

## 1. 台账使用规则

1. 只使用本台账中的原始五阶段编号，不在对话中临时重编号。
2. 每次开发开始前，将唯一的“下一执行项”标记为 `IN_PROGRESS`。
3. 每次开发结束后必须记录：
   - 修改文件；
   - 验收测试；
   - `npm run check` 结果；
   - 未完成项或已知风险。
4. 只有满足该条目的全部验收标准后，才能标记为 `DONE`。
5. 部分实现必须标记为 `PARTIAL`，不得表述为阶段完成。
6. 阶段必须在其全部条目为 `DONE` 后才能标记为完成。
7. 工作区中与本改造无关的未跟踪文件不纳入修改范围，包括 `marketing/`、案件图片、会话导出和独立 Markdown 草稿。

状态定义：

- `TODO`：尚未开始；
- `IN_PROGRESS`：当前唯一执行项；
- `PARTIAL`：已有实现，但尚未满足验收标准；
- `DONE`：代码、测试和文档均满足验收标准；
- `BLOCKED`：存在明确外部阻塞，并已记录原因。

---

## 2. 总览

| 阶段 | 名称 | 状态 | 完成条件 |
|---|---|---|---|
| P1 | 布局质量判定 | `DONE` | P1.1～P1.5 全部完成 |
| P2 | 拆分语义区域和显示画布 | `DONE` | P2.1～P2.5 全部完成；生产链路为 DetectedFormula → MappedFormula → FormulaPlacementPlan |
| P3 | 安全空白行借用 | `DONE` | P3.1～P3.9 全部完成；动态占用、resize、alternate screen、滚动均有回归测试 |
| P4 | 公式聚焦视图 | `DONE` | 最近公式注册表、高 z-index 覆盖层、输入状态机及 resize/clear/输出恢复均已实现 |
| P5 | 真实 Agent 输出语料库 | `TODO` | Codex、Claude、Gemini、Pi 语料及终端单元格 golden tests 建立 |

---

## 3. P1：布局质量判定

### P1.1 自然尺寸保留比例

- 状态：`DONE`
- 计划名称：`naturalScaleRatio`
- 当前实现名称：`fitScale`
- 代码证据：
  - `src/geometry.ts`
  - `src/math-renderer.ts`
  - `src/types.ts`
- 测试证据：
  - `test/geometry.test.ts`
  - `test/math-renderer.test.ts`
- 验收标准：渲染结果可以报告相对请求自然尺寸的实际拟合比例，范围为 0～1。

### P1.2 最低可读阈值与原始 TeX 降级

- 状态：`DONE`
- 默认值：`0.4`
- 配置：
  - `--min-readable-scale`
  - `TFORMULA_MIN_READABLE_SCALE`
- 代码证据：
  - `src/cli.ts`
  - `src/proxy.ts`
  - `src/screen.ts`
- 测试证据：
  - `test/cli.test.ts`
  - `test/screen.test.ts`
- 验收标准：低于阈值时不上传不可读图片；保留原始 TeX；设为 0 时可禁用。

### P1.3 明确区分 inline、display、embedded-display

- 状态：`DONE`
- 类型：

```ts
type FormulaIntent = "inline" | "display" | "embedded-display";
```

- 代码证据：
  - `src/types.ts`：定义 `FormulaIntent`；
  - `src/detect.ts`：语义分类并输出必有 intent 的 `DetectedFormulaRegion`；
  - `src/screen-text.ts`：使用 intent 决定独立 display、嵌入式 display 和 inline 映射；
  - `src/math-renderer.ts`：应用路径优先使用 intent 决定 MathJax display 模式；
  - `src/reader.ts`：阅读器公式显式提供 intent。
- 测试证据：`test/detect.test.ts` 明确断言 inline、display、embedded-display。
- 验收结果：检测输出具有唯一 intent；屏幕映射不再通过 `standaloneDisplay`/`standaloneBlock` 正则重新推断语义。兼容字段 `display` 暂保留，待 P2.5 移除混合职责。

### P1.4 公式稳定状态

- 状态：`DONE`
- 状态流程：`collecting → stable → rendered`
- 默认静默期：80 ms
- 配置：
  - `--stability-ms`
  - `TFORMULA_STABILITY_MS`
- 代码证据：`src/screen.ts`
- 测试证据：`test/screen.test.ts`
- 验收标准：快速重写只渲染最终公式；输出检查点可立即提升完整公式；无关状态栏更新不使公式永久饥饿。

### P1.5 失败原因和布局调试输出

- 状态：`DONE`
- 当前输出包括：
  - `fitScale`；
  - `canvasMode`；
  - collecting 等待时间；
  - 低于可读阈值的降级原因；
  - MathJax/Kitty 失败原因。
- 代码证据：`src/screen.ts`
- 验收标准：`--debug` 能区分检测、稳定等待、布局选择、可读性降级和渲染/图形协议错误。

---

## 4. P2：拆分语义区域和显示画布

### P2.1 建立 `DetectedFormula`

- 状态：`DONE`
- 代码证据：
  - `src/types.ts`：新增 `DetectedFormula` 和嵌套的 `FormulaSourceRange`；
  - `src/detect.ts`：新增 `detectFormulas()`，输出仅含 source、latex、intent、confidence 和过渡期 compact 语义提示；
  - `src/screen-text.ts`：应用路径已消费 `detectFormulas()`，在物理映射边界临时适配旧 region。
- 测试证据：`test/detect.test.ts` 明确断言语义输出不含 `display`、`canvasMode`、`sourceSegments`、`wrapSegments`。
- 兼容说明：`detectFormulaRegions()` 暂作为 deprecated 适配器保留，计划在 P2.3/P2.5 删除。
- 验收结果：检测层正式输出不包含视觉画布、借行方式、终端图片尺寸或 placement 模式。

### P2.2 建立 `FormulaPlacementPlan`

- 状态：`DONE`
- 代码证据：
  - `src/types.ts`：新增 `CellRectangle`、`FormulaCanvasMode`、`FormulaPlacementPlan`；
  - `src/formula-layout.ts`：新增旧 region 到 plan 的过渡适配器；
  - `src/math-renderer.ts`：新增 `renderPlacement(plan, ...)`，内部直接消费 formula、canvas、sourceMasks、formulaSlices、displayRange 和 mode；
  - `src/screen.ts`：扫描路径建立 plan，fingerprint、renderer 和 Kitty 起始坐标开始消费 plan；
  - `src/reader.ts`：阅读器公式改用 plan 渲染入口。
- 测试证据：`test/formula-layout.test.ts` 覆盖语义 source 与借行 canvas 分离、embedded source mask、wrapped formula slices。
- 兼容说明：旧 `MathRenderer.render(region, ...)` 暂作为 deprecated 适配入口保留，计划在 P2.5 删除。
- 验收结果：应用主路径的 Math renderer 和 Kitty placement 已消费 plan，不再由 renderer 重新解释混合 region。

### P2.3 拆分逻辑检测与物理屏幕映射

- 状态：`DONE`
- 代码证据：
  - `src/detect.ts`：`detectFormulas()` 只输出语义和精确 source；尾部 inline 不再在检测层借用下一空白行；
  - `src/screen-text.ts`：`detectScreenFormulaRegions()` 只完成逻辑行折叠、源码组合及逻辑坐标到物理 source segment 的映射，不再选择借行画布；
  - `src/screen.ts`：物理映射完成后显式调用 layout planner；
  - `src/formula-layout.ts`：统一负责候选画布和借行决策。
- 测试证据：
  - `test/detect.test.ts` 断言 trailing inline 的语义 source 不含空白行；
  - `test/screen-text.test.ts` 断言直接物理映射不产生 canvasMode/estimatedQuality，并通过显式 planner 集成测试借行。
- 验收结果：语义检测、物理 source 映射和视觉画布规划已形成三个明确边界。

### P2.4 新建独立布局规划模块

- 状态：`DONE`
- 文件：`src/formula-layout.ts`
- 已迁移：
  - `estimateFormulaCanvasRows`；
  - `scoreFormulaCanvasCandidate`；
  - `planFormulaDisplayCanvases`；
  - `formulaPlacementPlanFromRegion` 过渡适配器。
- 额外修正：高公式 trailing inline 的下方借行也由 planner 决定，并生成独立 source mask；简单 trailing inline 不再无条件借行。
- 测试证据：`test/formula-layout.test.ts` 可用纯行数据验证评分、借行选择、source/canvas 分离、embedded mask 和 wrapped slices，不依赖 xterm 私有状态。
- 验收结果：布局规划模块可独立单元测试，`screen-text.ts` 不再包含候选评分或借行决策。

### P2.5 移除 `FormulaRegion` 的混合职责

- 状态：`DONE`
- 已完成子项：
  - 已从 `src/detect.ts` 删除 deprecated `detectFormulaRegions()` 和跨层 `DetectedFormulaRegion`；
  - 旧坐标断言改为测试内对 `detectFormulas()` 的显式 source 投影，科学 corpus 和 Codex 回归直接使用 `detectFormulas()`；
  - 已从 `MathRenderer` 删除 deprecated `render(region, ...)`，生产代码和测试均调用 `renderPlacement(plan, ...)`；
  - `src/types.ts` 已建立正式 `MappedFormula`，明确保存 semantic formula、物理 source bounds、source masks、formula slices、display range 和 full-width mapping hint；
  - `src/screen-text.ts` 已生成 `MappedFormula[]`，借行前的物理 source 与视觉 canvas 不再共用坐标；
  - `src/formula-layout.ts` 已新增 `planFormulaPlacements(mapped, lines, columns)`，直接从 mapped source 生成最终 plan，并在此处完成 segment 相对坐标归一化和借行偏移；
  - `src/screen.ts` 的生产链路已完全改为 `MappedFormula → FormulaPlacementPlan`，marker、identity、visibility、颜色采样、稳定性和 Kitty placement 均直接消费 plan；
  - `src/reader.ts` 已直接构造 plan，不再创建临时 `FormulaRegion`。
- 最终清理：
  - `FormulaSnapshot.regions` 已删除，`screen-text.ts` 只导出 `MappedFormula[]` 和 deferred 信息；
  - `planFormulaDisplayCanvases()`、`formulaPlacementPlanFromRegion()` 已从 `src/` 删除；
  - 共享 `FormulaRegion` 类型及 `standalone`、`canvasMode`、`detectedFormula`、`wrapSegments` 等混合字段已删除；
  - detector 合并过程使用仅含语义字段的内部 `SemanticFormulaCandidate`；screen mapper 使用不导出的 `PhysicalFormulaCandidate`；
  - 旧形状只保留为 `test/mapped-formula-compat.ts` 的测试投影，不是生产 API，也不进入生产链路。
- 本批修改文件：`src/detect.ts`、`src/types.ts`、`src/screen-text.ts`、`src/formula-layout.ts`、`test/mapped-formula-compat.ts`、`test/screen-text.test.ts`、`test/formula-layout.test.ts`、`test/math-renderer.test.ts`、`test/scientific-detection.test.ts`、`test/codex-chemistry-output.test.ts`。
- 测试证据：layout 测试直接覆盖 mapped source、borrowed canvas、embedded masks 和 wrapped slices；screen/reader/renderer 全量回归通过。
- 验收结果：跨层对象已拆分，所有生产调用点和 TypeScript 编译均通过。
- 剩余风险：测试投影仍保留旧术语以复用历史回归断言，但无法被 `src/` 导入；P5 golden 建立时应逐步替换为 mapped/plan 快照。

---

## 5. P3：安全空白行借用

### P3.1 源码遮罩与视觉画布分离

- 状态：`DONE`
- 代码证据：
  - `src/types.ts` 的 `sourceSegments`；
  - `src/math-renderer.ts` 的 source-masked SVG。
- 测试证据：`test/math-renderer.test.ts`。

### P3.2 上下都有空白行

- 状态：`DONE`
- 测试证据：`test/screen-text.test.ts` 中 `borrowed-both` 和 source mask 偏移断言。

### P3.3 只有上方空白行

- 状态：`DONE`
- 测试证据：`test/formula-layout.test.ts` 直接构造“上方空白、下方正文”，断言 plan mode 为 `borrowed-above`、canvas 仅扩展到上方，并且 source mask 的 `rowOffset` 从 0 移至 1。
- 验收结果：下方非空行不被覆盖，语义 source 保持不变。

### P3.4 只有下方空白行

- 状态：`DONE`
- 测试证据：`test/formula-layout.test.ts` 直接断言 `borrowed-below`、source mask 保持源行 offset 0，且 canvas 在后续正文前结束。

### P3.5 后续输出占用已借用行

- 状态：`DONE`
- 测试证据：`test/screen.test.ts` 在 borrowed-below placement 建立后向借用行写入状态文本，断言 planner 回退到 source，旧 placement 删除先于新 placement 发出。

### P3.6 resize 后空白行消失

- 状态：`DONE`
- 测试证据：`test/screen.test.ts` 将四行视口缩为两行以移除下方空白行，断言重新规划为 source，并删除、替换旧借行 placement。

### P3.7 alternate screen 状态栏

- 状态：`DONE`
- 测试证据：`test/screen.test.ts` 在 alternate screen 中让动态状态栏占用 borrowed-below 行，断言事务式回退到 source；ED 2 后不发出陈旧 placement，切回 normal screen 后无遗留 pin。

### P3.8 滚动进入和离开视口

- 状态：`DONE`
- 测试证据：`test/screen.test.ts` 将 borrowed placement 滚出视口、滚回顶部、再滚到底部，断言 marker/pin 始终保留，不误删、不重复放置。

### P3.9 额外安全规则

- 状态：`DONE`
- 已覆盖：
  - 两个 display 共享空白行时均不借用；
  - embedded display 不借行；
  - 简单公式即使有空行也保留 source canvas；
  - 分式/多行环境按候选评分扩展。

---

## 6. P4：公式聚焦视图

### P4.1 最近公式注册表

- 状态：`DONE`
- 代码证据：`RecentFormulaEntry` 与 `FormulaScreen.recentFormulas`，最多保留 50 项，记录 semantic formula、source、完整 plan、fitScale、降级原因和时间；placement 离开视口后注册表仍保留。

### P4.2 非破坏性聚焦覆盖层

- 状态：`DONE`
- 代码证据：`FormulaScreen.focusLatestFormula()`/navigation/close 使用 `TFORMULA_FOCUS_Z_INDEX` 的全终端 Kitty placement，不进入 alternate screen，不改写 PTY 文本或 Agent 坐标。

### P4.3 聚焦输入状态机

- 状态：`DONE`
- 代码证据：`src/formula-focus.ts`；默认 `Ctrl-]`，支持 `--focus-key`/`TFORMULA_FOCUS_KEY`，聚焦中的导航、未知键和退出键均不转发给 Agent。

### P4.4 resize、clear、持续输出和失败恢复

- 状态：`DONE`
- 代码证据：focus dirty/refresh 生命周期接入 screen write、proxy output queue、resize 和 capability probe；ED 2 后重建覆盖层；失败时保留底层终端且退出聚焦输入状态。

### P4.5 聚焦视图测试

- 状态：`DONE`
- 测试证据：`test/formula-focus.test.ts`、`test/cli.test.ts`、`test/screen.test.ts` 覆盖输入不泄漏、注册表 metadata、高 z-index、无 nested alternate screen、持续输出、resize、clear、关闭和失败恢复。

---

## 7. P5：真实 Agent 输出语料库

### P5.1 语料目录和脱敏规则

- 状态：`DONE`
- 文件：`test/fixtures/agent-output/README.md`。
- 规则：区分 `captured`、`session-derived`、`pending`；规定用户、路径、仓库、会话、密钥和私有 URL 的脱敏方式；保留 ANSI、几何、换行和精确 LaTeX。

### P5.2 Codex 语料

- 状态：`DONE`
- 证据：现有 `test/codex-chemistry-output.test.ts` 继续保存完整真实回归；`codex-analytical-chemistry.json` 已按统一 schema 归档一段匿名 aligned 捕获并建立 golden。

### P5.3 Claude 语料

- 状态：`IN_PROGRESS`
- 当前文件：`claude.pending.json`。
- 尚缺：经授权的真实 Claude Code 公式终端响应。当前环境虽有 `claude` 可执行文件，但不得在未获用户确认时触发可能计费的外部模型调用，也不能把人工仿写冒充真实捕获。

### P5.4 Gemini 语料

- 状态：`TODO`
- 当前文件：`gemini.pending.json`。
- 尚缺：当前环境未安装 Gemini CLI，需要外部提供或在有授权和认证的环境中捕获。

### P5.5 Pi 语料

- 状态：`DONE`
- 证据：`pi-current-session.json` 从当前本地 Pi coding-agent 会话派生，保留 display、下方空白行和状态栏几何，不含用户内容。

### P5.6 必备场景覆盖

- 状态：`PARTIAL`
- 场景清单：
  - [x] 同行 display（人工测试）
  - [x] 多公式同行（人工测试）
  - [x] 中文和 CJK 双宽字符（人工/科学 corpus）
  - [x] 软换行（人工测试）
  - [x] aligned、cases、矩阵（人工/科学 corpus）
  - [x] 分隔符损坏（人工测试）
  - [x] 流式半成品（人工测试）
  - [x] resize 前后（人工测试）
  - [x] 状态栏附近公式的本地 Pi session-derived 语料
  - [ ] 输入框附近公式的真实 Agent 语料
  - [ ] 四种 Agent 均有真实输出证据（缺 Claude、Gemini）

### P5.7 终端单元格 golden tests

- 状态：`DONE`
- 测试：`test/agent-output-golden.test.ts`。
- 覆盖：真实 ANSI 经 headless xterm 还原固定 cells，再精确比较 semantic formula、MappedFormula、FormulaPlacementPlan 和 Kitty row/column/columns/rows；pending 文件明确排除，不冒充证据。
- 剩余扩展：取得 Claude/Gemini 捕获后按同一 schema 自动纳入该 golden。

---

## 8. 当前唯一执行项

- ID：`P5.3`
- 名称：采集经授权的真实 Claude Code 公式终端响应
- 状态：`IN_PROGRESS`
- 完成后顺序：`P5.4 → P5.6`

---

## 9. 验证记录

| 日期 | 变更批次 | 结果 |
|---|---|---|
| 2026-07-25 | 源码遮罩与视觉画布分离、安全借行、候选评分、fitScale、最低阈值、稳定状态 | `npm run check`：27 files passed；440 passed；1 expected fail |
| 2026-07-25 | 建立本台账 | 台账文件：`docs/formula-layout-ledger.md` |
| 2026-07-25 | P1.3 显式 FormulaIntent | `npm run check`：27 files passed；440 passed；1 expected fail；`git diff --check` 通过 |
| 2026-07-25 | P2.1 独立 DetectedFormula | `npm run check`：27 files passed；441 passed；1 expected fail；`git diff --check` 通过 |
| 2026-07-25 | P2.2 独立 FormulaPlacementPlan | `npm run check`：28 files passed；444 passed；1 expected fail；`git diff --check` 通过 |
| 2026-07-25 | P2.3/P2.4 映射与布局规划拆分 | `npm run check`：28 files passed；445 passed；1 expected fail；`git diff --check` 通过 |
| 2026-07-25 | P2.5 子批次 1：删除 deprecated 检测和 renderer API | `npm run check`：28 files passed；445 passed；1 expected fail；`git diff --check` 通过；P2.5 保持 IN_PROGRESS |
| 2026-07-25 | P2.5 子批次 2：生产链路迁移到 MappedFormula | `npm run check`：28 files passed；446 passed；1 expected fail；`git diff --check` 通过；P2.5 保持 IN_PROGRESS |
| 2026-07-25 | P2.5 子批次 3：删除 FormulaRegion 和全部生产 adapter | 首轮仅 `reader-watch` 原子替换监听超时；隔离重跑 2/2 通过；随后 `npm run check`：28 files passed；446 passed；1 expected fail；`git diff --check` 通过；P2 DONE |
| 2026-07-25 | P3.3 只有上方空白行 | `npm run check`：28 files passed；447 passed；1 expected fail；`git diff --check` 通过；直接验证 borrowed-above 和 source mask 偏移 |
| 2026-07-25 | P3.4～P3.8 安全借行动态生命周期 | `npm run check`：28 files passed；452 passed；1 expected fail；`git diff --check` 通过；P3 DONE |
| 2026-07-25 | P4 公式聚焦视图 | `npm run check`：29 files passed；460 passed；1 expected fail；`git diff --check` 通过；P4 DONE |
| 2026-07-25 | P5.1/P5.2/P5.5/P5.7 语料框架与 golden | `npm run check`：30 files passed；463 passed；1 expected fail；`git diff --check` 通过；Claude/Gemini 明确 pending，P5 保持 PARTIAL |
| 2026-07-25 | 集成 origin/main 公式历史与启动探针更新 | rebase 冲突按双功能合并；`npm run build` 通过；32 files passed；479 passed；1 expected fail；未强制推送 |
| 2026-07-25 | PDF/OCR Markdown reader 兼容性 | 修复 contaminated `$$`/`$CN` close、math HTML entities、专利编号公式误作 inline、图片尾随文字和表格内容截断；真实 760 行专利文档恢复 8 headings/12 images/141 formulas，141/141 MathJax 可渲染；`npm run check`：32 files passed；484 passed；1 expected fail；`git diff --check` 通过 |
| 2026-07-25 | 学术 PDF Markdown display 边界兼容性 | 将非代码区内嵌/相邻的 `$$`（含 `\\[...\\]`、`$$$text`、`$$$$`）正规化为独立块边界，并提升独立单美元公式；真实 HortiVQA 文件从 10 headings/5 images/1 table/16 formulas 恢复为 28 headings/11 images/6 tables/103 formulas，103/103 MathJax 可渲染；`npm run check`：32 files passed；486 passed；1 expected fail；`git diff --check` 通过 |
| 2026-07-25 | Reader 行内公式字距与中英文换行 | 移除行内公式整列冗余预留、将边距收紧为亚字符单元，并在 MathJax 首次测量后保持语义锚点即时重排；统一移除紧邻源空格，行内画布采用固定约 1px 左侧 bearing，将不可避免的整数列余量留在不再叠加源空格的右侧；CJK token 使用剩余列，公式携带后续首字/标点，增加中文闭标点禁则；PNG cache 升至 v5；覆盖 `i`、`c_{ij}`、`X_{ij}` 实测列宽及公式/CJK 边界；`npm run check`：32 files passed；489 passed；1 expected fail；`git diff --check` 通过 |
| 2026-07-25 | Reader 紧尺寸行内公式 | 已先提交 `fca2c33`；reader 单行公式改用透明紧尺寸 PNG 与 Kitty 自然像素 `X/Y` placement，列宽先按单行垂直 fit，再在 floor/ceil 间选择，额外缩小上限 8%，Agent/source-mask 路径保持单元格 placement；PNG cache v6；新增 geometry/Kitty/renderer/layout 回归。首次全量中的独立 file-watch 用例超时，单测与随后全量重跑均通过：32 files passed；493 passed；1 expected fail；build 与 `git diff --check` 通过 |
| 2026-07-25 | README 双语同步 | 更新 `README.md`、`README.zh-CN.md`：PDF/OCR 数学边界恢复、HTML 实体、混合图片段落、表格换行、独立单美元公式、紧尺寸透明 PNG、Kitty `X/Y`、floor/ceil 8% 限制、CJK 换行、缓存及整数单元格限制；仅文档变更，双语内容对照检查，`git diff --check` 通过 |
| 2026-07-25 | npm `0.2.1` 发布 | `npm run check`：32 files passed；493 passed；1 expected fail；`npm pack --dry-run`：87 files、230.6 kB、无意外文件；发布级浏览器二次验证后 registry 核验 `tformula@0.2.1`，`latest=0.2.1`，shasum `25c8bc5bbab5ec77a99426acdf83d7b27ce2b20d` |

---

## 10. 变更记录要求

后续每批必须在此追加：

```text
日期：
执行项 ID：
状态变化：
修改文件：
新增/修改测试：
完整验证结果：
遗留问题：
下一执行项：
```
