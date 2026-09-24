# 任务跟踪约定

本项目使用 [GitHub Issues](https://github.com/ONEGAYI/vsidian/issues) 跟踪需求、缺陷、规格与实施任务。

## 操作方式

- 在仓库目录使用 `gh` CLI，默认从 `origin` 识别仓库；跨目录操作显式添加 `--repo ONEGAYI/vsidian`。
- 读取任务：`gh issue view <编号> --comments`。
- 列出待处理任务：`gh issue list --state open`。
- 获得发布授权后创建任务：`gh issue create --title "标题" --body-file <正文文件>`。多行正文先写入 UTF-8 文件，保留真实换行。
- 技能要求“发布到任务跟踪系统”时，目标为 GitHub Issue；要求“读取相关任务”时，读取 Issue 正文、标签和评论。
- Issue 与 PR 的标题、正文默认使用中文。

## 标签与 PR

保留 GitHub 默认标签。仓库尚未内置 triage 技能，暂不建立专用分诊标签或映射文件；后续启用时先读取已有标签，避免覆盖。

PR 用于代码审查，暂不作为需求分诊入口。后续代码变更在获得推送授权后通过 PR 留痕；只有用户明确要求合并时才执行合并。
