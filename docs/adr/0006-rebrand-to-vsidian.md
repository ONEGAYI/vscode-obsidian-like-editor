# 项目统一更名为 vsidian，公开标识前缀随之变更

## 状态

已接受，2026-09-24。用户决定把 GitHub 仓库改名为 `vsidian`，并要求代码与文档中的旧名称（含 `oile` 缩写）一并统一更新。

## 决定

项目公开标识整体从旧名切换为 `vsidian`，映射如下：

| 旧标识 | 新标识 |
| --- | --- |
| 仓库 `ONEGAYI/vscode-obsidian-like-editor` | `ONEGAYI/vsidian` |
| 扩展包名 `vscode-obsidian-like-editor`、displayName | `vsidian`、`Vsidian` |
| viewType `onegayi.obsidian-like-markdown-editor` | `onegayi.vsidian.editor` |
| 命令前缀 `onegayi.obsidian-like-editor.*` | `onegayi.vsidian.*` |
| 稳定样式类与属性前缀 `oile-*`、`data-oile-src-*` | `vsidian-*`、`data-vsidian-src-*` |
| 测试门控环境变量 `OILE_TEST_HOOKS` | `VSIDIAN_TEST_HOOKS` |
| markdown-it 双链规则名 `oile_wikilink` | `vsidian_wikilink` |

ADR-0004 的稳定样式入口即上述类名族；本 ADR 即该契约要求的变更记录，[选择器映射表](../design/obsidian-selector-map.md)已同步更新。

## 取舍与边界

扩展尚未发布到市场，仅以本地 VSIX 分发，扩展 ID 与样式类名的变更不产生升级兼容负担；更名后如发布，一切以新标识为准。GitHub 对旧仓库地址自动重定向，但文档与 `package.json` 一律写新地址，不依赖重定向存量。本地目录名与仓库名无绑定关系，是否同步改名由用户另行决定。集成测试 fixture 中 `https://example.com/obsidian-like` 为任意外链数据，与项目名无关，不参与更名。
