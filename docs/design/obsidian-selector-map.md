# Obsidian 选择器映射表（一期稳定样式契约）

状态：工单 #6 交付物，2026-09-23；#8 补 span 级映射与阅读语义标签结构（2026-09-24）；#9 补任务勾选交互类（2026-09-24）；#10 补链接/图片映射（2026-09-24）；#12 补表格映射（2026-09-24）；#11 补双链映射（2026-09-24）；#42 补实时预览表格网格入口（2026-09-24）；#59 补公式映射（2026-09-25）；#60 补 Mermaid 图表映射（2026-09-25）。依据 [ADR-0004](../adr/0004-stable-styling-contract.md)。

本文记录一期已建立的稳定类名/CSS 变量入口与 Obsidian 同款选择器的核对结果，供二期自定义 CSS 片段兼容使用。**边界声明**：

- 一期只用仓库内测试 CSS 片段（`media/css-contract-probe.css`）验证入口可用，**不提供用户 CSS 加载界面**（二期实现配置、加载、作用域与优先级）。
- 映射表只声明**已核对并验证**的项；未列出的 Obsidian 选择器一律视为未兼容，不假称整体兼容。
- 不兼容 Obsidian 应用级 DOM（工作区布局、侧栏、标签页等核心结构）与第三方插件私有 DOM。

## 容器与视图入口

| 本项目稳定类名 | 本项目用途 | Obsidian 对应选择器 | 核对结果 |
| --- | --- | --- | --- |
| `.vsidian-view-live` | live（实时预览）视图容器，内含 CodeMirror 6 | `.markdown-source-view.mod-cm6`（编辑区容器）、`.cm-s-obsidian`（CM 主题容器） | 语义等价：均为"live 编辑视图容器"。本项目 webview 内只有一个编辑器，无 Obsidian 的多面板层级 |
| `.vsidian-view-reading` | reading（阅读）视图容器 | `.markdown-preview-view`（阅读视图容器） | 已验证：测试片段经该类设置/读取探针变量（`--vsidian-probe-var-reading: contract-ok`） |

## 标题（#5 装饰类，live 视图；#8 补 span 级）

| 本项目稳定类名 | Obsidian 对应选择器 | 核对结果 |
| --- | --- | --- |
| `.vsidian-heading-line-{1..6}`（挂在 `.cm-line` 行元素上） | `.HyperMD-header-{1..6}`（Obsidian live 的标题**行容器**类） | 语义等价（行级）。已验证：测试片段经 `.vsidian-heading-line-1` 修改 `text-decoration-color` 生效 |
| `.vsidian-header-{1..6}`（#8：标题**内容 span**，mark 装饰） | `.cm-header-{1..6}`（Obsidian live 的标题行内 token 类） | 语义等价（span 级）。#8 起提供；类名保持 `vsidian-` 前缀，Obsidian 片段按原名定位不命中（经映射垫片兼容属二期） |
| `.vsidian-heading-inview` / `.vsidian-heading-active` | 无直接对应（Obsidian 无活动行标题提示类） | 本项目自有扩展：视口内强调与光标所在标题行的强调提示；标题 `#` 在光标进入该标题行时显形 |

## live 视图行内与块级语法（#8 新增）

#8 起 live 视图的覆盖语法由解析树驱动（`@codemirror/lang-markdown` 的 `markdownLanguage` 解析器，GFM 含任务列表）。标记显形按各自语法范围判定：标题标记在对应标题范围内显形（Setext 标题包含正文和下划线行）；列表、引用的行首标记只在标记及相邻空格附近显形；粗斜体、行内代码在对应语法节点内显形；任务 checkbox 仅在光标进入 `[ ]` / `[x]` 标记时切回源码。同一行其他标记保持格式化形态。以下 span 级行级类均为稳定样式入口：

| 本项目稳定类名 | 本项目用途 | Obsidian 对应选择器 | 核对结果 |
| --- | --- | --- | --- |
| `.vsidian-strong` | 粗体内容 span | `.cm-strong` | 语义等价。已验证：测试片段经 `.vsidian-strong` 命中（`text-decoration-color: rgb(7, 8, 9)`，真实宿主断言） |
| `.vsidian-emphasis` | 斜体内容 span | `.cm-emphasis` | 语义等价（类名不同，片段按 `cm-` 原名定位不命中） |
| `.vsidian-inline-code` | 行内代码内容 span | `.cm-inline-code`（Obsidian 亦用 `.cm-hmd-inline-code`） | 语义等价。已验证：测试片段经 `.vsidian-inline-code` 命中 |
| `.vsidian-code-line` | 围栏/缩进代码**行**（含围栏标记行） | `.HyperMD-codeblock`（Obsidian 代码块行类族） | 行级语义等价。已验证：测试片段经 `.vsidian-code-line` 命中 |
| `.vsidian-quote-line` | 引用行 | `.HyperMD-quote`（Obsidian 引用行类）/ `.cm-quote` | 语义等价（行级；本项目无 span 级引用 token 类——引用内容不额外 span 化） |
| `.vsidian-list-line`（+ `-d{1..8}` 嵌套深度修饰） | 列表项行 | `.HyperMD-list-line`（Obsidian 列表行类族）/ `.cm-list-number` 等修饰 | 行级语义对应；深度修饰为本项目自有形态（Obsidian 按行 class 组合表达缩进，结构不同但等价定位） |
| `.vsidian-list-bullet` / `.vsidian-list-ordered` | 无序/有序列表行修饰（无序标记隐藏后以 `::before` 圆点呈现；有序编号保留可见） | 无直接对应（Obsidian 圆点由 `.cm-formatting-list` 隐藏 + 原生列表样式承担） | 本项目自有呈现形态 |
| `.vsidian-list-marker-visible` | 无序列表源码标记显形时抑制 `::before` 伪圆点，避免双圆点 | 无直接对应 | 本项目自有状态修饰类 |
| `.vsidian-task-checkbox`（+ `.vsidian-task-checked` 修饰；`input[type=checkbox]`） | 任务 checkbox（#9：替换 #8 的只读字形，可交互——点击/Enter/空格切换勾选态并写回 Markdown） | `.cm-task-*` 方向（Obsidian 任务标记由 HMR widget 承担） | 本项目自有 widget；勾选态双入口（`:checked` 伪类与 `.vsidian-task-checked` 类）。已验证：测试片段经 `.vsidian-task-checkbox` 命中（真实宿主断言） |
| `.vsidian-hr-line` | 水平线行 | `.cm-hr`（Obsidian 水平线 token 类） | 语义等价（行级呈现，`---` 源文保留可见） |
| `.vsidian-frontmatter-line` | frontmatter 行（头块按源码呈现、语法不解析） | `.cm-hmd-frontmatter`（Obsidian frontmatter 类） | 语义对应（类名不同）；frontmatter 边界由 `markdownDoc.frontmatterRange` 两视图共用判定 |

## 表格（#12 基础编辑，#42 网格呈现）

编辑面仍是 CM6 原文区间。#42 起安全表格始终用 CSS grid 呈现表头、单元格边框、等宽列与 GFM 对齐；光标进入格子后网格不撤下，直接在该格源区间输入，继续复用 CM6 的 IME、导航及宿主写回。网格状态隐藏管道符和分隔行；列数不一致等无法逐格映射的表格维持整表可编辑源码。单元格边界按 GFM 语义自研拆分（`\|` 与行内代码内的 `|` 不切分，尾边界管道符后的空白不新增单元格，见 `src/webview/tableCells.ts`），lezer 的 TableCell 节点不作定位依据。

| 本项目稳定类名 | 本项目用途 | Obsidian 对应选择器 | 核对结果 |
| --- | --- | --- | --- |
| `.vsidian-table-line` | 表格行（表头/分隔/数据行通用） | `.HyperMD-table-line` 方向（Obsidian live 表格行类族） | 语义对应（行级）；仅源码降级或活动分隔行显示管道符 |
| `.vsidian-table-header-line` / `.vsidian-table-delimiter-line` | 表头行 / 分隔行修饰 | 无直接对应（Obsidian 以 thead 样式承担） | 本项目自有修饰形态 |
| `.vsidian-table-cell`（+ `-header` 修饰） | 单元格内容 span（trim 后区间） | `.cm-table-cell` 方向（社区主题常用） | 语义等价（span 级）；GFM 拆分语义自研 |
| `.vsidian-table-pipe` | 管道符 span（含首尾边界管道） | 无对应（Obsidian 隐藏或原样呈现管道） | 本项目自有形态；网格状态隐藏，源码状态可见 |
| `.vsidian-table-align-{left/center/right}` | 分隔行声明的列对齐修饰（trim 后内容） | 无对应（对齐由渲染布局承担） | 本项目自有稳定类；网格实际布局由下项承担 |
| `.vsidian-table-grid-row` / `.vsidian-table-grid-cell` | 安全表格的网格行/单元格，活动格也保留；行附 `data-vsidian-table-row=header/row` 和 `--vsidian-table-columns` | Obsidian live 网格方向 | 本项目自有 CSS grid 结构；单元格仍与源区间对应，并非独立表格数据模型 |
| `.vsidian-table-grid-delimiter` / `.vsidian-table-grid-align-{left/center/right}` | 网格状态的分隔行隐藏与列对齐 | Obsidian 表格对齐方向 | 本项目自有修饰；活动分隔行回到源码 |
| `.vsidian-table-escaped-pipe` | 网格中隐藏转义管道符前的反斜杠 | 无直接对应 | 只改变显示，不改 Markdown 原文 |

## 阅读视图块级结构（#6 结构 + #8 markdown-it 语义内容）

阅读容器内每个内容块为 `div.vsidian-reading-block` + 细分类，并携带源位置锚点属性 `data-vsidian-src-start` / `data-vsidian-src-end`（LF 全文 UTF-16 offset，与消息协议坐标同构；#7 按需挂载与 #9 任务定位依赖）。

**#8 语义升级**：块内容改由 markdown-it 渲染（`html:false` + DOM 纵深净化），块内是**真实语义标签**（`h1..h6`、`p`、`blockquote`、`ul`/`ol`/`li`、`pre`/`code`、`em`/`strong`、`hr`、`a`）——Obsidian 片段中以**标签选择器**定位阅读内容的规则（如 `.markdown-preview-view p`）改为命中块内标签（本项目为 div 包裹 + 内层标签的结构，`.vsidian-reading-block p` 命中）。列表为整块（内含 `ul > li` 嵌套结构，li 另带自身源锚点）；大围栏（超过 60 行）按行细分为多个连续 `code-block` 块。

**#7 按需挂载后的结构变化**：阅读容器不再常驻全部块元素——只挂载视口及缓冲窗口内的块，窗口外的屏外内容以两个占位 spacer（`div.vsidian-reading-spacer`、`-top`/`-bottom` 修饰）承载高度估计。块级类名与锚点属性不变，但依赖"全文 DOM 常驻"的片段（全局 `:nth-child` 定位、跨屏兄弟选择器、对完整滚动高度的假设）不再成立；spacer 为本项目自有结构，Obsidian 无对应选择器，不参与兼容承诺。

| 本项目稳定类名 | 本项目用途 | Obsidian 对应选择器 | 核对结果 |
| --- | --- | --- | --- |
| `.vsidian-reading-heading-{1..6}` | 阅读标题块（内含语义 `h{n}` 标签） | `.markdown-preview-view h{1..6}` | 双入口命中：块类 + 内层标签。已验证：测试片段经 `.vsidian-reading-heading-1` 命中 |
| `.vsidian-reading-paragraph` | 阅读段落块（内含 `p`） | `.markdown-preview-view p` | 类等价 + 标签等价（内层真实 `p`） |
| `.vsidian-reading-blockquote` | 引用块（内含 `blockquote`） | `.markdown-preview-view blockquote` | 类等价 + 标签等价（#8 新增） |
| `.vsidian-reading-list` | 列表块（内含 `ul`/`ol`/`li` 嵌套，`li` 带源锚点） | `.markdown-preview-view ul` / `ol` / `li` | 类等价 + 结构等价（#8 起还原嵌套；#6 时为逐行平铺） |
| `li.vsidian-reading-task`（li 级） | 任务列表项 | `.markdown-preview-view .task-list-item` | 类等价（#8 起挂在语义 `li` 上）；`data-task` 扩展勾选状态（`[/]`、`[!]` 等）不支持 |
| `.vsidian-reading-task-checkbox` | 任务复选框（`input[type=checkbox]`，#9 起启用：点击/键盘切换并写回） | `.markdown-preview-view .task-list-item input[type="checkbox"]` | 结构等价。已验证：测试片段经 `.vsidian-reading-task-checkbox` 命中（真实宿主断言） |
| `.vsidian-reading-code-block` | 围栏/缩进代码块（内含 `pre > code`；大围栏按行细分为多块） | `.markdown-preview-view pre` | 类等价 + 标签等价（#8 起内容不含围栏标记文本；`code` 带语言类 `language-x` 供后续高亮） |
| `.vsidian-reading-hr` | 水平线块（内含 `hr`） | `.markdown-preview-view hr` | 类等价 + 标签等价（#8 新增） |
| `.vsidian-reading-table` | 表格块（#12：内含 markdown-it 渲染的真实 `table`/`thead`/`tbody`，GFM 列对齐保留在 `th`/`td` 内联 style；只读呈现） | `.markdown-preview-view table` | 类等价 + 标签等价（#12 起独立成块；此前 #8 已按 paragraph 块渲染 table 标签） |
| `.vsidian-reading-frontmatter` | frontmatter 头块（源码呈现，内部 `pre.vsidian-reading-frontmatter-text`） | `.markdown-preview-view .markdown-frontmatter` | 语义对应（类名不同）；头块内语法不解析（两视图共用边界判定） |
| `.vsidian-reading-spacer`（`-top` / `-bottom`） | #7 视口占位：屏外块的高度占位（非内容节点，高度为块高度表前后缀和） | 无对应（Obsidian 虚拟化由内部机制承担） | 本项目自有结构，不参与兼容承诺；出现在片段中不影响内容块定位 |

阅读行内格式（`em`/`strong`/`code`/`a`）为 markdown-it 渲染的语义标签，与 Obsidian 阅读视图同形态（`.markdown-preview-view strong` 等标签选择器可命中；本项目片段经 `.vsidian-reading-block strong` 定位亦命中，已验证探针 `rgb(16, 17, 18)`）。

## 链接与图片（#10）

#10 起两种视图贯通链接点击与图片显示。链接跳转执行归宿主（webview 只上报意图：阅读单击；live 已渲染链接单击、源码态 Ctrl/Cmd+单击）；图片为双视图共用的生命周期状态机（`loading`/`loaded`/`error` 三态，`error` 态点击可重试）。

| 本项目稳定类名 | 本项目用途 | Obsidian 对应选择器 | 核对结果 |
| --- | --- | --- | --- |
| `.vsidian-link`（live，mark span） | 链接**内容** span（始终标记；光标或选区进入该链接范围时显示 `[` 和 `](url)` 源码，同一行其他链接保持格式化） | `.cm-link`（Obsidian 链接内容 token） | 语义等价（span 级）。已验证：测试片段经 `.vsidian-link` 命中（`rgb(19, 20, 21)`，真实宿主断言）。隐藏的 `](url)` 尾部对应 Obsidian `.cm-formatting-link` / `.cm-string.cm-url` 方向——本项目以隐藏呈现，无独立样式类 |
| 阅读链接（无自有类） | markdown-it 渲染的语义 `<a>` | `.markdown-preview-view a` | 标签等价。已验证：探针 `rgb(22, 23, 24)`。单击经容器级委托上报 `link.activate`（`preventDefault`，不做 webview 原生导航） |
| `.vsidian-image`（双视图） | 图片槽位基类：阅读视图为 `<img>` 元素本体；live 视图为 widget 容器 `span`（内部 `<img>` 由资源管理器装载） | `.markdown-preview-view img`（阅读）/ `.cm-image`（live 方向） | 阅读侧标签等价 + 类命中（探针 `rgb(25, 26, 27)`）；live 侧为本项目自有 widget 形态（Obsidian 图片 widget 无公开稳定类） |
| `.vsidian-image-loading` / `.vsidian-image-loaded` / `.vsidian-image-error`（状态修饰，与 `data-vsidian-img-state` 同步） | 图片三态：占位（alt 文本）/ 已加载（`img load` 事件确认）/ 失败（点击重试） | 无直接对应（Obsidian 无公开加载状态类） | 本项目自有状态机形态；`vsidian-image-error` 提供可重试的可见错误轮廓 |

行为边界（非样式映射，随 #10 记录）：

- live 视图链接为**间接装饰**（按 `visibleRanges` 构建）：视口外的链接行按源码呈现，滚动进入视口后应用装饰；阅读视图链接在挂载块内（虚拟化窗口外无 DOM）。
- 图片进入视口（阅读块挂载 / live widget 创建）才发起装载；工作区图源经宿主 `image.request` → `asWebviewUri` 通道解析（本地与远程工作区同通道），`https` 图源直连（可加载性由 webview CSP 决定）。离开视口卸载并释放（`src` 清空、资源条目回收）。
- 引用式链接/图片（`[t][ref]`）：**阅读视图**由 markdown-it 完整解析（可点击）；**live 视图**不解析引用定义、按源码呈现（Ctrl+单击不跳转）——跨视图行为差异如实记录，统一收口属后续工单。

## 双链（#11）

#11 起两种视图贯通双链显示与跳转（ADR-0002：按需 `workspace.findFiles` 解析，不建持久索引、不自动创建文件）。**形态声明**：支持 `[[笔记]]`、`[[目录/笔记]]`、`[[笔记|显示文字]]`、`[[笔记#标题]]` 及组合；块引用 `[[笔记^块]]`、嵌入 `![[…]]` 与残缺形态按**原文**显示（源码保真降级，源文不改写）。live 视图仅在光标进入该双链范围时显示源码，范围外整体替换为显示文字（别名或链接名）；跳转执行归宿主（webview 只上报 `wikilink.activate`：阅读单击，live 已渲染双链单击、源码态 Ctrl/Cmd+单击）。重名候选经 QuickPick 由用户选择；无工作区、缺失目标给可见反馈。

| 本项目稳定类名 | 本项目用途 | Obsidian 对应选择器 | 核对结果 |
| --- | --- | --- | --- |
| `.vsidian-wikilink`（live） | 双链呈现：光标在该双链范围外时为显示文字 widget（替换整个 `[[…]]`），进入范围后为源码 mark | `.cm-hmd-internal-link`（Obsidian live 内链 token 类族） | 语义等价（呈现级）。已验证：测试片段经 `.vsidian-wikilink` 命中（`rgb(28, 29, 30)`，真实宿主断言）。Obsidian 另有 `.cm-hmd-internal-link` 拆分形态（链接名/别名/格式化括号），本项目整体替换、无拆分类 |
| `a.vsidian-wikilink`（阅读） | markdown-it 双链规则渲染的语义 `<a>`（`href` 为原文 target，显示别名或链接名） | `.markdown-preview-view a.internal-link`（Obsidian 阅读内链类） | 语义等价（标签 + 类）。已验证：探针 `rgb(31, 32, 33)`。单击经容器级委托上报 `wikilink.activate`（`preventDefault`） |
| 无对应（`.cm-hashtag` 方向） | 标签 `#tag` | `.cm-hashtag` / `.tag` | **不支持**（一期未实现标签语法；如实列入不支持清单） |

行为边界（非样式映射，随 #11 记录）：

- live 双链为**间接装饰**（按 `visibleRanges` 行扫描构建，与链接同一 ViewPlugin）：视口外按源码呈现；围栏/缩进/行内代码与 frontmatter 内不装饰（语法树 + fm 边界判定，与 #8 降级边界一致）。扫描形态学与阅读渲染、宿主解析共用 `src/shared/wikilink.ts`（三处语义逐字节一致）。
- 标题跳转定位双路径：目标已是本扩展面板时 reveal 面板后 `view.locate`（reading 经 #14 块挂载定位，屏外标题可定位；live 光标+滚动）；否则文本编辑器以标题行 selection reveal。标题匹配规则（ATX、trim + 空白折叠 + 大小写不敏感、跳过围栏内伪标题）写入单测固定。
- 文件路径大小写语义随宿主平台：Windows 本地不敏感（NTFS）、远程 POSIX 严格（两类不混用）；显式路径双候选（文档相对/工作区相对）命中不同文件时必须用户选择，不静默任选（规则见 `src/host/wikilinkTarget.ts` 与其单测）。

## 公式（#59）

#59 起两种视图渲染 LaTeX 公式（KaTeX 0.16.47 vendored，与 VSCode 内置 Markdown 数学同源的 @vscode/markdown-it-katex 判定语义）。**形态声明**：行内 `$…$`（贴字规则：开 `$` 左侧不得是词字符/`$`/`\`，闭 `$` 右侧同理）、段内与行首 `$$…$$`（displayMode）。普通美元（`$5`）、转义 `\$`、行内代码/围栏代码内不误判；解析失败按**原文**降级（`vsidian-math-error`，源文不丢、邻近内容不受影响）。live 视图光标进入公式范围显源码（`vsidian-math-source`），离开恢复 KaTeX 排版；渲染结果与装饰实例按公式源文 LRU 缓存。

| 本项目稳定类名 | 本项目用途 | Obsidian 对应选择器 | 核对结果 |
| --- | --- | --- | --- |
| `.vsidian-math`（live） | 行内公式渲染态 widget 外层（内含 KaTeX `.katex` 结构）；颜色继承编辑器前景 | `.cm-math`（Obsidian live 数学 token） | 语义等价（呈现级）。已验证：集成 `paint.math.visible`（绘制层命中）与 `cssProbe.liveMathFontFamily`（含 KaTeX 字体族）。Obsidian 拆分 `.cm-math-begin/end` 定界符类，本项目整体替换、无拆分类 |
| `.vsidian-math-block`（live） | 块级公式（`$$…$$`）渲染态变体：独立成块、居中、横向滚动 | `.HyperMD-math`（块级数学行）方向 | 语义等价（块级布局）。断言：CSS 契约（`mathPaintCssContract.test.ts`）钉 `display:block` + `text-align:center` + `overflow-x:auto` |
| `.vsidian-math-source`（live） | 光标进入公式范围后的源码显形 mark（等宽着色 + 浅底） | `.cm-hmd-math-begin` 编辑态方向 | 语义等价（编辑态）。CSS 契约钉 `--vscode-textPreformat-foreground` 着色 |
| `.katex-block` 内 `.vsidian-math`（阅读） | markdown-it-katex 渲染的 display 容器（`<p class="katex-block">` 包 KaTeX `.katex-display`） | `.markdown-preview-view .math-block` | 语义等价（块级标签）。断言：`cssProbe.readingMathFontFamily` 含 KaTeX 字体族 |
| `.vsidian-math-error`（两视图共用） | 解析失败的原文降级 span：错误色 + 浅红底 + 等宽字体，原文完整可读 | `.math-error` / `.katex-error` 方向 | 语义等价（降级态）。CSS 契约钉错误色变量 |

行为边界（非样式映射，随 #59 记录）：

- 形态学单一事实源 `src/shared/math.ts`（live 行扫描），阅读侧为 @vscode/markdown-it-katex 插件规则——两处判定逐条对齐（贴字/转义/空内容/`$$` 优先/反引号 span 排除），已知差异（跨行行内公式、块中段混围栏）记录于 `docs/perf/2026-09-math-rendering.md`，降级方向均为 live 显源码。
- 跨行 `$$` 块表由 StateField 增量维护（docChanged 时种子重扫，选区移动零成本）；跨行 replace 装饰走 StateField（CM6 约束），widget DOM 按视口惰性。
- 阅读侧 `$$` 块独立成块（`vsidian-reading-math` 块类，挂载即渲染、卸载即释放，高度估计 1.5× 行高起步由 ResizeObserver 实测回填）。

## Mermaid 图表（#60）

#60 起两种视图渲染语言标记为 `mermaid` 的围栏代码块（mermaid 11.12.2 vendored 独立产物 `out/webview/mermaid.js`，存在 mermaid 围栏时按需 `<script>` 加载）。**形态声明**：info string 精确匹配 `mermaid`（trim 后全等，大小写敏感）；普通围栏与外层长围栏内的伪围栏、缩进 ≥4 的围栏不渲染；未闭合围栏降级为源码。语法/渲染失败按**错误态**降级（错误信息 + 源码可读，不吞后续块，错误结果缓存不重试）；明暗主题联动重渲染（缓存随主题清空）。围栏内链接不做跳转处理（securityLevel `strict`，显示为纯文本）。

| 本项目稳定类名 | 用途 | Obsidian 对应选择器 | 核对结果 |
| --- | --- | --- | --- |
| `.vsidian-mermaid`（live widget 外层与阅读 fence 容器共用） | mermaid 围栏渲染容器（挂载后内含 mermaid SVG；携带 `data-vsidian-mermaid-code` 源码与 `data-vsidian-mermaid-state` 状态） | `.mermaid`（Obsidian 阅读渲染的图表容器） | 语义等价（呈现级）。断言：集成 `paint.mermaid.visible`（绘制层命中）与分态计数（`rendered` / `error`）；CSS 契约（`mermaidPaintCssContract.test.ts`）钉 `display:block` + `overflow-x:auto` 与 SVG `max-width:100%` |
| `.vsidian-mermaid svg` | mermaid 自产 SVG（宽度受容器约束、高度等比） | `.mermaid svg` | 语义等价。已验证：浏览器回归真实渲染（CSP 复刻页面，无 unsafe-eval） |
| `.vsidian-reading-mermaid`（阅读块级） | mermaid 围栏整块成块的块元素类（豁免 60 行大围栏切片；挂载即渲染、卸载随块释放） | `.markdown-preview-view .mermaid` 方向 | 语义等价（块级布局）。断言：集成「阅读模式 Mermaid 渲染」用例（容器计数 + 绘制层） |
| `.vsidian-mermaid-error`（两视图共用） | 语法/渲染失败的降级态：错误信息（`.vsidian-mermaid-error-message`）+ 源码（`.vsidian-mermaid-error-source`）可读，光标进入围栏仍可编辑 | `.mermaid error` 方向 | 语义等价（降级态）。CSS 契约钉错误色变量与左对齐不外溢 |

行为边界（非样式映射，随 #60 记录）：

- 形态学单一事实源 `src/shared/mermaid.ts`（CommonMark 围栏状态机行扫描，含非 mermaid 围栏的嵌套抑制），阅读侧为 markdown-it fence 渲染规则——两处判定逐条对齐；已知差异（引用行 `> ```mermaid` live 显源码、阅读渲染）记录于 `docs/perf/2026-09-mermaid-rendering.md`，降级方向安全。
- 渲染产物按源文本 LRU 缓存（64 条）；同一缓存条目插入多个容器时克隆改写全部 SVG id 与引用（文档内 id 唯一、内嵌 `<style>` 选择器不串图）。
- SVG 经 DOM API 插入专用容器，**不经过** sanitizeReadingDom（净化层剥 `<style>` 会毁配色）——安全边界由 mermaid 自产 SVG + `securityLevel:'strict'` + webview CSP 三层兜底。
- live 跨行 replace 装饰走 StateField（CM6 约束），围栏表增量重建以变更前最后一个已闭合围栏为顶层锚点。

## 悬浮提示等既有稳定类（沿用 #4/#5，与 Obsidian 无对应）

`.vsidian-suspend-banner`（冲突暂停横幅）、`.vsidian-toolbar` 与 `.vsidian-mode-toggle`（模式切换工具栏）：本项目自有 UI，无 Obsidian 对应物，不参与兼容承诺。

## 公开 CSS 变量

一期公开以下变量，外部片段可覆盖（定义于 `src/webview/main.css`）：

| 变量 | 默认值 | 用途 | Obsidian 对应变量 |
| --- | --- | --- | --- |
| `--vsidian-heading-accent` | `var(--vscode-textLink-foreground, #4fc1ff)` | live 视口内标题左缘强调色 | `--heading-accent`?（Obsidian 各主题变量名不一，无官方统一名） |
| `--vsidian-reading-font-size` | `15px` | 阅读正文字号 | `--font-text-size`（语义对应，名称不同） |
| `--vsidian-reading-max-width` | `760px` | 阅读块最大宽度 | `--file-line-width`（语义对应，名称不同） |
| `--vsidian-reading-line-height` | `1.6` | 阅读正文行高 | `--line-height-normal`（语义对应，名称不同） |
| `--vsidian-reading-code-background` | `var(--vscode-textCodeBlock-background, …)` | 代码块背景 | `--code-background`（语义对应，名称不同） |
| `--vsidian-table-background` | `rgba(128, 128, 128, 0.05)` | live 表格行背景 / 阅读表头背景（#12） | `--table-background`（语义对应，名称不同） |

变量名**不与 Obsidian 原名对齐**（加 `vsidian-` 前缀避免与宿主 VSCode 变量冲突）；二期若需要按 Obsidian 变量名片段兼容，经映射垫片（alias）实现，不在一期承诺内。

## 内部测试 CSS 验证入口

- 片段：`media/css-contract-probe.css`，随 webview HTML 加载（CSP `style-src` 允许的扩展资源）。仅用无视觉影响的属性（`text-decoration-color`，在无 `text-decoration-line` 时不呈现）与探针变量。#8 追加 span 级类与阅读语义标签的探针规则（`.vsidian-strong`/`.vsidian-inline-code`/`.vsidian-code-line`/`.vsidian-reading-block strong`）；#9 追加任务 checkbox 探针规则（`.vsidian-task-checkbox`/`.vsidian-reading-task-checkbox`）；#10 追加链接/图片探针规则（`.vsidian-link`/`.vsidian-reading-block a`/`.vsidian-reading-block img.vsidian-image`）；#12 追加表格探针规则（`.vsidian-table-pipe`/`.vsidian-reading-block table`）；#11 追加双链探针规则（`.vsidian-wikilink`/`.vsidian-reading-block a.vsidian-wikilink`）。
- 观测：`view.state` 回报的 `cssProbe` 字段（`liveHeadingDecorationColor` / `readingHeadingDecorationColor` / `readingVarProbe`；#8 追加 `liveStrongDecorationColor` / `liveInlineCodeDecorationColor` / `liveCodeLineDecorationColor` / `readingStrongDecorationColor`；#9 追加 `liveTaskCheckboxDecorationColor` / `readingTaskCheckboxDecorationColor`；#10 追加 `liveLinkDecorationColor` / `readingLinkDecorationColor` / `readingImageDecorationColor`；#12 追加 `liveTablePipeDecorationColor` / `readingTableDecorationColor`；#11 追加 `liveWikilinkDecorationColor` / `readingWikilinkDecorationColor`；#59 追加 `liveMathFontFamily` / `readingMathFontFamily`——取 `.katex` 层 computed font-family，KaTeX 样式/字体管线失效时回落 body 字体），由 webview 读取目标元素 computed style 填充；目标元素不存在时为 `null`。
- 断言：集成用例「稳定样式契约」（`test/integration/suite/cases.ts`）在真实 VSCode 1.86.2 宿主内验证两种视图的类名命中与变量管道；#12 表格断言并入「表格装饰与单元格编辑写回」「阅读视图表格」用例。#59 公式断言在「live 公式渲染与绘制层」「阅读模式公式渲染」等用例（`paint.math` 绘制层 + 字体探针）；#60 图表断言在「live Mermaid 渲染与绘制层」「阅读模式 Mermaid 渲染」等用例（`paint.mermaid` 绘制层 + 分态计数）。

## 已知不支持项（如实清单）

以下 Obsidian 常用选择器/结构**一期不提供**，出现在用户片段中不会命中（不会报错，也不会生效）：

- ~~行内格式 token：`.cm-strong` / `.cm-emphasis` / `.cm-inline-code`~~（#8 已建立 `vsidian-` 对应类，见上文 live 表；~~`.cm-link` 待 #10 链接票~~ 已建立 `.vsidian-link`；`.cm-highlight` 高亮 `==文字==` 仍不支持）
- ~~表格：`.markdown-preview-view table` 及其子结构~~（#12 已建立：阅读侧 `.vsidian-reading-table` + 真实 `table` 标签，live 侧 `.vsidian-table-line`/`.vsidian-table-cell` 族，见上文两节。**跨视图差异如实记录**：markdown-it 不识别行内代码内的 `|`，含该形态的表格在阅读视图错切或降级为段落，live 侧按 GFM 规范正确拆分——偏差与修复成本见 docs/perf/2026-09-table-cell-editing.md「已知限制」）
- ~~键盘导航/增删行列的表格交互结构~~（#13 范围，一期未提供；单元格编辑语义为「光标落源区间直编」）
- 引用块：~~`.markdown-embed` / `blockquote` 结构~~（#8 已提供 blockquote；`.markdown-embed` 嵌入结构仍属二期）
- Callout：`.callout` 及其 data 属性（二期）
- 任务扩展状态：`.task-list-item[data-task="x"]` 等（仅支持空格/`x`/`X` 三态，#9）
- frontmatter：~~`.markdown-frontmatter`~~（#8 已按源码形态呈现；Obsidian 属性面板形态不在一期）
- 标签：`.cm-hashtag` / `.tag`（一期未实现标签语法；~~双链 `.cm-hmd-internal-link` / `.internal-link` 待 #11~~ #11 已建立 `.vsidian-wikilink` 对应类，见上文双链节。Obsidian 双链的 is-unresolved 区分——按目标存在与否变色——一期不做：显示不查询工作区，避免为样式引入索引/查找）
- 语法高亮 token：`.token-*` / HyperMD codeblock 行内高亮 `.HyperMD-codeblock-*`（`language-x` 类已就位，高亮 token 属后续扩展）
- 删除线：`.cm-strikethrough` / 阅读视图 `del`（解析器支持但一期未装饰——如实记录，待后续补齐）
- 虚拟化结构差异（#7 已生效）：阅读视图视口外块不存在于 DOM——依赖"全文 DOM 常驻"的片段（全局 `:nth-child` 定位、跨屏兄弟/后代选择器、假设完整内容高度的滚动条计算）与按需挂载冲突；正文块结构见上文 #7 说明
- 查找高亮与隐藏标记区的交叉形态（#14 已知限制）：当前匹配的 replace 装饰优先于查找高亮，命中区间落在被折叠的隐藏标记（如链接语法标记）内时查找高亮不可见；匹配计数与步进不受影响，仍按全文文本模型计算

## 核对来源

- Obsidian 官方帮助（CSS snippets 格式参考）：https://obsidian.md/help/snippets
- 社区实际片段与论坛讨论中确认的选择器族（`.markdown-preview-view` 系、`.HyperMD-header-N` 行级与 `.cm-header-N` span 级的分工、`.task-list-item` 系）：
  - [Live Preview: Style header font attributes? — Obsidian Forum](https://forum.obsidian.md/t/live-preview-style-header-font-attributes/32053)
  - [obsidian-css-snippets/Snippets/Headers.md — GitHub](https://github.com/Dmytro-Shulha/obsidian-css-snippets/blob/master/Snippets/Headers.md)
  - [Background formatting for text under a header — Obsidian Forum](https://forum.obsidian.md/t/background-formatting-for-the-text-under-a-header/47385)
  - [Obsidian custom checkbox snippet — GitHub Gist](https://gist.github.com)（`.task-list-item[data-task]` 用法）

> 来源链接为选择器**核对依据**，不证明本项目已具备对应兼容能力；能力范围以上表"核对结果"为准。
