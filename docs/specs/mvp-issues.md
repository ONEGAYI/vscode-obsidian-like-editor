# MVP GitHub Issue 索引

已根据用户批准的 MVP 与后续性能要求开票，2026-09-23。#2–#15 已完成原定实施与当时的代理自动化回归；#1 的整体验收仍受后续缺口与人工验证约束，不能把代理自检写作用户验收。

- [MVP 规格与总览 #1](https://github.com/ONEGAYI/vsidian/issues/1)
- [本地规格](mvp.md)

## 实施票与阻塞关系

| Issue | 内容 | Blocked by |
| --- | --- | --- |
| #2 | feat: 跑通 VSCode 1.86 中 Markdown 打开、编辑与保存 | 无，可开始 |
| #3 | feat: 打通中文输入、宿主撤销与重做 | #2 |
| #4 | feat: 安全同步外部修改并保留冲突输入 | #3 |
| #5 | perf: 验证全文编辑视口渲染及装饰的增量更新 | #4 |
| #6 | feat: 切换实时预览与阅读视图并建立稳定样式入口 | #5 |
| #7 | perf: 阅读视图按需挂载内容并保持源位置锚点 | #6 |
| #8 | feat: 完成基础 Markdown 双模式显示与源码降级 | #7 |
| #9 | feat: 在实时预览与阅读模式切换任务状态 | #8 |
| #10 | feat: 打开普通链接并显示本地与 SSH 工作区图片 | #8 |
| #11 | feat: 解析 Obsidian 双链并跳转笔记与标题 | #10 |
| #12 | feat: 直接编辑表格单元格并保持 Markdown 回读 | #8 |
| #13 | feat: 表格键盘导航及增删行列 | #12 |
| #14 | feat: 编辑区查找与屏外匹配定位 | #8 |
| #15 | chore: 打包 MVP 并验收 1.86、Remote SSH 与长文档性能 | #9, #11, #13, #14 |

## #1 规格票复核的后续工单

以下工单由 2026-09-24 的规格复核产生。编号链接指向实时状态；本工作树的代码与性能自检不等于这些 Issue 已关闭或用户已验收。

| Issue | 待验事项 | Blocked by |
| --- | --- | --- |
| [#21](https://github.com/ONEGAYI/vsidian/issues/21) | 冲突后快速关闭时保留最后一笔输入 | 无 |
| [#22](https://github.com/ONEGAYI/vsidian/issues/22) | 阅读表格的行内代码管道符不切列 | 无 |
| [#23](https://github.com/ONEGAYI/vsidian/issues/23) | 超长行与图片密集性能专项 | 无 |
| [#24](https://github.com/ONEGAYI/vsidian/issues/24) | 10 KB／100 KB／1 MB 档与完整装载计时 | 无 |
| [#25](https://github.com/ONEGAYI/vsidian/issues/25) | 规格、测试计数与验收状态说明一致 | 无 |
| [#26](https://github.com/ONEGAYI/vsidian/issues/26) | 本机人工交互验收 | #21、#22 |
| [#27](https://github.com/ONEGAYI/vsidian/issues/27) | 日常安装、新版 Windows 与远端环境验证 | #21、#22 |
| [#28](https://github.com/ONEGAYI/vsidian/issues/28) | live 渲染链接单击跳转缺陷 | 无 |
| [#29](https://github.com/ONEGAYI/vsidian/issues/29) | 活动位置 Markdown 标记呈现规则待决策 | 无 |
| [#30](https://github.com/ONEGAYI/vsidian/issues/30) | 阅读模式标题字号过大，与实时预览不一致 | 无 |

## 后续路线

- 二期范围：#16
- 二期 CSS 片段与 Obsidian 选择器：#17（一期 #6 预留，后续语法票维护入口）
- 三期插件上插件调研：#18

原实施票的父子与阻塞关系已使用 GitHub 原生关系建立；后续票的正文写明 Blocked by。沿用仓库现有标签，不新建 triage 标签；可实施状态以阻塞关系为准。


上表中的编号对应 `ONEGAYI/vsidian`；实时状态以 GitHub 为准。
