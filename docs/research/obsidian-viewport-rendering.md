# Obsidian 视口渲染与 MVP 性能要求

调研日期：2026-09-23。补充研究子代理使用 gpt-6-sol。未运行性能实验；下文明确区分官方事实与本项目工程决定。

## 核实结论

**用户对编辑视图的核心判断成立**。Obsidian 官方说明编辑器仅渲染可见内容及少量周边，滚动或文档变更后重新计算视口。Live Preview 与 Source mode 都属于编辑视图；阅读视图另列，不能据编辑机制推断其 DOM 实现。[官方视口文档](https://github.com/obsidianmd/obsidian-developer-docs/blob/main/en/Plugins/Editor/Viewport.md)、[视图分类](https://obsidian.md/help/edit-and-read)

CM6 将完整 Text 文档与 EditorView 的显示分离。屏外内容无需全部生成 DOM，但文本模型、历史和必要索引仍占内存；不等于按滚动读取文件，也不保证内存恒定。[EditorState](https://codemirror.net/docs/ref/#state.EditorState)、[Text](https://codemirror.net/docs/ref/#state.Text)

`viewport` 包含绘制边距，`visibleRanges` 描述实际绘制范围，两者在折叠和长行时可不同。视口外依赖高度估计，不能假定任意源码位置已有 DOM 可供查找。[EditorView](https://codemirror.net/docs/ref/#view.EditorView)、[官方指南源码](https://github.com/codemirror/website/blob/main/site/docs/guide/index.md)

## 自定义实时预览容易重新引入的成本

- 每次键入扫描全文、重建全部装饰或发送完整文本快照，会把增量编辑重新变成全量工作；初始化和必要重同步可以全量，但不应成为正常按键路径。
- 图片与可编辑表格的 DOM/监听器必须按挂载生命周期回收。一个超大 widget 内部仍可能生成大量节点，整篇文档虚拟化不自动解决单个超大表格。
- 影响纵向布局的块 widget、跨换行替换必须通过直接 decoration 提供，通常存于 StateField；在计算视口之后执行的间接 decorations 不能反过来改变块结构。不能把所有装饰机械地改成仅扫描 visibleRanges。[装饰 API](https://codemirror.net/docs/ref/#view.EditorView%5Edecorations)、[Obsidian 装饰说明](https://docs.obsidian.md/Plugins/Editor/Decorations)
- 图片等改变块高度时需正确触发重新测量，避免跳动或错误定位。[Widget API](https://codemirror.net/docs/ref/#view.Decoration%5Ewidget)

增量解析能够复用语法树片段，但修改围栏等内容可能影响后续大范围语义；语法树也可能尚未完整。因此“只渲染视口”不能改写成“永远只解析视口”。[Lezer 增量解析](https://lezer.codemirror.net/docs/guide/#incremental-parsing)、[语法树可用性](https://codemirror.net/docs/ref/#language.syntaxTreeAvailable)

## 本项目决定

当前仓库只有文档，已选 CM6 全文编辑，不是引用材料中的 vscode-office/Vditor 仓库。无需先改造一个现有 Vditor 内核。

编辑视图的全文模型与视口 DOM 分离纳入 MVP 硬性要求。阅读视图另建分块渲染：保留必要语义解析和源范围，用可见块与缓冲区控制 DOM 挂载及回收。此项是本项目设计，不声称已核实 Obsidian 阅读视图采用相同技术。

不采用“先生成完整 DOM 再 display:none/content-visibility 隐藏”作为按需创建的替代。CSS 片段兼容以公开节点/变量契约为准；跨屏 DOM 兄弟选择器、依赖全部子节点的选择器可能与虚拟化冲突，必须在二期兼容表中公开限制。

## 可复现验收

固定 Windows VSCode 1.86、窗口尺寸与硬件，记录依赖版本。编辑与阅读分别测量：

1. 同构普通段落/短行样例为 1千、1万、10万行，对比同一视口节点数。文本增长 10 倍时，内容 DOM 不得近似线性增长；初始工程门槛设为不超过 2 倍，注明选择区/焦点等有界例外。不是 Obsidian 官方性能数字。
2. 滚动首、中、尾，确认文本、选择、任务及保存内容准确。往返滚动 10 次后节点数能回到同一位置的基线附近，监听器及重型实例不持续累积。
3. 记录输入到绘制、滚动帧间隔、打开/模式切换耗时和内存；在原型阶段锁定基准机上的延迟预算，不以没有依据的毫秒值作为产品宣传。
4. 另测图片密集文档、超长单行、单个超大表格与代码块；分别报告瓶颈，不能以短段落结果宣称所有文档均可流畅处理。
5. 全文查找和标题跳转基于模型定位，不能只搜索已挂载 DOM；滚动回收不能丢失表格正在编辑的未确认输入。

没有性能实测前，只能声称架构采用了按需渲染，不能声称已经解决所有性能问题。
