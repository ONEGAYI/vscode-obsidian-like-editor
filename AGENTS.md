# vsidian

VSCode 扩展：在 VSCode 中提供类 Obsidian 的 Markdown 编辑体验。

> 当前状态：**MVP 主要功能已实施，整体验收未结**。双视图编辑器、增量写回、任务、链接与图片、双链、表格和查找已落地；#32 统一两模式基础排版基线，#33 独立设置页，#34 实时预览源文件行号（设置页可开关）；#38 落地标题栏三态切换（实时预览 → 阅读 → 源码编辑器循环）、`.md` 默认编辑器接管、全局模式记忆（globalState）与 diff 语境防御；本联合分支整合 #45 后台集成宿主、#44 IME 同步修复、#42 表格逐格编辑网格、#43 表格控件与拖排和双语建表命令。#21–#25、#28、#30 跟进规格票验收缺口，#26–#27 等人工与跨环境事项仍按验证清单跟进。
>
> 自动化套件为 943 项 Vitest 单测、21 项 node --test 契约测试（集成启动器 11 + 发布脚本 10）、31 项原生浏览器输入回归，以及开发态与 VSIX 安装态共用的 88 项真实 VSCode 1.86.2 宿主集成用例（另有空窗口激活实测路径）。单元格删除边界、跨行拖选标记保护、中格退格后的网格绘制、Tab 可见行导航、格内粘贴换行、多表行号和中文候选写回均有回归保护，执行记录见人工验证清单；这不代表真实 IME、物理鼠标和视觉效果已由用户验收。发布基建（双语 README、CHANGELOG、VSIX 体积闸、发布脚本与 CI 自动发布）已落地，见「打包与发布」。功能范围见 [docs/specs/mvp.md](docs/specs/mvp.md)；性能数据与待验项见 [docs/perf/2026-09-mvp-performance-summary.md](docs/perf/2026-09-mvp-performance-summary.md) 和 [docs/specs/manual-verification.md](docs/specs/manual-verification.md)。本文件是项目级 agent 规则的**单一事实源**。

## 约定

- 通用工程规范（提交规范、TDD、文件树维护）遵循工程根 `D:\CODE\Project\AGENTS.md`，此处不重复展开。
- **插件设置入口**：Vsidian 面向用户的设置统一在扩展自己的设置页面展示与修改，不复用 VSCode 统一设置中心作为设置界面。后续新增设置项时，同步纳入该页面，并验证设置持久化、重新打开后的回显及变更生效。
- **视觉层断言（评审必查）**：webview/样式/渲染类变更，评审必须核对断言对象是"用户看到的东西"（可见性、对齐、颜色）而非 DOM 存在性或几何坐标——样式注入失效时后者照样通过（PR #37 P0 实证：CSP 拦截 CM6 注入样式后 74 集成用例仍全绿，正文实际不可见）。涉及呈现的新特性至少一条集成断言落在绘制层（现有 `view.state.paint` 探针），CSS 关键规则由契约测试钉住。

## 技术栈与构建（工单 #2 确立）

- **运行时**：TypeScript + CodeMirror 6（`@codemirror/state`、`@codemirror/view`、`@codemirror/commands`，单包组合，不用 `codemirror` 聚合包与 basicSetup/history——撤销栈归宿主文本管线）。阅读模式将用 markdown-it（后续工单引入）。
- **宿主端**（`src/extension.ts`、`src/host/`）：`CustomTextEditorProvider`，保存/dirty/Hot Exit 由 VSCode 文本管线自动处理；`TextDocument` 为权威文本，编辑经 `WorkspaceEdit` 写回。
- **webview 端**（`src/webview/`）：CM6 EditorView + `acquireVsCodeApi` 消息桥；`src/shared/` 为两端共享的消息协议单一事实源（不依赖 vscode/DOM）。协议约定 webview 全程 LF 坐标（CM6 内部把 `\r\n` 规范化为 `\n`，宿主侧 `NewlineCoordinator` 负责双向坐标与文本转换）。
- **构建**：esbuild 多产物——宿主 `out/extension.js`（node18/cjs/external vscode）、编辑器 webview `out/webview/main.js` 与设置页 webview `out/webview/settings.js`（#33；chrome118/iife，CSS 随 import 打包为同名 `.css`）；`npm run compile` 另跑 `tsc --noEmit` 做类型检查（esbuild 不查类型）。
- **测试**：`npm run test:unit`（vitest + `node --test` 启动器契约，纯逻辑 + jsdom 的 webview 控制器，无 VSCode 宿主依赖；`VSIDIAN_TEST_HOST_MODE=foreground` 时跳过独立桌面探针）；`npm run test:browser`（Playwright headless Chromium，用原生键盘/IME 驱动生产控制器验证表格光标与输入回流——keydown 注入测不到 `input.type` 回流路径，**涉及 webview 输入/光标行为的变更合并前必跑**，首次需 `npx playwright install chromium`；CI 的 browser job 在 Linux runner 上跑同一脚本并缓存浏览器二进制，通道同为 Playwright chromium，与本地默认一致，`VSIDIAN_TEST_BROWSER_CHANNEL=msedge` 仅本机借系统 Edge 调试用，不进 CI）；`npm run test:integration`（1.86.2 真宿主，fixture 由 `test/integration/fixtures.mjs` 统一生成，开发态 `runTest.mjs` 与安装态 `runInstalled.mjs` 及空窗口激活 `runSettingsActivation.mjs` 三条路径共用 `testHost.mjs` 启动策略：Windows 默认独立桌面不抢前台，`VSIDIAN_TEST_HOST_MODE=foreground` 切前台）。扩展注册 `onegayi.vsidian._test.*` 辅助命令供集成测试观测/注入（仅 `VSIDIAN_TEST_HOOKS=1` 时注册）。测试消息通道是**宿主侧门控、webview 侧被动接收**的分层设计：`_test.*` 注入命令（含向 webview 转发 `table.test.key`/`task.test.click`/`reading.test.image` 等）在宿主侧受 `VSIDIAN_TEST_HOOKS` 门控；webview 侧这些消息分支不做二次门控——webview 面板的消息源只有扩展自身（`panel.webview.postMessage`），封住注入源即封住入口，勿误判为 webview 未设防。
- **打包与安装态回归（#15）**：`npx @vscode/vsce package --no-dependencies` 产出 VSIX（esbuild bundle 自包含，不带 node_modules；`.vscodeignore` 排除 src/test/docs）。`node test/integration/runInstalled.mjs` 把 VSIX 经 `--install-extension` 装入隔离 profile 的 1.86.2 便携宿主（安装注册链路真实走通；1.86 测试模式要求 `--extensionTestsPath` 依赖 `--extensionDevelopmentPath` 同时存在，故 dev path 指向安装解压目录——加载代码仍是 VSIX 产物而非仓库源码树）后跑同一集成套件。
- **性能测量**：`node test/perf/runPerf.mjs`（1千/1万/10万行、10 KB/100 KB/1 MB、超长行、图片密集与大围栏；报告写 `docs/perf/data/perf-report.json`）；档位数据与解读汇总在 [docs/perf/2026-09-mvp-performance-summary.md](docs/perf/2026-09-mvp-performance-summary.md)。
- **版本锁定**：依赖一律精确版本（无 `^`），提交 lockfile；`engines.vscode ^1.86.0` 与 `@types/vscode 1.86.0` 对齐。`@types/node` 锁 22.x（vitest 5 的 vite peer 要求数 >=20.19，类型不进产物，宿主代码仍按 Node 18 API 面编码）。版本依据探索笔记（orch 仓库 exploration/01）。

## 打包与发布

- **体积红线**：VSIX 解压总量警告 1.5 MB / 上限 2.5 MB，一般单文件警告 700 KB / 上限 1 MB，图标上限 100 KB（256×256）。阈值定义在 `scripts/release.mjs` 的 `SIZE_LIMITS`；修改阈值视同变更本约定，需同步本节。
- **双重防线**：`.vscodeignore` 挡打包输入，`scripts/release.mjs` 的 `inspectVsixEntries` 检查最终产物（必需清单 + 禁止模式 + 体积阈值），每次发布前必跑（`npm run release:check`，或随 `npm run release` / CI 自动执行）。新增运行时资产时两处同步维护：`.vscodeignore` 放行 + `REQUIRED_EXTENSION` 登记；漏登记会被发布检查拦下（`.github/` 混入包内即此类事故，实测发生过）。
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
│       └── file-tree/ # file-tree 技能部署实例
├── .github/               # GitHub 平台配置
│   └── workflows/ # Actions 工作流目录
│       ├── ci.yml      # GitHub CI 工作流
│       └── release.yml # v* 标签触发的发布工作流
├── .gitignore             # Git 忽略规则
├── .scratch/              # MVP 开票草稿，临时目录
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
│   │   ├── 2026-09-live-syntax-decorations.md   # 语法树装饰与大围栏细分实测（#8）
│   │   ├── 2026-09-math-rendering.md            # 公式渲染性能实测（#59）
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
│       ├── manual-verification.md # 人工验证清单
│       ├── mvp-issues.md          # MVP GitHub Issue 索引
│       └── mvp.md                 # MVP 规格主文档
├── esbuild.mjs            # esbuild 多产物构建脚本
├── LICENSE                # MIT 许可证全文
├── media/                 # 随扩展打包的静态资源
│   ├── css-contract-probe.css # 样式契约内部测试片段
│   ├── vsidian-icon-256.png   # 扩展图标 256 版，VSIX 打包用
│   └── vsidian-icon.png       # Vsidian 扩展图标
├── package-lock.json      # npm 依赖锁定文件
├── package.json           # 扩展清单与锁定依赖
├── package.nls.json       # 命令默认英文文案
├── package.nls.zh-cn.json # 命令简体中文文案
├── README.en.md           # 英文版 README，与中文版互指
├── README.md              # 项目门面说明
├── scripts/               # 仓库工具脚本目录
│   └── release.mjs # 发布脚本：打包、包体检查与上传
├── src/                   # 扩展源码
│   ├── extension.ts # 扩展激活入口
│   ├── host/        # 宿主端实现
│   │   ├── documentSession.ts    # 文档会话与写回同步
│   │   ├── linkTarget.ts         # 宿主侧链接目标分类纯逻辑（#10）
│   │   ├── settingsPage.ts       # 独立设置页面板装配
│   │   ├── settingsService.ts    # 宿主设置服务
│   │   ├── textEditorProvider.ts # 自定义文本编辑器提供者
│   │   ├── viewCycle.ts          # 三态视图编排纯逻辑
│   │   └── wikilinkTarget.ts     # 宿主侧双链目标解析纯逻辑（#11）
│   ├── shared/      # 两端共享纯逻辑
│   │   ├── changeMapping.ts # 变更重定位纯函数
│   │   ├── math.ts          # 公式形态学纯函数（#59）
│   │   ├── newline.ts       # CRLF/LF 换行协调器
│   │   ├── protocol.ts      # 消息协议单一事实源
│   │   ├── settings.ts      # 设置定义与读写纯逻辑
│   │   └── wikilink.ts      # 双链形态学单一事实源（#11）
│   └── webview/     # webview 端实现
│       ├── css.d.ts              # CSS 导入类型声明
│       ├── findSession.ts        # 查找匹配纯函数（#14）
│       ├── imageResource.ts      # 图片资源状态机（#10）
│       ├── liveDecorations.ts    # 语法树驱动 Live 装饰（#8）
│       ├── liveLineNumbers.ts    # 表格段首行号与绘制探针
│       ├── liveLinks.ts          # live 链接装饰与跳转（#10）
│       ├── liveMath.ts           # 行内与块级公式 live 装饰（#59）
│       ├── main.css              # webview 全局布局样式
│       ├── main.ts               # webview 启动入口
│       ├── markdownDoc.ts        # Markdown 文档工具与树查询
│       ├── mathRenderCache.ts    # KaTeX 渲染 LRU 缓存共享模块
│       ├── perfProbe.ts          # webview 性能探针（#5）
│       ├── readingBlocks.ts      # markdown-it 阅读块切分
│       ├── readingMarkdown.ts    # markdown-it 安全渲染层
│       ├── readingProbe.ts       # 阅读视图性能探针
│       ├── readingView.ts        # 阅读视图 DOM 构建与锚点定位
│       ├── readingViewport.ts    # 阅读视口挂载窗口纯函数
│       ├── readingVirtualView.ts # 阅读视图虚拟化装配层
│       ├── settingsMain.ts       # 设置页 webview 入口
│       ├── settingsPage.css      # 设置页样式
│       ├── settingsPageView.ts   # 设置页 webview 视图
│       ├── syncController.ts     # CM6 同步控制器
│       ├── tableCells.ts         # 表格单元格边界、换行与转义
│       ├── tableControls.ts      # 表格可见行控件与拖动
│       ├── tableCreate.ts        # 光标处建表规划纯函数
│       ├── tableEditing.ts       # 表格输入钩子（#12）
│       ├── tableStructure.ts     # 表格导航与增删行列纯函数（#13）
│       └── taskToggle.ts         # 任务勾选解析纯函数（#9）
├── test/                  # 测试根
│   ├── browser/     # 浏览器原生输入回归
│   │   ├── tableCaret.mjs       # 表格原生键盘与IME回归
│   │   └── tableCaretFixture.ts # 原生输入测试生产控制器装配
│   ├── integration/ # 真宿主集成测试
│   │   ├── fixtures.mjs              # 集成测试 fixture 单一事实源
│   │   ├── hiddenDesktop.ps1         # Windows 独立桌面启动器
│   │   ├── runInstalled.mjs          # VSIX 安装态集成回归启动器
│   │   ├── runSettingsActivation.mjs # 空窗口激活实测启动器
│   │   ├── runTest.mjs               # 集成测试启动器
│   │   ├── settingsActivation/       # 空窗口命令激活实测套件（#33）
│   │   │   └── index.ts # 空窗口命令激活实测套件
│   │   ├── suite/                    # 集成测试套件
│   │   │   ├── cases.ts # 集成测试用例
│   │   │   └── index.ts # 集成测试入口 runner
│   │   ├── testHost.mjs              # 集成宿主启动策略
│   │   └── testHost.test.mjs         # 集成宿主启动契约测试
│   ├── perf/        # 性能测量脚本与套件（#5）
│   │   ├── gen-sample.mjs # 性能样例生成器（#5）
│   │   ├── runPerf.mjs    # 性能测量启动器（#5）
│   │   └── suite.ts       # 性能测量套件（#5）
│   ├── release/     # 发布脚本契约测试目录
│   │   └── release.test.mjs # 发布脚本纯函数契约测试
│   └── unit/        # vitest 单元契约测试
│       ├── appliedUnackedRace.test.ts      # 已应用未确认竞态契约测试
│       ├── changeMapping.test.ts           # 变更重定位契约
│       ├── compositionBuffer.test.ts       # 组合期间缓冲契约测试
│       ├── conflictRetention.test.ts       # 冲突保留与暂停契约测试
│       ├── documentSession.test.ts         # 文档会话契约
│       ├── editorChromeCssContract.test.ts # 编辑器铬件主题适配契约测试
│       ├── find.test.ts                    # 查找会话契约测试（#14）
│       ├── findSession.test.ts             # 查找匹配语义测试（#14）
│       ├── historyForwarding.test.ts       # 撤销重做转发契约测试
│       ├── imageResource.test.ts           # 图片资源管理器契约测试
│       ├── lineNumberCssContract.test.ts   # 行号公式与 CSS 双写钉子测试
│       ├── lineNumbers.test.ts             # 行号装配契约测试（#34）
│       ├── linkInteraction.test.ts         # 链接交互契约测试（#10）
│       ├── linkTarget.test.ts              # 链接目标分类契约测试
│       ├── liveDecorations.test.ts         # Live 装饰契约测试
│       ├── liveMath.test.ts                # live 公式装饰契约测试（#59）
│       ├── liveTable.test.ts               # live 表格装饰测试（#12）
│       ├── markdownDoc.test.ts             # 文档工具契约测试
│       ├── mathPaintCssContract.test.ts    # 公式绘制样式契约测试（#59）
│       ├── mathScan.test.ts                # 公式形态学契约测试（#59）
│       ├── newline.test.ts                 # 换行协调契约
│       ├── perfProbe.test.ts               # 性能探针契约测试
│       ├── protocol.test.ts                # 消息协议校验契约
│       ├── readingBlocks.test.ts           # 阅读块切分契约测试
│       ├── readingMarkdown.test.ts         # 渲染层契约测试
│       ├── readingMath.test.ts             # 阅读公式渲染契约测试（#59）
│       ├── readingTable.test.ts            # 阅读表格契约测试（#12）
│       ├── readingView.test.ts             # 阅读视图 DOM 契约测试
│       ├── readingViewport.test.ts         # 视口窗口纯函数契约测试
│       ├── readingVirtualView.test.ts      # 虚拟化装配契约测试
│       ├── settings.test.ts                # 设置纯逻辑契约测试
│       ├── settingsInteraction.test.ts     # 设置交互契约测试
│       ├── settingsPage.test.ts            # 设置页 UI 契约测试
│       ├── settingsPageHost.test.ts        # 设置页宿主生命周期测试
│       ├── settingsService.test.ts         # 设置服务契约测试
│       ├── suspendResume.test.ts           # 暂停恢复契约测试
│       ├── tableCells.test.ts              # 单元格拆分契约测试（#12）
│       ├── tableCreate.test.ts             # 建表与本地化契约测试
│       ├── tableOps.test.ts                # 表格导航与结构命令链路契约（#13）
│       ├── tablePaintCssContract.test.ts   # 表格绘制样式契约测试
│       ├── tableStructure.test.ts          # 表格结构操作纯函数契约（#13）
│       ├── taskInteraction.test.ts         # 任务勾选交互契约测试（#9）
│       ├── taskToggle.test.ts              # 任务勾选解析纯函数契约测试
│       ├── viewCycle.test.ts               # 三态视图编排契约测试
│       ├── viewMode.test.ts                # 模式切换状态机契约测试
│       ├── webviewSync.test.ts             # webview 同步契约
│       ├── wikilinkInteraction.test.ts     # 双链交互契约测试（#11）
│       ├── wikilinkParse.test.ts           # 双链形态学契约测试（#11）
│       └── wikilinkTarget.test.ts          # 双链目标解析契约测试（#11）
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
