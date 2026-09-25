# Vsidian

**[English](https://github.com/ONEGAYI/vsidian/blob/main/README.en.md)** | 中文

在 VSCode 中提供类 Obsidian 的 Markdown 编辑体验：基于源文本的**实时预览 + 阅读**双视图编辑器。

## 特性

- **双视图编辑器**：实时预览由 CodeMirror 6 全文承载（视口外不创建 DOM），阅读模式由 markdown-it 分块渲染、按需挂载——10 万行 / 10 万块级文档性能与体量基本无关。
- **三态切换**：标题栏按钮在「实时预览 → 阅读 → 源码编辑器」间循环；最近停留模式跨窗口全局记住，源码位置锚点保持不跳变。`.md` / `.markdown` 默认由本扩展打开，随时可右键改回原生编辑器。
- **右侧栏与大纲**：编辑器顶栏齿轮直达设置；右侧栏按钮一键展开收起（细线／粗线两态图标，状态跨面板记忆），「大纲」面板实时展示全文标题层级——ATX 与 Setext 语义、代码围栏与 frontmatter 内伪标题不计入，随编辑即时更新；两种视图共用同一布局，切换不改动文档。
- **表格编辑**：规范表格以网格呈现，点击单元格直接格内编辑且网格保持；悬停增添行列、点阵抓手拖排行；Tab / Shift+Tab 单元格导航；命令面板六个行列命令与中英双语「创建表格」命令；格内键入 `|` 自动转义。
- **链接、图片与双链**：链接与 `[[双链]]` 在光标进入时显形源码，单击跳转；双链支持 `[[笔记]]`、`[[路径/笔记]]`、`[[笔记|别名]]`、`[[笔记#标题]]` 四形态，重名弹候选、缺失目标提示；本地图片经宿主通道装载，`file://`、`javascript:` 等危险 scheme 被拦截。
- **任务勾选**：两种视图内点击 checkbox 直接写回源文本，支持撤销。
- **查找**：编辑器内 Ctrl+F / Cmd+F（限本编辑器激活时）。
- **独立设置页**：设置在扩展自带的设置页管理（不占用 VSCode 统一设置中心），用户级保存、重开回显、变更即时生效。
- **输入与同步防护**：中文等 IME 组合期间缓冲上报，避免半截候选写回；外部修改无法安全同步时弹出冲突横幅，本地输入不丢。

## 安装

**方式一：扩展市场**（推荐）

1. VSCode（1.86+）扩展面板搜索 **Vsidian**，或打开 [Marketplace 页面](https://marketplace.visualstudio.com/items?itemName=onegayi.vsidian)。
2. 安装后重启，打开任意 `.md` 文件即进入实时预览。

**方式二：VSIX 手动安装**

从 [GitHub Releases](https://github.com/ONEGAYI/vsidian/releases) 下载最新 `vsidian-*.vsix`，命令面板 →「Extensions: Install from VSIX…」选择该文件并重启。Remote SSH 场景在远端扩展目录安装同一 VSIX（兼容性依据 [ADR-0001](docs/adr/0001-vscode-186-remote-support.md)）。

## 使用速查

| 操作 | 入口 |
| --- | --- |
| 切换视图 | 标题栏按钮循环切换，或命令面板「Vsidian: 切换到下一视图模式 / 切换到阅读模式 / 切换到实时预览」 |
| 回到源码编辑器 | 标题栏铅笔按钮，或「Vsidian: 切换到源码编辑器」 |
| 创建表格 | 命令面板「Vsidian: 创建表格 / Create a Table」 |
| 表格行列增删 | 单元格悬停控件，或命令面板六个「表格：…」命令 |
| 查找 | Ctrl+F / Cmd+F |
| 右侧栏 / 大纲 | 顶栏右侧切换按钮展开侧栏，展开后点「大纲」 |
| 设置 | 「Vsidian: 打开设置」，或编辑器顶栏齿轮按钮 |

当前设置项：**显示行号**（默认开启）——实时预览左侧行号栏显示源文件行号，表格段显示段首行号；阅读模式始终无行号。

## 已知限制

- 不支持 Obsidian 的 Canvas、白板、插件生态与 `.md` 之外的笔记格式。
- CSP 允许 `img-src https:`——任意 https 图源可达（远程图床支持的设计代价，理论上可被用作跟踪像素）。
- 表格列数不一致时显示可编辑源码而非网格。

问题反馈请到 [Issues](https://github.com/ONEGAYI/vsidian/issues)；版本历史见 [CHANGELOG](CHANGELOG.md)。

## 开发

```bash
npm install                     # 安装锁定依赖（版本全部精确锁定）
npm run compile                 # esbuild 双产物 + tsc 类型检查
npm run watch                   # esbuild watch
npm run test:unit               # vitest 与启动器契约测试（无 VSCode 宿主依赖）
npm run test:browser            # Playwright 原生键盘/IME 表格光标回归（headless Chromium，首次需 npx playwright install chromium）
npm run test:integration        # 1.86.2 真宿主集成测试（Windows 默认独立桌面，不抢前台）
node test/integration/runInstalled.mjs  # VSIX 安装态回归（先 package 出 VSIX）
node test/perf/runPerf.mjs      # 性能档位测量（报告写 docs/perf/data/）
npm run release:check           # 打包 + 发布前包内容与体积检查
npm run release                 # 以上 + 创建 GitHub Release 并上传 VSIX（需 v<version> 标签）
```

Windows 上两条集成测试路径默认将真实 VSCode 宿主启动在同一交互会话的独立桌面：测试窗口不遮挡当前桌面，宿主非零退出会使启动器失败，启动器会记录宿主 PID、独立桌面可见窗口数并每半秒采样前台 PID。独立桌面创建失败时测试直接失败，不会悄悄改为当前桌面启动。启动器将本次宿主及其子进程放入单独的 Job Object，宿主退出、启动器失败或中断时关闭该组；测试宿主默认限时 15 分钟，超时以非零退出，fixture 工作区由启动器清理。

在不支持交互式桌面的环境（例如无人登录的 CI 服务）中，可在专用 Windows 会话内显式选择前台模式：

```powershell
$env:VSIDIAN_TEST_HOST_MODE = 'foreground'
npm run test:integration
node test/integration/runInstalled.mjs
Remove-Item Env:VSIDIAN_TEST_HOST_MODE
```

发布流程、VSIX 体积红线与包内容检查的约定见 [AGENTS.md](AGENTS.md)「打包与发布」；项目定位与功能边界见 [CONTEXT.md](CONTEXT.md)，MVP 规格见 [docs/specs/mvp.md](docs/specs/mvp.md)，架构决策见 [docs/adr/](docs/adr/)。

## 许可证

[MIT](LICENSE)
