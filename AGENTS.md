# vscode-obsidian-like-editor

VSCode 扩展：在 VSCode 中提供类 Obsidian 的 Markdown 编辑体验。

> 项目尚处初始化阶段，功能范围待定。本文件是项目级 agent 规则的**单一事实源**；功能落地后应同步更新本节与 README。

## 约定

- 技术栈、目录结构与构建方式在首次实现时确立，并回写到本文件。
- 通用工程规范（提交规范、TDD、文件树维护）遵循工程根 `D:\CODE\Project\AGENTS.md`，此处不重复展开。

## Agent skills

### Issue tracker

使用 GitHub Issues 跟踪需求、缺陷与任务，仓库为 `ONEGAYI/vscode-obsidian-like-editor`。操作约定见 [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md)。

### Domain docs

采用单一领域上下文；术语与架构决策按需记录。读取与维护约定见 [docs/agents/domain.md](docs/agents/domain.md)。

## 文件树（简版速览）

```
<!-- file-tree:tree:begin 由脚本渲染，禁止手改 -->
vscode-obsidian-like-editor/
├── .agents/   # agent 技能与本地配置
│   └── skills/ # 已部署 agent 技能
│       └── file-tree/ # file-tree 技能部署实例
├── .gitignore # Git 忽略规则
├── .scratch/  # MVP 开票草稿，临时目录
├── AGENTS.md  # 项目级 agent 规则单一事实源
├── CLAUDE.md  # Claude 专属规则导入入口
├── CONTEXT.md # 领域语言与产品边界事实源
├── docs/      # 项目文档根
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
└── README.md  # 项目门面说明
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
