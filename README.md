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
- **实时预览**（live）：CodeMirror 6 全文承载，视口外不创建 DOM；左侧显示源文件行号，安全网格表格只显示段首行号（可在设置页开关，见下）；标题符号在光标进入该标题时显形，列表与引用的行首符号仅在标记附近显形；链接、图片和双链仅在光标进入各自范围时显示源码。
- **阅读模式**（reading）：markdown-it 渲染的分块按需挂载，10 万块级文档挂载量与体量无关。
- **任务勾选**：两种视图点击 checkbox 写回源文本，支持撤销。
- **链接与图片**：live 视图已渲染的普通链接和双链单击跳转，源码显形后普通单击编辑，Ctrl/Cmd + 单击仍可跳转（reading 直接单击）；本地图片经宿主通道装载，缺失图呈现可重试错误态；`file://`、`javascript:` 等危险 scheme 被拦截。注：CSP 以 `img-src https:` 放行任意 https 图源（远程图床支持的设计代价——任意 https 图片可达，理论上可被用作跟踪像素）。
- **双链**：`[[笔记名]]`、`[[路径/笔记|别名]]`、`[[笔记#标题]]` 四形态；重名弹出候选选择，缺失目标提示且不自动建文件。
- **表格**：live 视图的安全普通表格以网格显示，点击单元格后可直接在格内编辑且网格保持；可从悬停入口增添行列、用点阵抓手拖排行，行列选中有边框反馈；Tab/Shift+Tab 单元格导航，行末 Tab 移到下一表格行首格（末行末格 Tab 交默认缩进）；命令面板六个「表格：…」命令增删行列；单元格内键入 `|` 自动转义。列数不一致的表格显示可编辑源码。
- **创建表格**：命令面板执行「Vsidian: Create a Table」或中文界面的「Vsidian: 创建表格」，在光标处建立两列、空表头加一行空数据的表格。光标在行内文字之间时，左右文字分到表格上下，并各隔一空行；一次撤销可恢复原文。
- **单元格选择与删除**：格内拖选、双击、三击及 Ctrl/Cmd+A 限定在当前格内容；删除保留源管道和对齐声明，格内空白仍可编辑。省略首尾管道的行在清空边缘格产生列数歧义时自动补齐边界；会暴露额外列的删除被阻止。
- **中列点击定位**：三列表格点击中间文字格或空格时，光标和输入保持在中列；完全零宽的空格在编辑器聚焦时显示格内光标提示。
- **查找**：编辑器内 Ctrl+F（限本编辑器激活时）。
- **设置**：命令面板 →「Vsidian: 打开设置」，或编辑器工具栏「设置」按钮——Vsidian 的插件设置在独立设置页管理（不进入 VSCode 统一设置中心）；设置按用户级保存，重开页面与重启后保持，变更即时同步到已打开的 Vsidian 编辑器。当前提供「显示行号」开关（默认开启，实时预览左侧行号栏；阅读模式始终无行号）。
- **外部修改安全同步**：检测到无法安全同步的外部修改时顶部出现冲突横幅——本地输入已保留，可「复制未确认输入」或「放弃本地修改并重新同步」。

## 开发

```bash
npm install                     # 安装锁定依赖（版本全部精确锁定）
npm run compile                 # esbuild 双产物 + tsc 类型检查
npm run watch                   # esbuild watch
npm run test:unit               # vitest 与启动器契约测试（无 VSCode 宿主依赖）
npm run test:integration        # @vscode/test-electron 1.86.2 真宿主集成测试
node test/integration/runInstalled.mjs  # VSIX 安装态回归（先 package 出 VSIX）
node test/perf/runPerf.mjs      # 性能档位测量（报告写 docs/perf/data/）
npx @vscode/vsce package --no-dependencies  # 打包 VSIX（bundle 自包含，不带 node_modules）
```

Windows 上两条集成测试路径默认将真实 VSCode 宿主启动在同一交互会话的独立桌面。测试窗口在该桌面创建，不遮挡当前桌面；日志继续输出到终端，宿主非零退出会使启动器失败。启动器会记录宿主 PID、独立桌面的可见窗口数，并在测试期间每半秒采样前台 PID，便于复查焦点行为。独立桌面创建失败时测试直接失败，不会悄悄改为当前桌面启动。

Windows 启动器将本次宿主及其子进程放入单独的 Job Object（进程组），宿主退出、启动器失败或中断时关闭该组，避免残留独立桌面进程；不会按进程名结束其他 VSCode。测试宿主默认限时 15 分钟，超时以非零退出，fixture 工作区仍由启动器清理。手动终止最外层 Node 启动器时，PowerShell 会检测父进程退出并关闭该进程组。正常取消可用 Ctrl+C。

在不支持交互式桌面的环境（例如无人登录的 CI 服务）中，可使用独立的 Windows 用户会话或虚拟机运行，并在该会话内显式选择前台模式：

```powershell
$env:VSIDIAN_TEST_HOST_MODE = 'foreground'
npm run test:integration
node test/integration/runInstalled.mjs
Remove-Item Env:VSIDIAN_TEST_HOST_MODE
```

前台模式会显示测试窗口，应在专用会话中使用。单测和类型检查不启动 VSCode。

若缓存里的 `.vscode-test/vscode-win32-x64-archive-1.86.2/data` 由人工便携版运行留下，VSCode 会优先使用其中的便携 profile；此时可能撞上正在运行的便携版实例。可在新的 worktree 执行 `npm ci` 和 `npm run test:integration`，让测试工具自动下载不含 `data` 的独立宿主，再打包 VSIX 运行安装态回归。不要把正在使用的便携版目录当作测试宿主缓存。

调试：VSCode 以**文件夹工作区**打开本仓库根目录，按 F5 运行「Vsidian: 启动扩展开发宿主」。启动前会执行 `npm run compile`，开发宿主加载当前工作树的 `out/extension.js`。调试端口固定为 46186；端口被占用时修改 `.vscode/launch.json` 中的 `port`。在新窗口对 `.md` 文件执行「Reopen With…」选择「Vsidian」。

### 架构速览

- **宿主端**（`src/host/`）：`CustomTextEditorProvider`，`TextDocument` 为权威文本，编辑经 `WorkspaceEdit` 增量写回；保存/dirty/Hot Exit 由 VSCode 文本管线处理。
- **webview 端**（`src/webview/`）：CM6 EditorView（live）+ markdown-it 分块虚拟化（reading）+ `acquireVsCodeApi` 消息桥。
- **共享协议**（`src/shared/`）：两端消息协议的单一事实源，webview 全程 LF 坐标（CRLF 由宿主侧 `NewlineCoordinator` 双向转换）。
- **构建**：esbuild 多 bundle——宿主 `out/extension.js`（cjs/external vscode）+ webview 双入口 `out/webview/main.js` 与 `out/webview/settings.js`（iife）；CSS 随 import 产出 `main.css`/`settings.css`。

## 验证与性能

- 本联合分支自动化套件包含 886 项 Vitest 单测、11 项启动器契约测试，以及开发态与 VSIX 安装态共用的 88 项真实 VSCode 1.86.2 宿主集成用例。覆盖单元格删除边界、跨行拖选时表格标记保护、中格空白退格后再输入的网格绘制、多表编辑后的行号绘制、真实 DOM 中文候选经 WorkspaceEdit 保存回读，以及关闭队列和确认重传；执行结果与人工复验见[验证清单](docs/specs/manual-verification.md)。
- 性能实测与功能验证矩阵：[docs/perf/2026-09-mvp-performance-summary.md](docs/perf/2026-09-mvp-performance-summary.md)。
- 人工验证项（IME/鼠标手感/远程环境）：[docs/specs/manual-verification.md](docs/specs/manual-verification.md)。

## 路线

规格与工单索引见 [docs/specs/mvp.md](docs/specs/mvp.md) 与 [docs/specs/mvp-issues.md](docs/specs/mvp-issues.md)。
