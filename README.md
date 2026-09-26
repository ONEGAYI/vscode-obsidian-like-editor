# Vsidian

**[English](https://github.com/ONEGAYI/vsidian/blob/main/README.en.md)** | 中文

在 VSCode 中提供类 Obsidian 的 Markdown 编辑体验：基于源文本的**实时预览 + 阅读**双视图编辑器。

## 特性

- **双视图编辑器**：实时预览由 CodeMirror 6 全文承载（视口外不创建 DOM），阅读模式由 markdown-it 分块渲染、按需挂载——10 万行 / 10 万块级文档性能与体量基本无关。
- **三态切换**：标题栏按钮在「实时预览 → 阅读 → 源码编辑器」间循环；最近停留模式跨窗口全局记住，源码位置锚点保持不跳变。`.md` / `.markdown` 默认由本扩展打开，随时可右键改回原生编辑器。
- **右侧栏与大纲**：编辑器顶栏齿轮直达设置；右侧栏按钮一键展开收起（细线／粗线两态图标，状态跨面板记忆）。「大纲」面板：标题层级实时同步（ATX/Setext 语义、代码围栏与 frontmatter 伪标题不计入）；点击条目跳转正文对应标题（双模式），常驻高亮指示当前所在章节；六档「结绳」滑块统一展开深度，条目箭头手动折叠，滚动自动展开当前路径；工具条提供跳转末尾、重置与标题搜索（片段级高亮）；标题行内样式（粗体、斜体、行内代码、删除线）与主题层级配色同源透传；右键菜单提供结构命令、五项复制、调整层级、重命名（保留行内标记）与整段删除；拖拽标题按「控制域」整段重排，控制域外内容零误伤，一次撤销完整回滚。
- **表格编辑**：规范表格以网格呈现，点击单元格直接编辑；跨格拖选形成矩形高亮，复制为独立 Markdown 表格。边沿悬停新增行列，点阵把手单击选行列、拖动重排；Tab / Shift+Tab 单元格导航，格内键入 `|` 自动转义；命令面板另有六个行列命令与中英双语「创建表格」命令。
- **格式命令**：实时预览中可从命令面板切换粗体、斜体、删除线、行内代码、标题、列表、引用、代码块与链接，或清除行内格式；可插入公式与双链。显式选区优先，无选区的行内格式作用于当前词；一次操作可一次撤销。
- **快速操作条**：编辑器顶栏的笔形按钮可展开流内格式工具条；常用格式、标题层级弹出菜单与建表入口直接作用于原选区，展开状态会记住。阅读模式下格式写操作不可用。
- **链接、图片与双链**：链接与 `[[双链]]` 在光标进入时显形源码，单击跳转；双链支持 `[[笔记]]`、`[[路径/笔记]]`、`[[笔记|别名]]`、`[[笔记#标题]]` 四形态，重名弹候选、缺失目标提示；本地图片经宿主通道装载，`file://`、`javascript:` 等危险 scheme 被拦截。
- **公式渲染**：行内 `$…$` 与块级 `$$…$$` 的 LaTeX 公式在实时预览与阅读模式渲染（KaTeX 本地打包，无 CDN）；光标进入公式显形源码直接编辑，解析失败稳定降级为可读原文；普通美元、转义与代码区不误判。
- **Mermaid 图表**：语言标记为 `mermaid` 的围栏代码块在实时预览与阅读模式渲染为图（流程图、时序图等；mermaid 本地打包按需加载，无 CDN）；光标进入围栏显形源码直接编辑，语法错误降级为错误提示与可读源码，不影响后续内容；明暗主题自动联动，图内链接不执行跳转。
- **任务勾选**：两种视图内点击 checkbox 直接写回源文本，支持撤销。
- **查找**：编辑器内 Ctrl+F / Cmd+F（限本编辑器激活时）。
- **独立设置页**：设置在扩展自带的设置页管理（不占用 VSCode 统一设置中心），左侧分类导航和全局搜索可按名称或说明定位设置；支持明暗主题、窄窗口与键盘操作。用户级保存、重开回显、变更即时生效，保存失败恢复生效值并提示。
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
| 文本格式 | 命令面板「Vsidian: 粗体」等格式命令；Ctrl+B 切换粗体，Ctrl+1–6 设置对应级别标题，Ctrl+0 取消标题（仅实时预览正文） |
| 快速操作条 | 点击编辑器顶栏的笔形按钮展开；选择格式按钮或从「H⌄」菜单选择 H1–H6／正文；再次点击顶栏按钮收起 |
| 表格新增行列 | 靠近底边／右边显示新增带，或使用命令面板「表格：…」命令 |
| 表格选择与复制 | 跨格拖选矩形区域；Ctrl+C / Cmd+C 复制为完整 Markdown 表格，以选区首行为表头 |
| 表格删除 | Delete / Backspace 清空局部区域；满行／满列选区删除对应行／列，整表选区删除整表；空行首格起点退格删除该行 |
| 表格行列重排 | 悬停左沿／上沿的点阵把手；单击选行／列，拖到插入线处松开移动；最上方一行作为表头 |
| 查找 | Ctrl+F / Cmd+F |
| 右侧栏 / 大纲 | 顶栏右侧切换按钮展开侧栏，展开后点「大纲」 |
| 大纲交互 | 点条目跳转；拖滑块选展开档位；点箭头折叠；工具条搜索与跳末；右键条目弹菜单（复制/调级/重命名/删除）；拖动条目整段重排 |
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
