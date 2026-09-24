# vsidian

在 VSCode 中提供类 Obsidian 的 Markdown 编辑体验的扩展：基于源文本的**实时预览 + 阅读**双视图编辑器。MVP 主要功能已实现，人工交互与跨环境验收仍见 [验证清单](docs/specs/manual-verification.md)。

> 项目定位与功能边界见 [CONTEXT.md](CONTEXT.md)，MVP 规格见 [docs/specs/mvp.md](docs/specs/mvp.md)，架构决策见 [docs/adr/](docs/adr/)。

## 安装与使用

### 安装

1. 构建产物：`npx @vscode/vsce package --no-dependencies` 生成 `vsidian-0.1.0.vsix`（或使用已有 VSIX）。
2. VSCode（1.86+）命令面板 →「Extensions: Install from VSIX…」选择该文件，重启。

> 未发布到市场；Remote SSH 场景在远端扩展目录安装同一 VSIX（兼容性依据 [ADR-0001](docs/adr/0001-vscode-186-remote-support.md)）。

### 基本用法

- **打开文档**：对 `.md` 文件右键 →「打开方式…」→「Vsidian」（默认打开仍是原生文本编辑器，不自动接管）。
- **双视图切换**：命令面板 →「切换实时预览与阅读模式」，或编辑器工具栏按钮；源码位置锚点保持（不按滚动百分比跳变）。
- **实时预览**（live）：CodeMirror 6 全文承载，视口外不创建 DOM；标题符号在光标进入该标题时显形，列表与引用的行首符号仅在标记附近显形；链接、图片和双链仅在光标进入各自范围时显示源码。
- **阅读模式**（reading）：markdown-it 渲染的分块按需挂载，10 万块级文档挂载量与体量无关。
- **任务勾选**：两种视图点击 checkbox 写回源文本，支持撤销。
- **链接与图片**：live 视图已渲染的普通链接和双链单击跳转，源码显形后普通单击编辑，Ctrl/Cmd + 单击仍可跳转（reading 直接单击）；本地图片经宿主通道装载，缺失图呈现可重试错误态；`file://`、`javascript:` 等危险 scheme 被拦截。注：CSP 以 `img-src https:` 放行任意 https 图源（远程图床支持的设计代价——任意 https 图片可达，理论上可被用作跟踪像素）。
- **双链**：`[[笔记名]]`、`[[路径/笔记|别名]]`、`[[笔记#标题]]` 四形态；重名弹出候选选择，缺失目标提示且不自动建文件。
- **表格**：live 视图内 Tab/Shift+Tab 单元格导航、行末 Tab 移到下一表格行首格（末行末格 Tab 交默认缩进）；命令面板六个「表格：…」命令增删行列；单元格内键入 `|` 自动转义。
- **查找**：编辑器内 Ctrl+F（限本编辑器激活时）。
- **设置**：命令面板 →「Vsidian: 打开设置」，或编辑器工具栏「设置」按钮——Vsidian 的插件设置在独立设置页管理（不进入 VSCode 统一设置中心）；设置按用户级保存，重开页面与重启后保持，变更即时同步到已打开的 Vsidian 编辑器。
- **外部修改安全同步**：检测到无法安全同步的外部修改时顶部出现冲突横幅——本地输入已保留，可「复制未确认输入」或「放弃本地修改并重新同步」。

## 开发

```bash
npm install                     # 安装锁定依赖（版本全部精确锁定）
npm run compile                 # esbuild 双产物 + tsc 类型检查
npm run watch                   # esbuild watch
npm run test:unit               # vitest 单元/契约测试（无宿主依赖）
npm run test:integration        # @vscode/test-electron 1.86.2 真宿主集成测试（65 例）
node test/integration/runInstalled.mjs  # VSIX 安装态回归（先 package 出 VSIX）
node test/perf/runPerf.mjs      # 性能档位测量（报告写 docs/perf/data/）
npx @vscode/vsce package --no-dependencies  # 打包 VSIX（bundle 自包含，不带 node_modules）
```

调试：VSCode 以**文件夹工作区**打开本仓库根目录，按 F5 运行「Vsidian: 启动扩展开发宿主」。启动前会执行 `npm run compile`，开发宿主加载当前工作树的 `out/extension.js`。调试端口固定为 46186；端口被占用时修改 `.vscode/launch.json` 中的 `port`。在新窗口对 `.md` 文件执行「Reopen With…」选择「Vsidian」。

### 架构速览

- **宿主端**（`src/host/`）：`CustomTextEditorProvider`，`TextDocument` 为权威文本，编辑经 `WorkspaceEdit` 增量写回；保存/dirty/Hot Exit 由 VSCode 文本管线处理。
- **webview 端**（`src/webview/`）：CM6 EditorView（live）+ markdown-it 分块虚拟化（reading）+ `acquireVsCodeApi` 消息桥。
- **共享协议**（`src/shared/`）：两端消息协议的单一事实源，webview 全程 LF 坐标（CRLF 由宿主侧 `NewlineCoordinator` 双向转换）。
- **构建**：esbuild 双 bundle——宿主 `out/extension.js`（cjs/external vscode）+ webview `out/webview/main.js`（iife）；CSS 随 import 产出 `main.css`。

## 验证与性能

- 当前开发工作树回归：746 单元测试 + 65 集成用例（真实 1.86.2 宿主）通过；安装态与人工验收另见[验证清单](docs/specs/manual-verification.md)。
- 性能实测与功能验证矩阵：[docs/perf/2026-09-mvp-performance-summary.md](docs/perf/2026-09-mvp-performance-summary.md)。
- 人工验证项（IME/鼠标手感/远程环境）：[docs/specs/manual-verification.md](docs/specs/manual-verification.md)。

## 路线

规格与工单索引见 [docs/specs/mvp.md](docs/specs/mvp.md) 与 [docs/specs/mvp-issues.md](docs/specs/mvp-issues.md)。
