# Obsidian 选择器映射表（一期稳定样式契约）

状态：工单 #6 交付物，2026-09-23；#8 补 span 级映射与阅读语义标签结构（2026-09-24）；#9 补任务勾选交互类（2026-09-24）；#10 补链接/图片映射（2026-09-24）；#12 补表格映射（2026-09-24）。依据 [ADR-0004](../adr/0004-stable-styling-contract.md)。

本文记录一期已建立的稳定类名/CSS 变量入口与 Obsidian 同款选择器的核对结果，供二期自定义 CSS 片段兼容使用。**边界声明**：

- 一期只用仓库内测试 CSS 片段（`media/css-contract-probe.css`）验证入口可用，**不提供用户 CSS 加载界面**（二期实现配置、加载、作用域与优先级）。
- 映射表只声明**已核对并验证**的项；未列出的 Obsidian 选择器一律视为未兼容，不假称整体兼容。
- 不兼容 Obsidian 应用级 DOM（工作区布局、侧栏、标签页等核心结构）与第三方插件私有 DOM。

## 容器与视图入口

| 本项目稳定类名 | 本项目用途 | Obsidian 对应选择器 | 核对结果 |
| --- | --- | --- | --- |
| `.oile-view-live` | live（实时预览）视图容器，内含 CodeMirror 6 | `.markdown-source-view.mod-cm6`（编辑区容器）、`.cm-s-obsidian`（CM 主题容器） | 语义等价：均为"live 编辑视图容器"。本项目 webview 内只有一个编辑器，无 Obsidian 的多面板层级 |
| `.oile-view-reading` | reading（阅读）视图容器 | `.markdown-preview-view`（阅读视图容器） | 已验证：测试片段经该类设置/读取探针变量（`--oile-probe-var-reading: contract-ok`） |

## 标题（#5 装饰类，live 视图；#8 补 span 级）

| 本项目稳定类名 | Obsidian 对应选择器 | 核对结果 |
| --- | --- | --- |
| `.oile-heading-line-{1..6}`（挂在 `.cm-line` 行元素上） | `.HyperMD-header-{1..6}`（Obsidian live 的标题**行容器**类） | 语义等价（行级）。已验证：测试片段经 `.oile-heading-line-1` 修改 `text-decoration-color` 生效 |
| `.oile-header-{1..6}`（#8：标题**内容 span**，mark 装饰） | `.cm-header-{1..6}`（Obsidian live 的标题行内 token 类） | 语义等价（span 级）。#8 起提供；类名保持 `oile-` 前缀，Obsidian 片段按原名定位不命中（经映射垫片兼容属二期） |
| `.oile-heading-inview` / `.oile-heading-active` | 无直接对应（Obsidian 无活动行标题源码态类；其等价行为由 `.cm-active` 相关规则承担） | 本项目自有扩展：视口内强调与"光标所在行显示源码"提示 |

## live 视图行内与块级语法（#8 新增）

#8 起 live 视图的覆盖语法由解析树驱动（`@codemirror/lang-markdown` 的 `markdownLanguage` 解析器，GFM 含任务列表），非活动行隐藏标记、活动行显示源码（#5 选区联动语义）。以下 span 级行级类均为稳定样式入口：

| 本项目稳定类名 | 本项目用途 | Obsidian 对应选择器 | 核对结果 |
| --- | --- | --- | --- |
| `.oile-strong` | 粗体内容 span | `.cm-strong` | 语义等价。已验证：测试片段经 `.oile-strong` 命中（`text-decoration-color: rgb(7, 8, 9)`，真实宿主断言） |
| `.oile-emphasis` | 斜体内容 span | `.cm-emphasis` | 语义等价（类名不同，片段按 `cm-` 原名定位不命中） |
| `.oile-inline-code` | 行内代码内容 span | `.cm-inline-code`（Obsidian 亦用 `.cm-hmd-inline-code`） | 语义等价。已验证：测试片段经 `.oile-inline-code` 命中 |
| `.oile-code-line` | 围栏/缩进代码**行**（含围栏标记行） | `.HyperMD-codeblock`（Obsidian 代码块行类族） | 行级语义等价。已验证：测试片段经 `.oile-code-line` 命中 |
| `.oile-quote-line` | 引用行 | `.HyperMD-quote`（Obsidian 引用行类）/ `.cm-quote` | 语义等价（行级；本项目无 span 级引用 token 类——引用内容不额外 span 化） |
| `.oile-list-line`（+ `-d{1..8}` 嵌套深度修饰） | 列表项行 | `.HyperMD-list-line`（Obsidian 列表行类族）/ `.cm-list-number` 等修饰 | 行级语义对应；深度修饰为本项目自有形态（Obsidian 按行 class 组合表达缩进，结构不同但等价定位） |
| `.oile-list-bullet` / `.oile-list-ordered` | 无序/有序列表行修饰（无序标记隐藏后以 `::before` 圆点呈现；有序编号保留可见） | 无直接对应（Obsidian 圆点由 `.cm-formatting-list` 隐藏 + 原生列表样式承担） | 本项目自有呈现形态 |
| `.oile-task-checkbox`（+ `.oile-task-checked` 修饰；`input[type=checkbox]`） | 任务 checkbox（#9：替换 #8 的只读字形，可交互——点击/Enter/空格切换勾选态并写回 Markdown） | `.cm-task-*` 方向（Obsidian 任务标记由 HMR widget 承担） | 本项目自有 widget；勾选态双入口（`:checked` 伪类与 `.oile-task-checked` 类）。已验证：测试片段经 `.oile-task-checkbox` 命中（真实宿主断言） |
| `.oile-hr-line` | 水平线行 | `.cm-hr`（Obsidian 水平线 token 类） | 语义等价（行级呈现，`---` 源文保留可见） |
| `.oile-frontmatter-line` | frontmatter 行（头块按源码呈现、语法不解析） | `.cm-hmd-frontmatter`（Obsidian frontmatter 类） | 语义对应（类名不同）；frontmatter 边界由 `markdownDoc.frontmatterRange` 两视图共用判定 |

## 表格（#12 新增）

#12 起 live 视图对表格行建立装饰。**形态声明**：编辑面即 CM6 源文本行——管道符**保持可见**（点击定位与光标编辑直接落在源区间，无覆盖层/整表控件），装饰只做样式标记；单元格边界按 GFM 语义自研拆分（`\|` 与行内代码内的 `|` 不切分，见 `src/webview/tableCells.ts`），lezer 的 TableCell 节点不作定位依据。单元格内键入 `|` 自动写为 `\|`（输入钩子，经 CM6 事务走标准出站链路）。

| 本项目稳定类名 | 本项目用途 | Obsidian 对应选择器 | 核对结果 |
| --- | --- | --- | --- |
| `.oile-table-line` | 表格行（表头/分隔/数据行通用） | `.HyperMD-table-line` 方向（Obsidian live 表格行类族；其 1.5 前源码形态同源文） | 语义对应（行级）；本项目管道符可见的源码形态为自有取舍 |
| `.oile-table-header-line` / `.oile-table-delimiter-line` | 表头行 / 分隔行修饰 | 无直接对应（Obsidian 以 thead 样式承担） | 本项目自有修饰形态 |
| `.oile-table-cell`（+ `-header` 修饰） | 单元格内容 span（trim 后区间） | `.cm-table-cell` 方向（社区主题常用） | 语义等价（span 级）；GFM 拆分语义自研 |
| `.oile-table-pipe` | 管道符 span（含首尾边界管道） | 无对应（Obsidian 隐藏或原样呈现管道） | 本项目自有形态；保持占位不隐藏 |
| `.oile-table-align-{left/center/right}` | 分隔行声明的列对齐修饰 | 无对应（对齐由渲染布局承担） | 本项目自有：live 源码形态不重排（类为样式入口），对齐视觉语义由阅读视图承担 |

## 阅读视图块级结构（#6 结构 + #8 markdown-it 语义内容）

阅读容器内每个内容块为 `div.oile-reading-block` + 细分类，并携带源位置锚点属性 `data-oile-src-start` / `data-oile-src-end`（LF 全文 UTF-16 offset，与消息协议坐标同构；#7 按需挂载与 #9 任务定位依赖）。

**#8 语义升级**：块内容改由 markdown-it 渲染（`html:false` + DOM 纵深净化），块内是**真实语义标签**（`h1..h6`、`p`、`blockquote`、`ul`/`ol`/`li`、`pre`/`code`、`em`/`strong`、`hr`、`a`）——Obsidian 片段中以**标签选择器**定位阅读内容的规则（如 `.markdown-preview-view p`）改为命中块内标签（本项目为 div 包裹 + 内层标签的结构，`.oile-reading-block p` 命中）。列表为整块（内含 `ul > li` 嵌套结构，li 另带自身源锚点）；大围栏（超过 60 行）按行细分为多个连续 `code-block` 块。

**#7 按需挂载后的结构变化**：阅读容器不再常驻全部块元素——只挂载视口及缓冲窗口内的块，窗口外的屏外内容以两个占位 spacer（`div.oile-reading-spacer`、`-top`/`-bottom` 修饰）承载高度估计。块级类名与锚点属性不变，但依赖"全文 DOM 常驻"的片段（全局 `:nth-child` 定位、跨屏兄弟选择器、对完整滚动高度的假设）不再成立；spacer 为本项目自有结构，Obsidian 无对应选择器，不参与兼容承诺。

| 本项目稳定类名 | 本项目用途 | Obsidian 对应选择器 | 核对结果 |
| --- | --- | --- | --- |
| `.oile-reading-heading-{1..6}` | 阅读标题块（内含语义 `h{n}` 标签） | `.markdown-preview-view h{1..6}` | 双入口命中：块类 + 内层标签。已验证：测试片段经 `.oile-reading-heading-1` 命中 |
| `.oile-reading-paragraph` | 阅读段落块（内含 `p`） | `.markdown-preview-view p` | 类等价 + 标签等价（内层真实 `p`） |
| `.oile-reading-blockquote` | 引用块（内含 `blockquote`） | `.markdown-preview-view blockquote` | 类等价 + 标签等价（#8 新增） |
| `.oile-reading-list` | 列表块（内含 `ul`/`ol`/`li` 嵌套，`li` 带源锚点） | `.markdown-preview-view ul` / `ol` / `li` | 类等价 + 结构等价（#8 起还原嵌套；#6 时为逐行平铺） |
| `li.oile-reading-task`（li 级） | 任务列表项 | `.markdown-preview-view .task-list-item` | 类等价（#8 起挂在语义 `li` 上）；`data-task` 扩展勾选状态（`[/]`、`[!]` 等）不支持 |
| `.oile-reading-task-checkbox` | 任务复选框（`input[type=checkbox]`，#9 起启用：点击/键盘切换并写回） | `.markdown-preview-view .task-list-item input[type="checkbox"]` | 结构等价。已验证：测试片段经 `.oile-reading-task-checkbox` 命中（真实宿主断言） |
| `.oile-reading-code-block` | 围栏/缩进代码块（内含 `pre > code`；大围栏按行细分为多块） | `.markdown-preview-view pre` | 类等价 + 标签等价（#8 起内容不含围栏标记文本；`code` 带语言类 `language-x` 供后续高亮） |
| `.oile-reading-hr` | 水平线块（内含 `hr`） | `.markdown-preview-view hr` | 类等价 + 标签等价（#8 新增） |
| `.oile-reading-table` | 表格块（#12：内含 markdown-it 渲染的真实 `table`/`thead`/`tbody`，GFM 列对齐保留在 `th`/`td` 内联 style；只读呈现） | `.markdown-preview-view table` | 类等价 + 标签等价（#12 起独立成块；此前 #8 已按 paragraph 块渲染 table 标签） |
| `.oile-reading-frontmatter` | frontmatter 头块（源码呈现，内部 `pre.oile-reading-frontmatter-text`） | `.markdown-preview-view .markdown-frontmatter` | 语义对应（类名不同）；头块内语法不解析（两视图共用边界判定） |
| `.oile-reading-spacer`（`-top` / `-bottom`） | #7 视口占位：屏外块的高度占位（非内容节点，高度为块高度表前后缀和） | 无对应（Obsidian 虚拟化由内部机制承担） | 本项目自有结构，不参与兼容承诺；出现在片段中不影响内容块定位 |

阅读行内格式（`em`/`strong`/`code`/`a`）为 markdown-it 渲染的语义标签，与 Obsidian 阅读视图同形态（`.markdown-preview-view strong` 等标签选择器可命中；本项目片段经 `.oile-reading-block strong` 定位亦命中，已验证探针 `rgb(16, 17, 18)`）。

## 链接与图片（#10）

#10 起两种视图贯通链接点击与图片显示。链接跳转执行归宿主（webview 只上报意图：阅读单击、live Ctrl/Cmd+单击）；图片为双视图共用的生命周期状态机（`loading`/`loaded`/`error` 三态，`error` 态点击可重试）。

| 本项目稳定类名 | 本项目用途 | Obsidian 对应选择器 | 核对结果 |
| --- | --- | --- | --- |
| `.oile-link`（live，mark span） | 链接**内容** span（活动与非活动行都标记；非活动行隐藏 `](url)` 尾部，活动行显示源码） | `.cm-link`（Obsidian 链接内容 token） | 语义等价（span 级）。已验证：测试片段经 `.oile-link` 命中（`rgb(19, 20, 21)`，真实宿主断言）。隐藏的 `](url)` 尾部对应 Obsidian `.cm-formatting-link` / `.cm-string.cm-url` 方向——本项目以隐藏呈现，无独立样式类 |
| 阅读链接（无自有类） | markdown-it 渲染的语义 `<a>` | `.markdown-preview-view a` | 标签等价。已验证：探针 `rgb(22, 23, 24)`。单击经容器级委托上报 `link.activate`（`preventDefault`，不做 webview 原生导航） |
| `.oile-image`（双视图） | 图片槽位基类：阅读视图为 `<img>` 元素本体；live 视图为 widget 容器 `span`（内部 `<img>` 由资源管理器装载） | `.markdown-preview-view img`（阅读）/ `.cm-image`（live 方向） | 阅读侧标签等价 + 类命中（探针 `rgb(25, 26, 27)`）；live 侧为本项目自有 widget 形态（Obsidian 图片 widget 无公开稳定类） |
| `.oile-image-loading` / `.oile-image-loaded` / `.oile-image-error`（状态修饰，与 `data-oile-img-state` 同步） | 图片三态：占位（alt 文本）/ 已加载（`img load` 事件确认）/ 失败（点击重试） | 无直接对应（Obsidian 无公开加载状态类） | 本项目自有状态机形态；`oile-image-error` 提供可重试的可见错误轮廓 |

行为边界（非样式映射，随 #10 记录）：

- live 视图链接为**间接装饰**（按 `visibleRanges` 构建）：视口外的链接行按源码呈现，滚动进入视口后应用装饰；阅读视图链接在挂载块内（虚拟化窗口外无 DOM）。
- 图片进入视口（阅读块挂载 / live widget 创建）才发起装载；工作区图源经宿主 `image.request` → `asWebviewUri` 通道解析（本地与远程工作区同通道），`https` 图源直连（可加载性由 webview CSP 决定）。离开视口卸载并释放（`src` 清空、资源条目回收）。
- 引用式链接/图片（`[t][ref]`）：**阅读视图**由 markdown-it 完整解析（可点击）；**live 视图**不解析引用定义、按源码呈现（Ctrl+单击不跳转）——跨视图行为差异如实记录，统一收口属后续工单。

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
| `--oile-table-background` | `rgba(128, 128, 128, 0.05)` | live 表格行背景 / 阅读表头背景（#12） | `--table-background`（语义对应，名称不同） |

变量名**不与 Obsidian 原名对齐**（加 `oile-` 前缀避免与宿主 VSCode 变量冲突）；二期若需要按 Obsidian 变量名片段兼容，经映射垫片（alias）实现，不在一期承诺内。

## 内部测试 CSS 验证入口

- 片段：`media/css-contract-probe.css`，随 webview HTML 加载（CSP `style-src` 允许的扩展资源）。仅用无视觉影响的属性（`text-decoration-color`，在无 `text-decoration-line` 时不呈现）与探针变量。#8 追加 span 级类与阅读语义标签的探针规则（`.oile-strong`/`.oile-inline-code`/`.oile-code-line`/`.oile-reading-block strong`）；#9 追加任务 checkbox 探针规则（`.oile-task-checkbox`/`.oile-reading-task-checkbox`）；#10 追加链接/图片探针规则（`.oile-link`/`.oile-reading-block a`/`.oile-reading-block img.oile-image`）；#12 追加表格探针规则（`.oile-table-pipe`/`.oile-reading-block table`）。
- 观测：`view.state` 回报的 `cssProbe` 字段（`liveHeadingDecorationColor` / `readingHeadingDecorationColor` / `readingVarProbe`；#8 追加 `liveStrongDecorationColor` / `liveInlineCodeDecorationColor` / `liveCodeLineDecorationColor` / `readingStrongDecorationColor`；#9 追加 `liveTaskCheckboxDecorationColor` / `readingTaskCheckboxDecorationColor`；#10 追加 `liveLinkDecorationColor` / `readingLinkDecorationColor` / `readingImageDecorationColor`；#12 追加 `liveTablePipeDecorationColor` / `readingTableDecorationColor`），由 webview 读取目标元素 computed style 填充；目标元素不存在时为 `null`。
- 断言：集成用例「稳定样式契约」（`test/integration/suite/cases.ts`）在真实 VSCode 1.86.2 宿主内验证两种视图的类名命中与变量管道；#12 表格断言并入「表格装饰与单元格编辑写回」「阅读视图表格」用例。

## 已知不支持项（如实清单）

以下 Obsidian 常用选择器/结构**一期不提供**，出现在用户片段中不会命中（不会报错，也不会生效）：

- ~~行内格式 token：`.cm-strong` / `.cm-emphasis` / `.cm-inline-code`~~（#8 已建立 `oile-` 对应类，见上文 live 表；~~`.cm-link` 待 #10 链接票~~ 已建立 `.oile-link`；`.cm-highlight` 高亮 `==文字==` 仍不支持）
- ~~表格：`.markdown-preview-view table` 及其子结构~~（#12 已建立：阅读侧 `.oile-reading-table` + 真实 `table` 标签，live 侧 `.oile-table-line`/`.oile-table-cell` 族，见上文两节。**跨视图差异如实记录**：markdown-it 不识别行内代码内的 `|`，含该形态的表格在阅读视图错切或降级为段落，live 侧按 GFM 规范正确拆分——偏差与修复成本见 docs/perf/2026-09-table-cell-editing.md「已知限制」）
- ~~键盘导航/增删行列的表格交互结构~~（#13 范围，一期未提供；单元格编辑语义为「光标落源区间直编」）
- 引用块：~~`.markdown-embed` / `blockquote` 结构~~（#8 已提供 blockquote；`.markdown-embed` 嵌入结构仍属二期）
- Callout：`.callout` 及其 data 属性（二期）
- 任务扩展状态：`.task-list-item[data-task="x"]` 等（仅支持空格/`x`/`X` 三态，#9）
- frontmatter：~~`.markdown-frontmatter`~~（#8 已按源码形态呈现；Obsidian 属性面板形态不在一期）
- 标签/双链：`.cm-hashtag` / `.cm-hmd-internal-link` / `.internal-link`（#11 双链票）
- 语法高亮 token：`.token-*` / HyperMD codeblock 行内高亮 `.HyperMD-codeblock-*`（`language-x` 类已就位，高亮 token 属后续扩展）
- 删除线：`.cm-strikethrough` / 阅读视图 `del`（解析器支持但一期未装饰——如实记录，待后续补齐）
- 虚拟化结构差异（#7 已生效）：阅读视图视口外块不存在于 DOM——依赖"全文 DOM 常驻"的片段（全局 `:nth-child` 定位、跨屏兄弟/后代选择器、假设完整内容高度的滚动条计算）与按需挂载冲突；正文块结构见上文 #7 说明

## 核对来源

- Obsidian 官方帮助（CSS snippets 格式参考）：https://obsidian.md/help/snippets
- 社区实际片段与论坛讨论中确认的选择器族（`.markdown-preview-view` 系、`.HyperMD-header-N` 行级与 `.cm-header-N` span 级的分工、`.task-list-item` 系）：
  - [Live Preview: Style header font attributes? — Obsidian Forum](https://forum.obsidian.md/t/live-preview-style-header-font-attributes/32053)
  - [obsidian-css-snippets/Snippets/Headers.md — GitHub](https://github.com/Dmytro-Shulha/obsidian-css-snippets/blob/master/Snippets/Headers.md)
  - [Background formatting for text under a header — Obsidian Forum](https://forum.obsidian.md/t/background-formatting-for-the-text-under-a-header/47385)
  - [Obsidian custom checkbox snippet — GitHub Gist](https://gist.github.com)（`.task-list-item[data-task]` 用法）

> 来源链接为选择器**核对依据**，不证明本项目已具备对应兼容能力；能力范围以上表"核对结果"为准。
