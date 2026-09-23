# vscode-obsidian-like-editor

在 VSCode 中提供类 Obsidian 的 Markdown 编辑体验的扩展。

> 当前进展：基础骨架已落地（工单 #2）——通过"重新打开方式（Reopen With）"以本编辑器打开 `.md` 文件，CodeMirror 6 承载全文并按增量写回 VSCode 文本模型；不接管 `.md` 的默认打开方式。Markdown 语法显示、阅读模式、双链与表格等按 [MVP 规格](docs/specs/mvp.md) 在后续版本交付。

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
