// 集成测试 fixture 单一事实源（工单 #15 抽取）：生成临时工作区全部样例文档。
// runTest.mjs（开发模式加载）与 runInstalled.mjs（VSIX 安装态回归）共用，
// 两条路径跑同一套 fixture，保证安装态与开发态断言的是同一组文档。
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const LF_DOC = '中文编辑测试\n\n包含 emoji：🎉 与组合 emoji 👨‍👩‍👧‍👦\n\n- 列表项一\n- 列表项二\n'
const CRLF_DOC = '标题一\r\n正文 A 行\r\n正文 B 行\r\n'
const SPLIT_DOC = 'split 起始行\n'
const UNDO_DOC = '撤销链路第一行\n撤销链路第二行\n'
const UNDO2_DOC = '全局命令撤销甲行\n全局命令撤销乙行\n'
const UNDO3_DOC = '撤销守卫甲行\n撤销守卫乙行\n'
const ACKORDER_DOC = '顺序观测起始行\n顺序观测第二行\n'
const RESYNC_DOC = '重同步起始内容\n重同步第二段\n'
const IME_ESC_DOC = 'A文B\n'
const CONFLICT_DOC = '第一段原文甲\n第二段原文乙\n'
const SPLIT_CONFLICT_DOC = '分裂测试行一\n分裂测试行二\n'
const HEADING_DOC = '# 顶部一级标题\n普通段落第一行内容\n普通段落第二行内容\n## 中部二级标题\n另一段普通内容结尾\n'
// #32 排版对照：标题/正文/列表/引用/表格齐全（两模式基础排版一致性断言载体）
const TYPOGRAPHY_DOC = [
  '# 排版对照标题',
  '',
  '普通段落正文，两模式基础排版对照载体。',
  '',
  '## 二级标题',
  '',
  '- 列表项甲',
  '- 列表项乙',
  '',
  '> 引用块内容，用于引用排版对照。',
  '',
  '| 列一 | 列二 |',
  '| --- | --- |',
  '| 甲格 | 乙格 |',
  '',
  '结尾段落。',
  '',
].join('\n')
// #6 模式切换：标题/段落/任务列表/代码围栏（围栏内含伪语法）
const MODE_DOC = [
  '# 模式切换标题一',
  '',
  '第一段普通文本，包含中文与 emoji 🎉。',
  '',
  '## 中部二级标题',
  '',
  '- 普通列表项',
  '- [ ] 未完成任务',
  '- [x] 已完成任务',
  '',
  '```code',
  '代码块内容（含 # 伪标题 与 - [ ] 伪任务）',
  '```',
  '',
  '结尾段落。',
  '',
].join('\n')
// #6 锚点恢复：无特殊语法的多段落（块边界清晰）
const MODE_ANCHOR_DOC = '模式锚点第一段文字\n\n中间段落文本\n\n最后段落结束\n'
// #8 双模式显示一致性样例：覆盖标题/粗斜体/列表/任务/引用/行内代码/围栏/
// frontmatter/水平线 + 代码内伪语法 + 未支持语法（脚注、原始 HTML）
const SYNTAX_DOC = [
  '---',
  'title: 语法样例',
  '# frontmatter 内伪标题',
  '---',
  '',
  '# 一级标题',
  '',
  '正文有 **加粗**、*斜体* 与 `行内代码`，还有转义 \\*不斜体\\*。',
  '',
  '## 二级标题',
  '',
  '- 普通列表项',
  '- [ ] 未完成任务',
  '- [x] 已完成任务',
  '',
  '> 引用第一行',
  '> 引用内 **粗体**',
  '',
  '1. 有序项一',
  '2. 有序项二',
  '',
  '```js',
  'const x = 1 // # 伪标题 与 [[伪双链]] 与 - [ ] 伪任务',
  '```',
  '',
  '主题行',
  '===',
  '',
  '---',
  '',
  '未支持语法样例：脚注 [^1] 文本。',
  '',
  '<script>alert(1)</script> 与 <b>原始 HTML</b>',
  '',
  '结尾段落。',
  '',
].join('\n')
// #12 表格单元格编辑：转义管道、代码内管道、GFM 对齐全样例
const TABLE_DOC = [
  '# 表格样例',
  '',
  '| 名字 | 数量 | 备注 |',
  '| --- | :---: | ---: |',
  '| 苹果 | 3 | 甲 |',
  '| `x|y` | 4 | 乙\\|丙 |',
  '',
  '结尾段落。',
  '',
].join('\n')
const TABLE42_EMPTY_DOC = '| A | B |\n| --- | --- |\n| | 空 |\n'
// #13 表格导航/结构操作样例：表格前后有段落（区域不变断言），含对齐、
// 行内代码管道与转义管道
const TABLE13_DOC = [
  '前导段落甲。',
  '',
  '| 名字 | 数量 |',
  '| --- | :---: |',
  '| 苹果 | 3 |',
  '| `x|y` | 4 |',
  '',
  '结尾段落乙。',
  '',
].join('\n')
const TABLE43_CRLF_DOC = TABLE13_DOC.replace(/\n/g, '\r\n')
const TABLE_CREATE_CRLF_DOC = '左文右文\r\n尾段\r\n'
// #8 大围栏细分样例：120 行围栏（超过 FENCE_CHUNK_LINES=60，切为 3 片）
const FENCE_CHUNK_DOC = (() => {
  const out = ['# 大围栏样例', '', '```text']
  for (let i = 1; i <= 120; i++) {
    out.push(`围栏内第 ${i} 行：大围栏细分挂载样本文本。`)
  }
  out.push('```', '', '结尾段。', '')
  return out.join('\n')
})()
// #9 任务勾选样例：含重复任务行（定位安全验证）与已勾选项
const TASK_DOC = [
  '# 任务清单标题',
  '',
  '- [ ] 未完成任务甲',
  '- [ ] 未完成任务甲',
  '- [x] 已完成任务',
  '',
  '结尾段落。',
  '',
].join('\n')
// #10 链接样例：中文/空格目录（%20 编码形态——CommonMark 无尖括号目标
// 不允许裸空格）、无扩展名目标、危险 scheme、自动链接与本地图片
const LINKS_DOC = [
  '# 链接样例',
  '',
  '[外部链接](https://example.com/obsidian-like) 与 [本地目标](./链接目标.md)。',
  '',
  '[空格目录目标](./子%20目录/目标%20二.md) 与自动链接 <https://autolink.example.com/x>。',
  '',
  '[无扩展名目标](./无扩展名目标)（省略扩展名按 Markdown 处理）。',
  '',
  '危险：[file](file:///d:/x.md) 与 [js](javascript:alert(1))。',
  '',
  '![好图](assets/图片%20一.png)',
  '',
].join('\n')
// #10 图片样例：工作区图片（中文+空格文件名，%20 形态）与缺失图
const IMAGES_DOC = [
  '# 图片样例',
  '',
  '正常图片（中文与空格文件名）：',
  '',
  '![好图](assets/图片%20一.png)',
  '',
  '缺失图片（可重试错误态）：',
  '',
  '![缺失图](assets/不存在.png)',
  '',
  '结尾段。',
  '',
].join('\n')
// 1x1 透明 PNG（合法可解码位图，供真实 webview 装载断言）
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
export const LARGE_DOC_LINES = 100_000

// #14 查找样例：'目标词' 出现 4 次（段落 2 次、列表项 1 次、emoji 行 1 次）
const FIND_DOC = [
  '# 查找集成标题',
  '',
  '第一段：这里有一个目标词，后续还有。',
  '',
  '中间段落没有命中内容。',
  '',
  '第二段：又出现目标词了。',
  '',
  '- 列表项包含目标词',
  '',
  '包含 emoji：🎉 与目标词相邻。',
  '',
  '结尾段落。',
  '',
].join('\n')

// #34 行号样例：标题/软换行长段/列表/表格/代码块/空行混合——源行编号
// 与视觉行解耦的断言载体（长段折行时 renderedLines 超过源行数）
const LINENUMBERS_DOC = [
  '# 行号样例',
  '',
  '这是一个故意写得很长的段落，用于验证软换行只是视觉折行、不新增源文件行号：当段落宽度超过编辑器视口宽度时文本发生折行，行号栏仍按源文件的物理行逐一编号，与渲染后的视觉行数解耦，阅读模式与实时预览共用同一份源文本行语义。',
  '',
  '- 列表项甲',
  '- 列表项乙',
  '',
  '| 列一 | 列二 |',
  '| --- | --- |',
  '| 甲格 | 乙格 |',
  '',
  '```text',
  '代码块第一行',
  '代码块第二行',
  '```',
  '',
  '结尾段落。',
  '',
].join('\n')

// #54 大纲样例：跨级标题、同名标题（不丢失不合并）、ATX 全级别、Setext
// 两级别、frontmatter 与代码围栏内伪标题（排除断言载体）
const OUTLINE_DOC = [
  '---',
  'title: 大纲样例',
  '# frontmatter 内伪标题',
  '---',
  '',
  '# 文档主标题',
  '',
  '## 同名标题',
  '',
  '普通段落。',
  '',
  '### 三级标题',
  '',
  '## 同名标题',
  '',
  '# 跨级回一级',
  '',
  'Setext 一级',
  '===========',
  '',
  'Setext 二级',
  '-----------',
  '',
  '#### 四级标题',
  '',
  '##### 五级标题',
  '',
  '###### 六级标题',
  '',
  '```text',
  '# 围栏内伪标题',
  'Setext 伪标题',
  '=============',
  '```',
  '',
  '结尾段落。',
  '',
].join('\n')

// #54 长大纲样例（评审修复）：101 个标题（约 22px/条 ≈ 2230px）远超任何
// 合理窗口下的侧栏可视高度，是面板高度约束与纵向滚动的断言载体——修复
// 前面板长到内容高度被宿主裁剪末条不可达；高度约束生效后条目还须不收缩
// （否则内容被压扁仍不溢出）
const OUTLINE_LONG_DOC = (() => {
  const out = ['# 长文档主标题', '']
  for (let i = 1; i <= 50; i++) {
    out.push(`## 第 ${i} 章`, '', `第 ${i} 章的正文段落。`, '', `### 第 ${i} 章小节`, '', `小节 ${i} 的正文。`, '')
  }
  out.push('结尾段落。', '')
  return out.join('\n')
})()

// #65 大纲样式透传样例：白名单四标记（粗体/斜体/行内代码/删除线）、
// 嵌套粗斜体、双链别名与链接文字的纯文本降级——plainText/spans 断言载体
const OUTLINE_STYLE_DOC = [
  '# **重点** 结论',
  '## *斜体* 与 `代码`',
  '### ~~删除线~~ 与 [[目标笔记|显示别名]]',
  '#### [链接文字](https://example.com) 尾注',
  '##### ***粗斜*** 与普通',
  '',
].join('\n')
// #69 右键菜单样例：多级嵌套 + 跨级（H4 挂 H2 下）+ 行内标记标题（重命名
// 的资产保留断言）+ Setext（调级/重命名规范化 ATX 的载体）+ 文末段。
// 条目序列：0 主(H1) 1 加粗 Alpha(H2) 2 Alpha 子(H3) 3 Beta(H2) 4 Beta 深(H4)
//           5 Setext 标题(H1) 6 第二顶(H1)
const OUTLINE_MENU_DOC = [
  '# 主标题',
  '',
  '## **加粗** Alpha',
  '',
  'Alpha 内容。',
  '',
  '### Alpha 子',
  '',
  '子内容。',
  '',
  '## Beta',
  '',
  'Beta 内容。',
  '',
  '#### Beta 深',
  '',
  '深内容。',
  '',
  'Setext 标题',
  '============',
  '',
  'Setext 内容。',
  '',
  '# 第二顶',
  '',
  '内容。',
  '',
].join('\n')

// #11 双链样例：合法四形态（按名/显式路径/别名/标题）+ 降级形态
// （嵌入/块引用/残缺）+ 代码上下文（围栏与行内代码内不解析）
const WIKILINKS_DOC = [
  '# 双链样例',
  '',
  '正文含 [[目标笔记]] 与 [[子 目录/目标 二|别名]] 与 [[目标笔记#深处的标题]]。',
  '',
  '降级形态：![[嵌入目标]] 与 [[目标笔记^块]] 与 [[坏#]]。',
  '',
  '`行内代码 [[不装饰]]` 之后的正文。',
  '',
  '```text',
  '[[围栏内不装饰]]',
  '```',
  '',
  '结尾段落。',
  '',
].join('\n')
// #11 按名跳转目标：长文使「深处的标题」位于首屏外（阅读挂载定位的屏外目标）
const TARGET_NOTE_DOC = (() => {
  const out = ['# 目标笔记标题', '', '开篇段落。', '']
  for (let i = 1; i <= 200; i++) {
    out.push(`填充段落 ${i}：足够多的正文让「深处的标题」位于首屏之外。`, '')
  }
  out.push('# 深处的标题', '', '标题下的正文。', '')
  return out.join('\n')
})()
// #11 文本编辑器 reveal 目标：中部小节标题
const WIKILINK_TARGET_DOC = (() => {
  const out = ['# 双链跳转目标', '', '顶部段落。', '']
  for (let i = 2; i <= 30; i++) {
    out.push(`第 ${i} 段正文。`, '')
  }
  out.push('## 深处小节', '', '小节内容。', '')
  return out.join('\n')
})()
// CRLF 目标（view.locate 坐标系断言载体）：宿主系 offset 与 LF offset 在
// CRLF 文档上按行数差漂移，面板定位链路发送前必须转换（行内容与 LF 文档
// 同构，仅行尾为 \r\n）
const WIKILINK_CRLF_TARGET_DOC = (() => {
  const out = ['# CRLF 目标标题', '', '开篇段落。', '']
  for (let i = 2; i <= 30; i++) {
    out.push(`第 ${i} 段正文。`, '')
  }
  out.push('## CRLF 深处小节', '', '小节内容。', '')
  return out.join('\r\n')
})()

/**
 * 向目录写入全部集成测试 fixture（字节由脚本直接生成，不经 git 检出，
 * 避免 autocrlf 干扰断言）。返回 { largeDocLines } 供启动器注入环境变量。
 */
export function writeFixtures(wsDir, { generatePerfSample, generateReadingSample }) {
  writeFileSync(path.join(wsDir, 'lf.md'), LF_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'find.md'), FIND_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'untouched.md'), '未触碰文档\n保持原样\n', 'utf8')
  writeFileSync(path.join(wsDir, 'crlf.md'), CRLF_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'split.md'), SPLIT_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'undo.md'), UNDO_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'undo2.md'), UNDO2_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'undo3.md'), UNDO3_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'ackorder.md'), ACKORDER_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'resync.md'), RESYNC_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'ime-escape.md'), IME_ESC_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'conflict.md'), CONFLICT_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'splitconflict.md'), SPLIT_CONFLICT_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'heading.md'), HEADING_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'typography.md'), TYPOGRAPHY_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'mode.md'), MODE_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'mode-anchor.md'), MODE_ANCHOR_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'syntax.md'), SYNTAX_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'fence-chunk.md'), FENCE_CHUNK_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'task.md'), TASK_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'table.md'), TABLE_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'table42.md'), TABLE_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'table-cell-delete.md'), TABLE_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'table42-empty.md'), TABLE42_EMPTY_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'table13.md'), TABLE13_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'table43-crlf.md'), TABLE43_CRLF_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'table-create-crlf.md'), TABLE_CREATE_CRLF_DOC, 'utf8')
  const largeLines = Array.from({ length: LARGE_DOC_LINES }, (_, i) => `第 ${i + 1} 行 ——固定宽度填充文本，用于长文档视口渲染验证——`)
  writeFileSync(path.join(wsDir, 'large.md'), largeLines.join('\n') + '\n', 'utf8')
  // 性能体量对比样例（#5）：同构普通段落 + 每 50 行一个二级标题
  const perfSizes = [['1k', 1_000], ['100k', 100_000]]
  for (const [name, lines] of perfSizes) {
    writeFileSync(path.join(wsDir, `perf-${name}.md`), generatePerfSample(lines), 'utf8')
  }
  // #7 阅读视图按需挂载：每行一块的样例（空行分隔），1k 与 100k 只差体量
  for (const [name, blocks] of [['reading-1k', 1_000], ['reading-100k', 100_000]]) {
    writeFileSync(path.join(wsDir, `${name}.md`), generateReadingSample(blocks), 'utf8')
  }
  // #7 图片尺寸变化定位样例：400 块中等体量，目标块上方有充足的已挂载缓冲块
  writeFileSync(path.join(wsDir, 'reading-image.md'), generateReadingSample(400), 'utf8')
  // #10 链接/图片样例：中文目标、空格目录（磁盘真实空格 + 文档内 %20 形态）、
  // 无扩展名目标与本地图片资源
  writeFileSync(path.join(wsDir, 'links.md'), LINKS_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'links2.md'), LINKS_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'linenumbers.md'), LINENUMBERS_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'outline.md'), OUTLINE_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'outline-long.md'), OUTLINE_LONG_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'outline-style.md'), OUTLINE_STYLE_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'outline-menu.md'), OUTLINE_MENU_DOC, 'utf8')
  writeFileSync(path.join(wsDir, '链接目标.md'), '# 链接目标\n中文目标文档内容。\n', 'utf8')
  writeFileSync(path.join(wsDir, '无扩展名目标.md'), '# 无扩展名目标\n省略扩展名解析目标。\n', 'utf8')
  mkdirSync(path.join(wsDir, '子 目录'), { recursive: true })
  writeFileSync(path.join(wsDir, '子 目录', '目标 二.md'), '# 目标 二\n含空格路径的目标文档。\n', 'utf8')
  writeFileSync(path.join(wsDir, 'images.md'), IMAGES_DOC, 'utf8')
  mkdirSync(path.join(wsDir, 'assets'), { recursive: true })
  writeFileSync(path.join(wsDir, 'assets', '图片 一.png'), Buffer.from(TINY_PNG_BASE64, 'base64'))
  // #11 双链：源文档、按名/屏外标题目标、文本编辑器 reveal 目标、重名候选
  // 与大小写目标（Windows 宿主大小写不敏感匹配的断言载体）
  writeFileSync(path.join(wsDir, 'wikilinks.md'), WIKILINKS_DOC, 'utf8')
  writeFileSync(path.join(wsDir, '目标笔记.md'), TARGET_NOTE_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'wikilink-target.md'), WIKILINK_TARGET_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'wikilink-crlf-target.md'), WIKILINK_CRLF_TARGET_DOC, 'utf8')
  mkdirSync(path.join(wsDir, 'dup'), { recursive: true })
  writeFileSync(path.join(wsDir, 'dup', '甲.md'), '# 重名甲（dup 目录）\n', 'utf8')
  mkdirSync(path.join(wsDir, 'other'), { recursive: true })
  writeFileSync(path.join(wsDir, 'other', '甲.md'), '# 重名甲（other 目录）\n', 'utf8')
  writeFileSync(path.join(wsDir, 'CaseNote.md'), '# 大小写目标\n英文命名的目标笔记。\n', 'utf8')
  return { largeDocLines: LARGE_DOC_LINES }
}
