# vsidian

VSCode 扩展：在 VSCode 中提供类 Obsidian 的 Markdown 编辑体验。

> 当前状态：**MVP 主要功能已实施，整体验收未结**。一期双视图编辑、增量写回、任务、链接图片、双链、表格、查找、三态切换、独立设置页与源文件行号，二期公式渲染、Mermaid 图表、表格交互重做（[#72 规格](docs/specs/table-interaction-rework.md)）与大纲面板二期（#65–#70，样式透传、跳转高亮、折叠滑块、工具条搜索、右键菜单、拖拽排序）均已落地；自动化通过不等于真实 IME、物理鼠标与视觉观感已由用户验收。功能范围见 [docs/specs/mvp.md](docs/specs/mvp.md)；待验项与历轮执行记录见 [docs/specs/manual-verification.md](docs/specs/manual-verification.md)；用户可见变更见 [CHANGELOG.md](CHANGELOG.md)。本文件是项目级 agent 规则的**单一事实源**。

## 约定

- 通用工程规范（提交规范、TDD、文件树维护）遵循工程根 `D:\CODE\Project\AGENTS.md`，此处不重复展开。
- **插件设置入口**：Vsidian 面向用户的设置统一在扩展自己的设置页面展示与修改，不复用 VSCode 统一设置中心作为设置界面。后续新增设置项时，同步纳入该页面，并验证设置持久化、重新打开后的回显及变更生效。
- **操作与快捷键注册**：快捷键管理覆盖项目全部面向用户的可绑定操作。每次新增或修改操作，都必须评估并记录是否提供快捷键入口、默认绑定（允许默认未绑定）及生效模式；不能仅因操作不常驻工具栏就省略快捷键入口。写操作快捷键仅在 Live 编辑正文时覆盖宿主绑定，不接管源码模式或设置页输入；注册模型须支持未来其他操作按需覆盖 Live、阅读或双模式。绑定支持显式清空、单项恢复默认与全部恢复默认；清空不能因重启或升级自动恢复。插件内部冲突按键位及生效范围是否重叠判定。
- **图形化代码块扩展约定（#111 落档）**：「渲染成图形的围栏代码块」的按钮组、图表弹窗、禁点击进编辑与导出是注册表驱动的路径级行为：共享侧 `RENDERED_FENCE_LABELS`（`src/shared/mermaid.ts`，同时是 `FenceSpan.rendered` 判定源）登记语言显示名，webview 侧 `graphicRenderers.ts` 登记渲染管线（`renderInto`/`renderSvg`），两侧键集一致性由 `test/unit/graphicRenderers.test.ts` 钉住。新增此类语言走 `graphicRenderers.ts` 文件头的三步接入清单（标签、管线、契约测试一行），登记即继承全部交互——含阅读侧渲染：挂载钩子经 `renderGraphicBlockInto` 按容器语言分派（review 修复后不再写死 mermaid 管线），**两表必须同步登记**，只登标签不登管线的语言 live 侧降级源码+卡片、阅读侧容器停留 pending（契约测试钉住分派不误渲）。「登记即继承」由假想第二渲染器用例验证，不引入真实依赖。点击图形本体不进入编辑（widget `ignoreEvent: true`），编辑入口收敛到 edit 按钮（仅实时预览，派发选区触发现有源码显形管线）；弹窗「刷新」经控制器注入的文档全文与 `locateGraphicFenceCode` 重定位当前围栏源码（外部改写后可取新图，重定位歧义回退快照）；单击图本体不关闭弹窗（关闭判定用按下时原始 target，pointer capture 会重定向 up 事件的 target）。PNG 光栅化在 webview canvas 完成，CSP `img-src` 已放行 `data:`（浏览器回归在宿主同形 CSP 复刻页内实证），环境不支持时降级为仅 SVG 并以弹窗内提示条回报——**不得用 `window.alert`**（宿主 webview 的 sandbox iframe 无 `allow-modals`，alert 被静默吞掉）。
- **行内围栏扩展约定（#103 落档）**：粗体/斜体/删除线/行内代码这类成对行内标记统一走 `inlinePlan` 共用路径，两态切换（光标在围栏语法节点内即取消整段）与无选区扩词包裹的光标落位（开围栏内侧，锚点按 `markers.open.length` 从实际定界符计算）是路径级行为，不逐操作实现。新增此类围栏只需：`src/webview/formatOperations.ts` 的 `INLINE` 表登记 `{ mark, node }`（node 为 Lezer 语法节点名，取消分支按它命中）+ `src/shared/formatOperations.ts` 注册表（titleKey／i18n／快捷键入口评估见上条），即自动继承全部行为；「清除行内格式」按 `INLINE` 全表遍历，亦自动覆盖。两处例外需主动适配：定界符随内容变化的围栏（多反引号、补位空格一类）须在全部三处构造 markers 的分派接入自己的 marker 函数——fresh-wrap 包裹处、`rewriteInlineLine` 重包与 `clearInlineLine` 局部重包各有一处 `codeSpanMarkers` 三元，漏改任一处该路径会退回静态定界符——锚点仍自动；插入型结构（wikilink／inlineMath 所在分支）无切换语义，新操作要两态化须自行设计取消分支。测试惯例：新围栏在 `test/unit/formatOperations.test.ts` 补一条包裹后光标位置断言，并在 `test/unit/formatInteraction.test.ts` 两态往返用例的枚举里加一行（现有五种为显式枚举，不自动生成）。已知边界：词与既有同类围栏贴边相邻（如 `**a**b` 光标在 b 处——贴边包裹产物被解析为合并节点，取消会整体摘除）或光标停在既有围栏紧前方（星号处取不到词，落入空对插入）时，包裹与取消仍不两态，属 #107 遗留缺陷，不在「自动继承两态」的承诺范围。
- **视觉层断言（评审必查）**：webview/样式/渲染类变更，评审必须核对断言对象是"用户看到的东西"（可见性、对齐、颜色）而非 DOM 存在性或几何坐标——样式注入失效时后者照样通过（PR #37 P0 实证：CSP 拦截 CM6 注入样式后 74 集成用例仍全绿，正文实际不可见）。涉及呈现的新特性至少一条集成断言落在绘制层（现有 `view.state.paint` 探针），CSS 关键规则由契约测试钉住。
- **大纲样式设计哲学（#65 落档）**：大纲条目的呈现遵循三条原则，后续大纲呈现类变更不得违背。其一，**结构装饰与正文主题同源**——层级颜色等主题性装饰不复制读值，而是与正文标题引用同一 CSS 变量族（`--vsidian-heading-color-1..6`，定义于 `#app`，live 标题行级、阅读标题块级、大纲条目级三侧同引），主题分级着色一处定义多处生效。其二，**强调语义只认显式标记**——条目一律常规字重（400），不继承标题级别的结构性加粗；仅显式 `**粗体**` 段加重，斜体/行内代码/删除线同理只由标记触发。其三，**透传集合 = 正文已支持的行内标记子集**——当前白名单为粗体/斜体/高亮/行内代码/删除线（`OutlineSpanKind`，提取与校验同源；#105 高亮已按同一机制接入），公式/行内颜色待正文支持后按同一白名单机制接入（提取处 `SPAN_KIND_BY_NODE` 加映射即可），大纲侧零额外设计；双链/链接显示别名/链接文字的纯文本，不可点。
- **用户可见文字一律 i18n**：所有面向用户的文字（webview 界面、设置页、宿主通知/确认框、package.json command title 与 displayName/description）必须经 `src/shared/locales/` 语言包与 `t()` 字典映射添加，禁止新增硬编码中/英文字面量；两语言包键集由编译期 parity 把关，回潮由 CI 防回潮扫描（源码 CJK 字面量契约测试）拦截。manifest 侧 `package.nls.*.json` 由构建脚本从字典生成，不在 JSON 里手写。

## 技术栈与构建（工单 #2 确立）

- **运行时**：TypeScript + CodeMirror 6（`@codemirror/state`、`@codemirror/view`、`@codemirror/commands`，单包组合，不用 `codemirror` 聚合包与 basicSetup/history——撤销栈归宿主文本管线）。阅读模式用 markdown-it（#8 起）；公式渲染 KaTeX 0.16.47 + `@vscode/markdown-it-katex` 1.1.2（#59，仅随包 woff2 字体）；Mermaid 11.12.2 独立产物按需懒加载（#60）；代码块卡片（#78–#85，规格 `docs/specs/code-block-card.md`）语法高亮为 Lezer 官方语言包 + `@codemirror/legacy-modes` StreamLanguage 统一引擎（`tok-*` 词表两端共用，`src/webview/codeHighlight.ts`），围栏表复用 `mermaidFencesField`，语言注册表在 `src/shared/codeLangs.ts`。
- **宿主端**（`src/extension.ts`、`src/host/`）：`CustomTextEditorProvider`，保存/dirty/Hot Exit 由 VSCode 文本管线自动处理；`TextDocument` 为权威文本，编辑经 `WorkspaceEdit` 写回。
- **webview 端**（`src/webview/`）：CM6 EditorView + `acquireVsCodeApi` 消息桥；`src/shared/` 为两端共享的消息协议单一事实源（不依赖 vscode/DOM）。协议约定 webview 全程 LF 坐标（CM6 内部把 `\r\n` 规范化为 `\n`，宿主侧 `NewlineCoordinator` 负责双向坐标与文本转换）。
- **构建**：esbuild 多产物——宿主 `out/extension.js`（node18/cjs/external vscode）、编辑器 webview `out/webview/main.js` 与设置页 webview `out/webview/settings.js`（#33；chrome118/iife，CSS 随 import 打包为同名 `.css`）；`npm run compile` 另跑 `tsc --noEmit` 做类型检查（esbuild 不查类型）。
- **测试**：`npm run test:unit`（vitest + `node --test` 启动器契约，纯逻辑 + jsdom 的 webview 控制器，无 VSCode 宿主依赖；`VSIDIAN_TEST_HOST_MODE=foreground` 时跳过独立桌面探针）；`npm run test:browser`（Playwright headless Chromium，用原生键盘/IME 驱动生产控制器验证表格光标与输入回流——keydown 注入测不到 `input.type` 回流路径，**涉及 webview 输入/光标行为的变更合并前必跑**，首次需 `npx playwright install chromium`；CI 的 browser job 在 Linux runner 上跑同一脚本并缓存浏览器二进制，通道同为 Playwright chromium，与本地默认一致，`VSIDIAN_TEST_BROWSER_CHANNEL=msedge` 仅本机借系统 Edge 调试用，不进 CI）；`npm run test:integration`（1.86.2 真宿主，fixture 由 `test/integration/fixtures.mjs` 统一生成，开发态 `runTest.mjs` 与安装态 `runInstalled.mjs` 及空窗口激活 `runSettingsActivation.mjs` 三条路径共用 `testHost.mjs` 启动策略：Windows 默认独立桌面不抢前台，`VSIDIAN_TEST_HOST_MODE=foreground` 切前台；三条启动器都会把本次宿主的完整逐例输出与退出码自动落盘到 `.vscode-test/` 下的运行报告——`integration-dev.log` / `integration-installed.log` / `settings-activation.log`，复核结果、统计用例与追查失败优先读报告文件，不为补看信息重跑）。扩展注册 `onegayi.vsidian._test.*` 辅助命令供集成测试观测/注入（仅 `VSIDIAN_TEST_HOOKS=1` 时注册）。测试消息通道是**宿主侧门控、webview 侧被动接收**的分层设计：`_test.*` 注入命令（含向 webview 转发 `table.test.key`/`task.test.click`/`reading.test.image` 等）在宿主侧受 `VSIDIAN_TEST_HOOKS` 门控；webview 侧这些消息分支不做二次门控——webview 面板的消息源只有扩展自身（`panel.webview.postMessage`），封住注入源即封住入口，勿误判为 webview 未设防。
- **集成测试分片**：本地设置 `VSIDIAN_ITEST_SHARDS=4` 再运行 `npm run test:integration`，启动器共用一份 VSCode 程序，为各片创建独立临时便携目录并在全部宿主退出后清理；逐片报告写入 `.vscode-test/integration-dev-s<片号>.log`。缺省仍为单宿主全量测试。CI 使用四个 runner，各注入 `VSIDIAN_TEST_SHARD=k/4` 且只起一个宿主；`integration` 汇总检查保留分支保护所需的稳定名称。
- **打包与安装态回归（#15）**：`npx @vscode/vsce package --no-dependencies` 产出 VSIX（esbuild bundle 自包含，不带 node_modules；`.vscodeignore` 排除 src/test/docs）。`node test/integration/runInstalled.mjs` 把 VSIX 经 `--install-extension` 装入隔离 profile 的 1.86.2 便携宿主（安装注册链路真实走通；1.86 测试模式要求 `--extensionTestsPath` 依赖 `--extensionDevelopmentPath` 同时存在，故 dev path 指向安装解压目录——加载代码仍是 VSIX 产物而非仓库源码树）后跑同一集成套件。
- **性能测量**：`node test/perf/runPerf.mjs`（1千/1万/10万行、10 KB/100 KB/1 MB、超长行、图片密集与大围栏；报告写 `docs/perf/data/perf-report.json`）；档位数据与解读汇总在 [docs/perf/2026-09-mvp-performance-summary.md](docs/perf/2026-09-mvp-performance-summary.md)。
- **版本锁定**：依赖一律精确版本（无 `^`），提交 lockfile；`engines.vscode ^1.86.0` 与 `@types/vscode 1.86.0` 对齐。`@types/node` 锁 22.x（vitest 5 的 vite peer 要求数 >=20.19，类型不进产物，宿主代码仍按 Node 18 API 面编码）。

## 打包与发布

- **体积红线**：VSIX 解压总量警告 5.5 MB / 上限 6.5 MB（#85 代码块高亮后基线约 4.45 MB，距旧警告线 4.5 MB 仅约 57 KB，用户决策两条线各上调 1 MB），一般单文件警告 3 MB / 上限 4 MB，图标上限 100 KB（256×256）。阈值定义在 `scripts/release.mjs` 的 `SIZE_LIMITS`；修改阈值视同变更本约定，需同步本节。#60 起基线含 mermaid 独立产物 `out/webview/mermaid.js`（minify 后约 2.6 MB，刻意 vendored 的按需懒加载渲染器，单文件与总量阈值据此上调）——彼时主 bundle main.js 约 0.80 MB 不触单文件警告；#83 代码块高亮语言包并入后 main.js 约 2.4 MB（距单文件警告线 3 MB 约 0.6 MB 余量），其增长由总量线约束——属已接受取舍。
- **双重防线**：`.vscodeignore` 挡打包输入，`scripts/release.mjs` 的 `inspectVsixEntries` 检查最终产物（必需清单 + `out/` 白名单 + 禁止模式 + 体积阈值），每次发布前必跑（`npm run release:check`，或随 `npm run release` / CI 自动执行）。新增运行时资产时两处同步维护：`.vscodeignore` 放行 + `REQUIRED_EXTENSION` 登记；漏登记（缺失）与 out/ 未登记产物（多余，如调试遗留）都会被发布检查拦下（`.github/` 混入包内即此类事故，实测发生过）。字体只随包 woff2（chrome118 目标足够），`.woff`/`.ttf` 混入即硬错误——它是字体裁剪失效的信号。
- **图标**：`media/vsidian-icon.png` 为原图（1254×1254），仅存仓库溯源、**不进 VSIX**；打包用 `media/vsidian-icon-256.png`（package.json `icon` 指向它）。替换图标时重新生成 256 版（PIL LANCZOS + optimize 即可），保持两文件同名关系。
- **发布流程**：`CHANGELOG.md` 最新 `## <版本> - <日期>` 段落必须与 package.json `version` 一致（`scripts/release.mjs` 强校验，并以该段落作为 GitHub Release 说明）。发版步骤：升 `version` + 新建 CHANGELOG 段落 → 提交 → `npm run release:check` 本地过检查 → `git tag v<版本>` → `npm run release`（或推 tag 由 CI 执行）。
- **CI 自动发布**：`.github/workflows/release.yml` 由 `v*` 标签触发。`release` job 跑 `npm run release`（检查失败即中止，不产出 Release）；`marketplace` job 从 Release 下载同一 VSIX 发布到 Marketplace（上市场的与 Release 附带的是同一份字节），需先配置仓库 secret `VSCE_PAT`（Azure DevOps PAT：Organization 选 All accessible organizations，Scope 选 Marketplace → Manage）并将 variable `MARKETPLACE_PUBLISH` 设为 `true`——两道开关配置前，推 tag 只产出 GitHub Release。
- **marketplace 失败的兜底**：v0.1.0 首发实测两坑——job 级 `if` 隐式 `success() &&` 前缀会跳过 dispatch 场景（已用 `!cancelled()` 豁免）；给已注册 workflow 新增触发器后平台注册实体可能滞留旧解析（dispatch 持续 422，对文件做字节变更推送也未能刷新）。**已验证的补发路径**：本地 `gh release download <tag> --pattern '*.vsix'` 下载同一 VSIX 后 `npx @vscode/vsce publish --no-dependencies --packagePath <vsix>`（依赖本地 `vsce login onegayi` 凭证）；dispatch 入口保留，注册表自愈后仍可用。
- **README 双语**：`README.md`（中文，Marketplace 渲染这份）与 `README.en.md` 互为镜像，文首以**绝对 URL** 互指（相对链接在 Marketplace 页面会失效）。功能与用法变更两边同步维护；`README.en.md` 不进 VSIX（`.vscodeignore` 排除）。

## Agent skills

### Issue tracker

使用 GitHub Issues 跟踪需求、缺陷与任务，仓库为 `ONEGAYI/vsidian`。操作约定见 [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md)。

### Domain docs

采用单一领域上下文；术语与架构决策按需记录。读取与维护约定见 [docs/agents/domain.md](docs/agents/domain.md)。

## 文件树（简版速览）

```
<!-- file-tree:tree:begin 由脚本渲染，禁止手改 -->
vsidian/
├── .agents/               # agent 技能与本地配置
│   └── skills/ # 已部署 agent 技能
│       ├── ai-icon-sheet-to-svg/ # AI单图图标转SVG技能
│       └── file-tree/            # file-tree 技能部署实例
├── .github/               # GitHub 平台配置
│   └── workflows/ # Actions 工作流目录
│       ├── ci.yml      # GitHub CI 工作流
│       └── release.yml # v* 标签触发的发布工作流
├── .gitignore             # Git 忽略规则
├── .vscode/               # VSCode 工作区配置
│   ├── launch.json # F5 扩展宿主启动配置
│   └── tasks.json  # 调试前编译任务
├── .vscodeignore          # VSIX 打包排除清单
├── AGENTS.md              # 项目级 agent 规则单一事实源
├── CHANGELOG.md           # 面向用户的版本变更日志
├── CLAUDE.md              # Claude 专属规则导入入口
├── CONTEXT.md             # 领域语言与产品边界事实源
├── docs/                  # 项目文档根
│   ├── adr/      # 架构决策记录
│   │   ├── 0001-vscode-186-remote-support.md     # 兼容 VSCode 1.86 与远程
│   │   ├── 0002-wikilink-on-demand-resolution.md # 双链按需解析不建持久索引
│   │   ├── 0003-source-text-dual-view-editor.md  # 基于源文本的双视图编辑架构
│   │   ├── 0004-stable-styling-contract.md       # 一期建立稳定样式入口
│   │   ├── 0005-viewport-rendering.md            # 全文模型与视口渲染分离
│   │   └── 0006-rebrand-to-vsidian.md            # 统一更名为 vsidian 的映射记录
│   ├── agents/   # agent 操作约定
│   │   ├── domain.md        # 领域文档读取与维护约定
│   │   └── issue-tracker.md # GitHub Issues 操作约定
│   ├── design/   # 设计文档（选择器映射等）
│   │   └── obsidian-selector-map.md # Obsidian 选择器映射表
│   ├── perf/     # 性能实测数据与测量工具说明
│   │   ├── 2026-09-code-block-card.md           # 代码块卡片性能实测（#85）
│   │   ├── 2026-09-live-syntax-decorations.md   # 语法树装饰与大围栏细分实测（#8）
│   │   ├── 2026-09-math-rendering.md            # 公式渲染性能实测（#59）
│   │   ├── 2026-09-mermaid-rendering.md         # Mermaid 性能与边界（#60）
│   │   ├── 2026-09-mvp-performance-summary.md   # MVP 性能档位汇总
│   │   ├── 2026-09-reading-viewport-mount.md    # 阅读按需挂载实测数据
│   │   ├── 2026-09-table-cell-editing.md        # 表格单元格编辑性能实测（#12）
│   │   ├── 2026-09-title-decoration-viewport.md # 标题切片视口渲染实测数据
│   │   └── data/                                # 性能探针原始报告数据
│   │       └── perf-report.json # 性能探针原始报告数据
│   ├── research/ # 技术调研报告
│   │   ├── obsidian-live-preview-editor.md # Obsidian 技术栈与选型调研
│   │   └── obsidian-viewport-rendering.md  # 视口渲染性能补充调研
│   └── specs/    # 产品规格
│       ├── code-block-card.md                # 代码块卡片功能规格
│       ├── graphic-code-block-interaction.md # 图形化代码块交互规格
│       ├── i18n.md                           # 全局 i18n 适配规格
│       ├── keybindings.md                    # 快捷键清单与默认值
│       ├── manual-verification.md            # 人工验证清单
│       ├── mvp-issues.md                     # MVP GitHub Issue 索引
│       ├── mvp.md                            # MVP 规格主文档
│       └── table-interaction-rework.md       # 表格交互重做规格
├── esbuild.mjs            # esbuild 多产物构建脚本
├── LICENSE                # MIT 许可证全文
├── media/                 # 随扩展打包的静态资源
│   ├── css-contract-probe.css # 样式契约内部测试片段
│   ├── quick-actions/         # 快速操作明暗图标与源PNG
│   ├── vsidian-icon-256.png   # 扩展图标 256 版，VSIX 打包用
│   └── vsidian-icon.png       # Vsidian 扩展图标
├── package-lock.json      # npm 依赖锁定文件
├── package.json           # 扩展清单与锁定依赖
├── package.nls.json       # 命令默认英文文案
├── package.nls.zh-cn.json # 命令简体中文文案
├── README.en.md           # 英文版 README，与中文版互指
├── README.md              # 项目门面说明
├── scripts/               # 仓库工具脚本目录
│   ├── genNls.mjs            # manifest NLS 文件生成脚本
│   ├── quick-action-icons.py # 快速操作图标生成与校验
│   └── release.mjs           # 发布脚本：打包、包体检查与上传
├── src/                   # 扩展源码
│   ├── extension.ts # 扩展激活入口
│   ├── host/        # 宿主端实现
│   │   ├── diagramExportHost.ts     # 宿主图表导出执行壳
│   │   ├── diagramExportValidate.ts # 图表导出载荷校验
│   │   ├── documentSession.ts       # 文档会话与写回同步
│   │   ├── hostLocale.ts            # 生效语言宿主装配解析帮手
│   │   ├── keybindingService.ts     # 快捷键全局存储服务
│   │   ├── linkTarget.ts            # 宿主侧链接目标分类纯逻辑（#10）
│   │   ├── settingsPage.ts          # 独立设置页面板装配
│   │   ├── settingsService.ts       # 宿主设置服务
│   │   ├── textEditorProvider.ts    # 自定义文本编辑器提供者
│   │   ├── viewCycle.ts             # 三态视图编排纯逻辑
│   │   └── wikilinkTarget.ts        # 宿主侧双链目标解析纯逻辑（#11）
│   ├── shared/      # 两端共享纯逻辑
│   │   ├── changeMapping.ts    # 变更重定位纯函数
│   │   ├── codeLangs.ts        # 代码块语言注册表与别名路由
│   │   ├── formatOperations.ts # 格式操作注册清单
│   │   ├── i18n.ts             # t() 取词与语言包装配状态模块
│   │   ├── keybindings.ts      # 快捷键操作与冲突模型
│   │   ├── locales/            # 语言包字典单一事实源
│   │   │   ├── en.ts     # 英文语言包（类型基准）
│   │   │   ├── index.ts  # 语言注册表与解析（仅宿主可引）
│   │   │   ├── island.ts # 语言数据岛构建与解析
│   │   │   └── zh-cn.ts  # 简体中文语言包（编译期 parity）
│   │   ├── math.ts             # 公式形态学纯函数（#59）
│   │   ├── mermaid.ts          # Mermaid 围栏形态学（#60）
│   │   ├── newline.ts          # CRLF/LF 换行协调器
│   │   ├── protocol.ts         # 消息协议单一事实源
│   │   ├── settings.ts         # 设置定义与读写纯逻辑
│   │   └── wikilink.ts         # 双链形态学单一事实源（#11）
│   └── webview/     # webview 端实现
│       ├── codeCardState.ts        # 卡片共享状态中立模块
│       ├── codeHighlight.ts        # 语法高亮引擎装配与缓存
│       ├── css.d.ts                # CSS 导入类型声明
│       ├── diagramExport.ts        # 图表导出序列化与光栅化
│       ├── diagramPopup.ts         # 图表弹窗全屏浮层
│       ├── diagramPopupGeometry.ts # 弹窗几何纯函数
│       ├── findSession.ts          # 查找匹配纯函数（#14）
│       ├── formatOperations.ts     # 格式文本变换规划
│       ├── graphicBlockChrome.ts   # 图形化块右上角按钮组
│       ├── graphicRenderers.ts     # 图形化渲染器注册表
│       ├── imageResource.ts        # 图片资源状态机（#10）
│       ├── keybindingRouter.ts     # 编辑器按键分发器
│       ├── keybindingSettings.ts   # 快捷键设置分页
│       ├── liveCodeCard.ts         # Live 代码块卡片装饰
│       ├── liveDecorations.ts      # 语法树驱动 Live 装饰（#8）
│       ├── liveLineNumbers.ts      # 表格段首行号与绘制探针
│       ├── liveLinks.ts            # live 链接装饰与跳转（#10）
│       ├── liveMath.ts             # 行内与块级公式 live 装饰（#59）
│       ├── liveMermaid.ts          # Mermaid live 装饰（#60）
│       ├── localeBoot.ts           # webview 语言装配入口
│       ├── main.css                # webview 全局布局样式
│       ├── main.ts                 # webview 启动入口
│       ├── markdownDoc.ts          # Markdown 文档工具与树查询
│       ├── mathRenderCache.ts      # KaTeX 渲染 LRU 缓存共享模块
│       ├── mermaidEntry.ts         # Mermaid 独立产物入口（#60）
│       ├── mermaidRender.ts        # Mermaid 渲染管线（#60）
│       ├── mermaidTheme.ts         # Mermaid 暗色主题装配
│       ├── outline.ts              # 大纲全文解析与面板装配
│       ├── outlineCollapse.ts      # 大纲折叠状态机纯函数
│       ├── outlineDrag.ts          # 大纲拖拽移动计划纯函数
│       ├── outlineLocate.ts        # 大纲定位纯函数
│       ├── outlineMenu.ts          # 大纲右键菜单模型纯逻辑
│       ├── outlineSearch.ts        # 大纲标题搜索纯函数
│       ├── outlineSection.ts       # 大纲控制域纯函数
│       ├── perfProbe.ts            # webview 性能探针（#5）
│       ├── quickActionState.ts     # 快速操作状态判定
│       ├── readingBlocks.ts        # markdown-it 阅读块切分
│       ├── readingCodeCard.ts      # 阅读代码块卡片增强
│       ├── readingMarkdown.ts      # markdown-it 安全渲染层
│       ├── readingProbe.ts         # 阅读视图性能探针
│       ├── readingView.ts          # 阅读视图 DOM 构建与锚点定位
│       ├── readingViewport.ts      # 阅读视口挂载窗口纯函数
│       ├── readingVirtualView.ts   # 阅读视图虚拟化装配层
│       ├── settingsMain.ts         # 设置页 webview 入口
│       ├── settingsPage.css        # 设置页样式
│       ├── settingsPageView.ts     # 设置页 webview 视图
│       ├── syncController.ts       # CM6 同步控制器
│       ├── tableCells.ts           # 表格单元格边界、换行与转义
│       ├── tableControls.ts        # 表格可见行控件与拖动
│       ├── tableCreate.ts          # 光标处建表规划纯函数
│       ├── tableEditing.ts         # 表格输入钩子（#12）
│       ├── tableRegion.ts          # 表格矩形选区与结构规划
│       ├── tableRegionSelection.ts # 表格格区状态与指针绘制
│       ├── tableStructure.ts       # 表格导航与增删行列纯函数（#13）
│       └── taskToggle.ts           # 任务勾选解析纯函数（#9）
├── test/…                 # 测试根
├── tsconfig.json          # TypeScript 类型检查配置
└── vitest.config.ts       # vitest 单元测试配置
<!-- file-tree:tree:end -->
```

## 文件树标签词表

<!-- file-tree:tags:begin 由脚本渲染，禁止手改 -->
| 标签 | 说明 |
| --- | --- |
| `adr` | 架构决策记录 |
| `convention` | 流程与操作约定 |
| `meta` | 仓库级配置、规则与事实源文档 |
| `research` | 技术调研报告 |
| `spec` | 产品与实施规格 |
<!-- file-tree:tags:end -->
