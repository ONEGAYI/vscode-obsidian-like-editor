# 规格：代码块卡片（高亮、卡片样式、复制按钮与折叠）

状态：工单 #78 交付，2026-09-26。本文是代码块卡片功能的单一事实源，实施工单 #79–#85 的验收以此为准。设计共识经问卷（2026-09-26）确认，参考 Obsidian 插件 Code Styler（v1.1.7）的观感与两张逐像素读图结论；**不复用其实现**——该插件的高亮复用 Obsidian 原生引擎、复制按钮借 Obsidian 原生按钮再样式化，两条路径在 VSCode webview 中均无等价物，本项目自建。

## 范围

- **覆盖**：Live 视图与阅读视图的**围栏代码块**（fenced code block），两视图观感一致。
- **固定排除**：`mermaid` 围栏（#60 专属管线）、`$$` 公式（#59 专属管线）不套卡片；缩进代码块（非围栏）维持现状源码形态；行内代码不在本规格内。
- **非目标**：`title:`/`ln:N` 逐块参数、全选代码按钮、自定义 header/footer 文本模板、Shiki 引擎、行内代码美化。

## 卡片解剖（呈现态，光标在块外）

参照读图结论（Code Styler 深色主题截图）：

- **围栏行**：两条围栏行**行槽保留、内容清空**（零残留文字），不是被头部替代——头部是插在块首行**上方**的额外横带。
- **头部横带**：语言标签（显示名、首字母大写，如 `Plain text`、`JavaScript`，粗体）居左；右侧按钮区（复制、折叠）。头部下方 1px 分隔线。
- **卡内行号**：代码行左侧，每块从 1 起；**围栏行不占卡内行号**（两态一致）。颜色、字号与文档行号槽一致。
- **外壳**：小圆角（约 4–6px）、无边框；背景比正文背景略亮、低对比浮起感（走 `--vscode-*` 主题变量）；头部与代码区同底色。
- **文档行号槽**：两态照常显示**全部**源文件行号——包括呈现态被清空的围栏行；与卡内行号两列并存、互不遮挡。两列行号字体同款（衬线数字观感由宿主字体决定，不强求），代码字体为等宽。

## 编辑态（光标进入块内）

| 项 | 呈现态 | 编辑态 |
| --- | --- | --- |
| 围栏行 | 内容清空、行槽保留 | 原样文本显形，可编辑（含 IME） |
| 头部横带 | 保留 | 保留 |
| 卡内行号 | 保留 | 保留 |
| 复制按钮 | 悬停卡片显现 | 常驻（与呈现态一致） |
| 折叠 chevron | 保留 | 保留（编辑态不折叠） |
| 卡片外壳（底色/圆角/分隔线） | 保留 | 保留 |
| 语法高亮 | 保持 | 保持 |

控制域沿用 #29 决议语义：围栏块的**控制域是整个块**（含两条围栏行与全部内容行）；非空选区与块相交时同单光标处理（围栏显形）。光标/选区移动只切换装饰，零写回、不产生撤销历史。

## 折叠

- 头部 chevron 点击收起代码体（仅留头部横带，chevron 转向约 -90°/0°），再点展开。
- 折叠是**视图状态**：不写源文件、不跨会话持久化（重开文档后全部展开）。
- 光标进入已折叠块区间时**临时展开**，离开后恢复收起；编辑态不折叠。
- 收起态悬停不弹复制按钮。

## 复制按钮

- 悬停卡片时显现；点击复制**代码体**（两条围栏行之间的原文，不含围栏与 info string）。内容一致性口径：webview 出站恒为 LF 形态，宿主按文档 EOL 归一后写入剪贴板——CRLF 文档粘贴到仅认 CRLF 的环境（如旧记事本）不串行，LF 文档仍得 LF。
- 写入经宿主剪贴板 API（`vscode.env.clipboard.writeText`），webview 内不触碰剪贴板权限。
- 点击后图标变 ✓ 约 1.2 秒复原。
- **编辑态同样常驻**（用户验收决策）：渲染型围栏（mermaid）只有编辑态卡片——呈现态是渲染图无头部，编辑态再隐藏按钮会让复制功能对这类块完全不可用；普通块随同统一。收起态仍不发射。

## 语法高亮

**引擎**：CodeMirror Lezer 语言包 + `@codemirror/legacy-modes` StreamLanguage，两端（Live 装饰与阅读渲染）共用同一 token 类名与色板。

**语言注册表**（显示名 / 语法来源 / 常见别名）：

| 显示名 | 语法来源 | 别名（不限于） |
| --- | --- | --- |
| JavaScript | `@codemirror/lang-javascript` | `js`、`jsx`、`mjs`、`cjs` |
| TypeScript | `@codemirror/lang-javascript`（TS 方言） | `ts`、`tsx` |
| JSON | `@codemirror/lang-json` | — |
| HTML | `@codemirror/lang-html` | `htm` |
| CSS | `@codemirror/lang-css` | — |
| Python | `@codemirror/lang-python` | `py` |
| Shell | legacy-modes `shell` | `sh`、`bash`、`zsh` |
| PowerShell | legacy-modes `powershell` | `ps1`、`pwsh` |
| C | `@codemirror/lang-cpp` | — |
| C++ | `@codemirror/lang-cpp` | `cpp`、`cc`、`c++` |
| Java | `@codemirror/lang-java` | — |
| Go | `@codemirror/lang-go` | `golang` |
| Rust | `@codemirror/lang-rust` | `rs` |
| SQL | `@codemirror/lang-sql` | `pgsql`（方言按引擎支持映射） |
| YAML | legacy-modes `yaml` | `yml` |
| Markdown | `@codemirror/lang-markdown`（已随包依赖） | `md` |
| Verilog | legacy-modes `verilog` | `systemverilog`、`sv` |

- **多词 info string**：语言路由取 info string 的**首个空白分隔词**（CommonMark 惯例）——`` ```js title=x `` 识别为 JavaScript，`` ```c++ `` 命中 C++ 别名。`mermaid` 是刻意例外：渲染管线对标签**全等匹配**，多词 info string 不命中渲染管线。
- 无语言标记或 `text`/`plaintext`：卡片正常呈现，标签显示 `Plain text`，不着色。
- **未识别语言**：回退纯文本（卡片与行号仍在）。
- **token 类名**：采用 `@lezer/highlight` `classHighlighter` 的 `tok-*` 稳定词表（如 `tok-keyword`、`tok-string`），两视图共用；配套 CSS 色板以主题 class 区分明暗。
- **配色**：内置明暗两套固定色板，取色参照 VSCode Dark+ / Light+；随现有明暗主题管线（`EditorView.darkTheme` facet + body class）自动切换。卡片外壳（背景、行号、标签、分隔线）继续走 `--vscode-*` 主题变量。
- **语言徽标**：v1 为字形徽标（typographic badge）——等宽缩写 + 品牌近似色（`CODE_LANG_ICONS`），随头部标签显示，仅注册表内语言有徽标，未收录语言无徽标；矢量 logo 集为后续工单（体积与素材来源另行决策）。
- **性能**：Live 侧高亮按块计算并缓存，编辑仅重算受影响块；呈现态与编辑态均保持高亮；大围栏（10 万行档）不阻塞输入。

**体积红线**：语言包解包合计约 430 KB（`@codemirror/language` 已随 lang-markdown 在包内，不额外增），legacy-modes 按模式 tree-shake。**实测（#85）**：main.js 增至约 2.4 MB（语言包增量约 1.6 MB，预估的 0.4–0.5 MB 偏低——Lezer 解析表 minify 后仍大于解包体积占比的直觉）；VSIX 解压总量 4551 KB，单文件警告线 3 MB 未触线，总量距旧警告线 4.5 MB 余量仅约 57 KB——**用户决策（#85 验收）总量警告/上限各上调 1 MB 至 5.5 / 6.5 MB**，无需独立懒加载产物。后续增补语言包前仍需先核对总量余量（新警告线下约 1.06 MB）。

## 渲染型围栏（mermaid）

会被渲染成图形的围栏语言（当前仅 mermaid，用户验收反馈接入）与卡片系统的交界规则：

- **编辑态**（光标/选区触及围栏区间，含点击渲染图进入）：SVG 退场，走通用卡片路径——头部横带（标签 `Mermaid`）、卡内行号、复制按钮、折叠 chevron 齐全；无语法高亮（图表 DSL 不进语言注册表，自然无引擎、无徽标）。接入前此处是朴素围栏源码。
- **呈现态展开**：卡片零发射，专属渲染管线接管（整块 replace 为 SVG，#60 语义不变）——呈现态无头部，折叠入口在编辑态。
- **呈现态折叠**：卡片接管收起形态（头部保留 + 整块收起），SVG 让位；再点展开恢复渲染。折叠路径：编辑态点击 chevron → 光标离开后收起生效。
- **卡片总开关关闭**：折叠集清空，呈现态恒为 SVG（不会出现「SVG 与收起形态同时缺席」的空白）。
- **泛化点**：未来新增渲染型语言（图表 DSL 等）时，在 `shared/mermaid.ts` 的 `RENDERED_FENCE_LABELS` 登记显示名，并在围栏标志判定同步扩展。
- **共享状态位置**：卡片配置 facet、复制/折叠 effects 与折叠 field 位于 `src/webview/codeCardState.ts`（中立模块——mermaid 装饰感知折叠态需要单向依赖，避免与 liveCodeCard 循环引用）。
- **已知交互语义**：点击渲染图的落位依命中元素而异（SVG 背景区 → 光标落围栏起点进入编辑态；节点图形上 → 可能落到区间之外保持渲染）——CM6 replace widget 的坐标 snap 行为，非稳定契约，不据此断言。

## 设置（扩展设置页，#33 链路）

| 设置键 | 类型 | 默认 | 语义 |
| --- | --- | --- | --- |
| `codeblock.card` | boolean | `true` | 卡片总开关：关闭回到朴素围栏外观（现行源码形态） |
| `codeblock.lineNumbers` | boolean | `true` | 卡内行号（依附卡片；卡片关闭时无效） |
| `codeblock.copyButton` | boolean | `true` | 复制按钮（依附卡片） |
| `codeblock.highlight` | boolean | `true` | 语法高亮独立开关：卡片关闭时朴素围栏仍可着色 |

设置页可切换、即时生效（Compartment 热重配）、重开回显；阅读视图随同一设置联动。

## 阅读视图

- 围栏代码块渲染为同一卡片契约：头部（标签/图标/复制按钮）、卡内行号、`tok-*` 高亮（与 Live 同一类名与色板）。
- 与阅读侧既有结构协同：块级虚拟化按需挂载（挂载钩子内做增强）、大围栏 60 行分块（跨分块卡内行号连续）、`data-vsidian-src-*` 锚点不变。
- 复制走同一宿主剪贴板消息路径。

## 稳定样式入口

新增稳定类名（登记入 [选择器映射表](../design/obsidian-selector-map.md)）：`.vsidian-code-card-line`、`.vsidian-code-card-edge-top/-bottom`、`.vsidian-code-card-header`（含 `-label`/`-actions`）、`.vsidian-code-card-copy`（`-done` 修饰）、`.vsidian-code-card-fold`（`-collapsed` 修饰）、`.vsidian-code-card-linenumber`、`tok-*` token 族；公开变量 `--vsidian-code-card-background`（默认回落 `--vscode-textCodeBlock-background`）。

## 已知限制与语义

- **折叠集残留边角**：折叠围栏 A 后，一次性删除「A 开围栏行起至紧邻围栏 B 起始行前」的内容时，B 可能继承折叠收起态——折叠集只随 ChangeSet 做位置映射、不做围栏表修剪（「消费点以围栏起点查询」是已声明取舍，见 `codeCardState.ts` 头注释），删除后 B 的起点可能恰好等于残留的映射位置而命中。纯视图态，重开文档恢复全展开。
- **卡片按钮回调的定位依赖**：复制/折叠按钮点击回调经 `EditorView.findFromDOM` 从头部 widget 根反查视图，依赖 CM6 当前版本 widget Tile 携带的内部标记（非公开 API 承诺面）——升级 `@codemirror/view` 大版本时须把「卡片按钮点击」列入回归清单。
- **阅读视图大围栏分片的复制边界**：60 行分块是阅读虚拟化的挂载单位，每片有独立头部与复制按钮——复制只得该片的代码体，不做跨片聚合（聚合与按需挂载/卸载语义冲突，接受为已知行为）；卡内行号已跨片连续。
- **未闭合大围栏的闭围栏启发式**（复核登记，前置既有）：阅读分块的闭围栏探测（`readingBlocks.ts` 的 `hasClose` 启发式）对「未闭合且末行恰以围栏标记开头（如末行 ```text）」的超长围栏会误判有闭围栏——该末行不显示，行号 total 与内容截断同源同错。触发需 >60 行未闭合围栏且末行形态特殊，极边角。
- **未注册多词 info 的标签措辞微差**（复核登记，前置既有）：两视图对未注册语言的标签显示粒度不同——live 显示 trim 后全文（如 `mermaid x`），阅读显示类名提取的首词（如 `mermaid`）；语言路由已统一首词，仅未注册时的标签措辞有此微差。

## 验证与测试边界

- 单元：卡片装饰纯函数（围栏识别、控制域判定、行号序列、语言路由/别名）+「增量 == 全量」对拍 + CSS 契约测试钉关键规则。
- 集成：`PaintProbe` 新增 `code` 节（绘制层断言：卡片可见性、头部、行号、按钮分态）；光标进出零写回用例沿用 #60 模式；设置链路（切换、生效、回显）用例沿用 #33/#34 模式。
- 浏览器（合并前必跑）：光标进出代码块的原生键盘输入、折叠块键盘导航、复制按钮点击（Playwright 原生事件驱动）。
- 性能：`node test/perf/runPerf.mjs` 增代码块密集档；VSIX 体积经 `npm run release:check` 核查（#85）。
- 人工验证：[manual-verification.md](manual-verification.md) 十四节 A28/A29。
