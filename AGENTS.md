# vscode-obsidian-like-editor

VSCode 扩展：在 VSCode 中提供类 Obsidian 的 Markdown 编辑体验。

> 当前状态：工单 #2 已落地基础骨架——可选自定义编辑器（Reopen With 启用）打开 `.md`，CM6 承载全文、增量写回 TextDocument。功能范围与规格见 [docs/specs/mvp.md](docs/specs/mvp.md)。本文件是项目级 agent 规则的**单一事实源**。

## 约定

- 通用工程规范（提交规范、TDD、文件树维护）遵循工程根 `D:\CODE\Project\AGENTS.md`，此处不重复展开。

## 技术栈与构建（工单 #2 确立）

- **运行时**：TypeScript + CodeMirror 6（`@codemirror/state`、`@codemirror/view`、`@codemirror/commands`，单包组合，不用 `codemirror` 聚合包与 basicSetup/history——撤销栈归宿主文本管线）。阅读模式将用 markdown-it（后续工单引入）。
- **宿主端**（`src/extension.ts`、`src/host/`）：`CustomTextEditorProvider`，保存/dirty/Hot Exit 由 VSCode 文本管线自动处理；`TextDocument` 为权威文本，编辑经 `WorkspaceEdit` 写回。
- **webview 端**（`src/webview/`）：CM6 EditorView + `acquireVsCodeApi` 消息桥；`src/shared/` 为两端共享的消息协议单一事实源（不依赖 vscode/DOM）。协议约定 webview 全程 LF 坐标（CM6 内部把 `\r\n` 规范化为 `\n`，宿主侧 `NewlineCoordinator` 负责双向坐标与文本转换）。
- **构建**：esbuild 双产物——宿主 `out/extension.js`（node18/cjs/external vscode）、webview `out/webview/main.js`（chrome118/iife，CSS 随 import 打包为 `main.css`）；`npm run compile` 另跑 `tsc --noEmit` 做类型检查（esbuild 不查类型）。
- **测试**：`npm run test:unit`（vitest，纯逻辑 + jsdom 的 webview 控制器）；`npm run test:integration`（@vscode/test-electron 指定 1.86.2 真宿主，fixture 由 `test/integration/runTest.mjs` 动态生成）。扩展注册 `onegayi.obsidian-like-editor._test.*` 辅助命令供集成测试观测/注入。
- **版本锁定**：依赖一律精确版本（无 `^`），提交 lockfile；`engines.vscode ^1.86.0` 与 `@types/vscode 1.86.0` 对齐。`@types/node` 锁 22.x（vitest 5 的 vite peer 要求数 >=20.19，类型不进产物，宿主代码仍按 Node 18 API 面编码）。版本依据探索笔记（orch 仓库 exploration/01）。

## Agent skills

### Issue tracker

使用 GitHub Issues 跟踪需求、缺陷与任务，仓库为 `ONEGAYI/vscode-obsidian-like-editor`。操作约定见 [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md)。

### Domain docs

采用单一领域上下文；术语与架构决策按需记录。读取与维护约定见 [docs/agents/domain.md](docs/agents/domain.md)。

## 文件树（简版速览）

```
<!-- file-tree:tree:begin 由脚本渲染，禁止手改 -->
vscode-obsidian-like-editor/
├── .agents/          # agent 技能与本地配置
│   └── skills/ # 已部署 agent 技能
│       └── file-tree/ # file-tree 技能部署实例
├── .gitignore        # Git 忽略规则
├── .scratch/         # MVP 开票草稿，临时目录
├── .vscodeignore     # VSIX 打包排除清单
├── AGENTS.md         # 项目级 agent 规则单一事实源
├── CLAUDE.md         # Claude 专属规则导入入口
├── CONTEXT.md        # 领域语言与产品边界事实源
├── docs/             # 项目文档根
│   ├── adr/      # 架构决策记录
│   │   ├── 0001-vscode-186-remote-support.md     # 兼容 VSCode 1.86 与远程
│   │   ├── 0002-wikilink-on-demand-resolution.md # 双链按需解析不建持久索引
│   │   ├── 0003-source-text-dual-view-editor.md  # 基于源文本的双视图编辑架构
│   │   ├── 0004-stable-styling-contract.md       # 一期建立稳定样式入口
│   │   └── 0005-viewport-rendering.md            # 全文模型与视口渲染分离
│   ├── agents/   # agent 操作约定
│   │   ├── domain.md        # 领域文档读取与维护约定
│   │   └── issue-tracker.md # GitHub Issues 操作约定
│   ├── research/ # 技术调研报告
│   │   ├── obsidian-live-preview-editor.md # Obsidian 技术栈与选型调研
│   │   └── obsidian-viewport-rendering.md  # 视口渲染性能补充调研
│   └── specs/    # 产品规格
│       ├── mvp-issues.md # MVP GitHub Issue 索引
│       └── mvp.md        # MVP 规格主文档
├── esbuild.mjs       # esbuild 双产物构建脚本
├── package-lock.json # npm 依赖锁定文件
├── package.json      # 扩展清单与锁定依赖
├── README.md         # 项目门面说明
├── src/              # 扩展源码
│   ├── extension.ts # 扩展激活入口
│   ├── host/        # 宿主端实现
│   │   ├── documentSession.ts    # 文档会话与写回同步
│   │   └── textEditorProvider.ts # 自定义文本编辑器提供者
│   ├── shared/      # 两端共享纯逻辑
│   │   ├── changeMapping.ts # 变更重定位纯函数
│   │   ├── newline.ts       # CRLF/LF 换行协调器
│   │   └── protocol.ts      # 消息协议单一事实源
│   └── webview/     # webview 端实现
│       ├── css.d.ts          # CSS 导入类型声明
│       ├── main.css          # webview 全局布局样式
│       ├── main.ts           # webview 启动入口
│       └── syncController.ts # CM6 同步控制器
├── test/             # 测试根
│   ├── integration/ # 真宿主集成测试
│   │   ├── runTest.mjs # 集成测试启动器
│   │   └── suite/      # 集成测试套件
│   │       ├── cases.ts # 集成测试用例
│   │       └── index.ts # 集成测试入口 runner
│   └── unit/        # vitest 单元契约测试
│       ├── changeMapping.test.ts     # 变更重定位契约
│       ├── compositionBuffer.test.ts # 组合期间缓冲契约测试
│       ├── documentSession.test.ts   # 文档会话契约
│       ├── historyForwarding.test.ts # 撤销重做转发契约测试
│       ├── newline.test.ts           # 换行协调契约
│       ├── protocol.test.ts          # 消息协议校验契约
│       └── webviewSync.test.ts       # webview 同步契约
├── tsconfig.json     # TypeScript 类型检查配置
└── vitest.config.ts  # vitest 单元测试配置
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
