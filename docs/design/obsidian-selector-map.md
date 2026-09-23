# Obsidian 选择器映射表（一期稳定样式契约）

状态：工单 #6 交付物，2026-09-23。依据 [ADR-0004](../adr/0004-stable-styling-contract.md)。

本文记录一期已建立的稳定类名/CSS 变量入口与 Obsidian 同款选择器的核对结果，供二期自定义 CSS 片段兼容使用。**边界声明**：

- 一期只用仓库内测试 CSS 片段（`media/css-contract-probe.css`）验证入口可用，**不提供用户 CSS 加载界面**（二期实现配置、加载、作用域与优先级）。
- 映射表只声明**已核对并验证**的项；未列出的 Obsidian 选择器一律视为未兼容，不假称整体兼容。
- 不兼容 Obsidian 应用级 DOM（工作区布局、侧栏、标签页等核心结构）与第三方插件私有 DOM。

## 容器与视图入口

| 本项目稳定类名 | 本项目用途 | Obsidian 对应选择器 | 核对结果 |
| --- | --- | --- | --- |
| `.oile-view-live` | live（实时预览）视图容器，内含 CodeMirror 6 | `.markdown-source-view.mod-cm6`（编辑区容器）、`.cm-s-obsidian`（CM 主题容器） | 语义等价：均为"live 编辑视图容器"。本项目 webview 内只有一个编辑器，无 Obsidian 的多面板层级 |
| `.oile-view-reading` | reading（阅读）视图容器 | `.markdown-preview-view`（阅读视图容器） | 已验证：测试片段经该类设置/读取探针变量（`--oile-probe-var-reading: contract-ok`） |

## 标题（#5 装饰类，live 视图）

| 本项目稳定类名 | Obsidian 对应选择器 | 核对结果 |
| --- | --- | --- |
| `.oile-heading-line-{1..6}`（挂在 `.cm-line` 行元素上） | `.HyperMD-header-{1..6}`（Obsidian live 的标题**行容器**类） | 语义等价（行级）。已验证：测试片段经 `.oile-heading-line-1` 修改 `text-decoration-color` 生效 |
| `.oile-heading-inview` / `.oile-heading-active` | 无直接对应（Obsidian 无活动行标题源码态类；其等价行为由 `.cm-active` 相关规则承担） | 本项目自有扩展：视口内强调与"光标所在行显示源码"提示 |
| —（未提供） | `.cm-header-{1..6}`（Obsidian live 的标题**行内 span** token 类） | **一期未提供**：行内格式化装饰（span 级）属 #8 完整双模式显示范围；届时补充 `oile-header-{n}` span 类并更新本表 |

## 阅读视图块级结构（#6 基础版段落级渲染）

阅读容器内每个内容块为 `div.oile-reading-block` + 细分类，并携带源位置锚点属性 `data-oile-src-start` / `data-oile-src-end`（LF 全文 UTF-16 offset，与消息协议坐标同构；#7 按需挂载与 #9 任务定位依赖）。

| 本项目稳定类名 | 本项目用途 | Obsidian 对应选择器 | 核对结果 |
| --- | --- | --- | --- |
| `.oile-reading-heading-{1..6}` | 阅读标题块 | `.markdown-preview-view h{1..6}` | 已验证：测试片段经 `.oile-reading-heading-1` 命中 |
| `.oile-reading-paragraph` | 阅读段落块 | `.markdown-preview-view p` | 结构等价（本项目为 div，不还原 Obsidian 的 p 元素标签本身——片段以类选择器定位时行为一致，以标签选择器（`p {}`）定位时不命中） |
| `.oile-reading-list-item` | 列表项块 | `.markdown-preview-view li` | 同上：类等价、标签不等价；且一期每个列表标记行独立成块，无 `ul`/`ol` 嵌套层级（Obsidian 片段中依赖 `ul > li` 结构选择器的规则不命中） |
| `.oile-reading-task` | 任务列表项块（附加在 list-item 上） | `.markdown-preview-view .task-list-item` | 类等价；`data-task` 扩展勾选状态（`[/]`、`[!]` 等）一期不支持 |
| `.oile-reading-task-checkbox` | 任务复选框（`input[type=checkbox]`，一期 disabled） | `.markdown-preview-view .task-list-item input[type="checkbox"]` | 结构等价；#9 实现勾选写回后启用 |
| `.oile-reading-code-block` | 围栏代码块（含围栏行整块） | `.markdown-preview-view pre` | 部分等价：一期整块渲染（含围栏标记文本），无内部 `code` 元素与语法高亮 token；#8 引入 markdown-it 后细分 |

## 悬浮提示等既有稳定类（沿用 #4/#5，与 Obsidian 无对应）

`.oile-suspend-banner`（冲突暂停横幅）、`.oile-toolbar` 与 `.oile-mode-toggle`（模式切换工具栏）：本项目自有 UI，无 Obsidian 对应物，不参与兼容承诺。

## 公开 CSS 变量

一期公开以下变量，外部片段可覆盖（定义于 `src/webview/main.css`）：

| 变量 | 默认值 | 用途 | Obsidian 对应变量 |
| --- | --- | --- | --- |
| `--oile-heading-accent` | `var(--vscode-textLink-foreground, #4fc1ff)` | live 视口内标题左缘强调色 | `--heading-accent`?（Obsidian 各主题变量名不一，无官方统一名） |
| `--oile-reading-font-size` | `15px` | 阅读正文字号 | `--font-text-size`（语义对应，名称不同） |
| `--oile-reading-max-width` | `760px` | 阅读块最大宽度 | `--file-line-width`（语义对应，名称不同） |
| `--oile-reading-line-height` | `1.6` | 阅读正文行高 | `--line-height-normal`（语义对应，名称不同） |
| `--oile-reading-code-background` | `var(--vscode-textCodeBlock-background, …)` | 代码块背景 | `--code-background`（语义对应，名称不同） |

变量名**不与 Obsidian 原名对齐**（加 `oile-` 前缀避免与宿主 VSCode 变量冲突）；二期若需要按 Obsidian 变量名片段兼容，经映射垫片（alias）实现，不在一期承诺内。

## 内部测试 CSS 验证入口

- 片段：`media/css-contract-probe.css`，随 webview HTML 加载（CSP `style-src` 允许的扩展资源）。仅用无视觉影响的属性（`text-decoration-color`，在无 `text-decoration-line` 时不呈现）与探针变量。
- 观测：`view.state` 回报的 `cssProbe` 字段（`liveHeadingDecorationColor` / `readingHeadingDecorationColor` / `readingVarProbe`），由 webview 读取目标元素 computed style 填充；目标元素不存在时为 `null`。
- 断言：集成用例「稳定样式契约」（`test/integration/suite/cases.ts`）在真实 VSCode 1.86.2 宿主内验证两种视图的类名命中与变量管道。

## 已知不支持项（如实清单）

以下 Obsidian 常用选择器/结构**一期不提供**，出现在用户片段中不会命中（不会报错，也不会生效）：

- 行内格式 token：`.cm-strong` / `.cm-emphasis` / `.cm-link` / `.cm-highlight` / `.cm-inline-code`（#8 行内装饰落地时建立）
- 表格：`.markdown-preview-view table` 及其子结构（#8/#9 表格票）
- 引用块：`.markdown-embed` / `blockquote` 结构（#8）
- Callout：`.callout` 及其 data 属性（二期）
- 任务扩展状态：`.task-list-item[data-task="x"]` 等（仅支持空格/`x`/`X` 三态，#9）
- frontmatter：`.markdown-frontmatter`（#8 及以后）
- 标签/双链：`.cm-hashtag` / `.cm-hmd-internal-link` / `.internal-link`（#8/#10 双链票）
- 语法高亮 token：`.token-*` / HyperMD codeblock 行类 `.HyperMD-codeblock-*`（#8）
- 虚拟化结构差异：#7 阅读按需挂载后，视口外块不存在于 DOM——依赖"全文 DOM 常驻"的片段（如全局 `:nth-child` 定位、跨屏滚动条计算）会与虚拟化冲突，届时在本表补充说明

## 核对来源

- Obsidian 官方帮助（CSS snippets 格式参考）：https://obsidian.md/help/snippets
- 社区实际片段与论坛讨论中确认的选择器族（`.markdown-preview-view` 系、`.HyperMD-header-N` 行级与 `.cm-header-N` span 级的分工、`.task-list-item` 系）：
  - [Live Preview: Style header font attributes? — Obsidian Forum](https://forum.obsidian.md/t/live-preview-style-header-font-attributes/32053)
  - [obsidian-css-snippets/Snippets/Headers.md — GitHub](https://github.com/Dmytro-Shulha/obsidian-css-snippets/blob/master/Snippets/Headers.md)
  - [Background formatting for text under a header — Obsidian Forum](https://forum.obsidian.md/t/background-formatting-for-the-text-under-a-header/47385)
  - [Obsidian custom checkbox snippet — GitHub Gist](https://gist.github.com)（`.task-list-item[data-task]` 用法）

> 来源链接为选择器**核对依据**，不证明本项目已具备对应兼容能力；能力范围以上表"核对结果"为准。
