# vscode-obsidian-like-editor

在 VSCode 中提供类 Obsidian 的 Markdown 编辑体验的扩展。

> 当前进展：#2–#8 已交付——通过"重新打开方式（Reopen With）"以本编辑器打开 `.md`（不接管默认打开），CodeMirror 6 承载全文并按增量写回 VSCode 文本模型；中文输入、宿主撤销/重做、外部修改安全同步（冲突时保留输入并暂停写回）、基础 Markdown 双模式显示（实时预览 + 阅读视图，含任务列表、引用、代码块等语法与源码降级）均已落地。双链、表格编辑与查找定位、MVP 打包验收按 [MVP 规格](docs/specs/mvp.md) 进行中。
>
> 使用提示：命令面板执行 **切换实时预览与阅读模式**（或编辑器工具栏按钮）切换双视图；检测到无法安全同步的外部修改时，编辑器顶部会出现冲突横幅——本地输入已保留，可"复制未确认输入"或"放弃本地修改并重新同步"。

## 开发

```bash
npm install        # 安装锁定依赖
npm run compile    # esbuild 双产物 + tsc 类型检查
npm run test:unit  # vitest 单元/契约测试
npm run test:integration  # @vscode/test-electron 1.86.2 真宿主集成测试（需联网下载宿主）
```

调试：VSCode 打开本仓库后 F5（Extension Development Host），对 `.md` 文件执行 "Reopen With..." 选择 "Obsidian-like Markdown Editor"。

## 路线

规格与工单索引见 [docs/specs/mvp.md](docs/specs/mvp.md) 与 [docs/specs/mvp-issues.md](docs/specs/mvp-issues.md)。
