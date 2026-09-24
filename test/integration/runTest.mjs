// 集成测试启动器：生成临时 fixture 工作区，下载并启动 VSCode 1.86.2，
// 以 extensionDevelopmentPath 模式加载扩展后运行 out/test/integration/suite。
// fixture 字节由脚本直接生成（不经 git 检出），避免 autocrlf 干扰断言。
import { runTests } from '@vscode/test-electron'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generatePerfSample, generateReadingSample } from '../perf/gen-sample.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const LF_DOC = '中文编辑测试\n\n包含 emoji：🎉 与组合 emoji 👨‍👩‍👧‍👦\n\n- 列表项一\n- 列表项二\n'
const CRLF_DOC = '标题一\r\n正文 A 行\r\n正文 B 行\r\n'
const SPLIT_DOC = 'split 起始行\n'
const UNDO_DOC = '撤销链路第一行\n撤销链路第二行\n'
const UNDO2_DOC = '全局命令撤销甲行\n全局命令撤销乙行\n'
const UNDO3_DOC = '撤销守卫甲行\n撤销守卫乙行\n'
const ACKORDER_DOC = '顺序观测起始行\n顺序观测第二行\n'
const RESYNC_DOC = '重同步起始内容\n重同步第二段\n'
const CONFLICT_DOC = '第一段原文甲\n第二段原文乙\n'
const SPLIT_CONFLICT_DOC = '分裂测试行一\n分裂测试行二\n'
const HEADING_DOC = '# 顶部一级标题\n普通段落第一行内容\n普通段落第二行内容\n## 中部二级标题\n另一段普通内容结尾\n'
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
const LARGE_LINES = 100_000

const wsDir = mkdtempSync(path.join(tmpdir(), 'oile-itest-'))
try {
  writeFileSync(path.join(wsDir, 'lf.md'), LF_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'untouched.md'), '未触碰文档\n保持原样\n', 'utf8')
  writeFileSync(path.join(wsDir, 'crlf.md'), CRLF_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'split.md'), SPLIT_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'undo.md'), UNDO_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'undo2.md'), UNDO2_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'undo3.md'), UNDO3_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'ackorder.md'), ACKORDER_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'resync.md'), RESYNC_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'conflict.md'), CONFLICT_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'splitconflict.md'), SPLIT_CONFLICT_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'heading.md'), HEADING_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'mode.md'), MODE_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'mode-anchor.md'), MODE_ANCHOR_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'syntax.md'), SYNTAX_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'fence-chunk.md'), FENCE_CHUNK_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'task.md'), TASK_DOC, 'utf8')
  const largeLines = Array.from({ length: LARGE_LINES }, (_, i) => `第 ${i + 1} 行 ——固定宽度填充文本，用于长文档视口渲染验证——`)
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
  writeFileSync(path.join(wsDir, '链接目标.md'), '# 链接目标\n中文目标文档内容。\n', 'utf8')
  writeFileSync(path.join(wsDir, '无扩展名目标.md'), '# 无扩展名目标\n省略扩展名解析目标。\n', 'utf8')
  mkdirSync(path.join(wsDir, '子 目录'), { recursive: true })
  writeFileSync(path.join(wsDir, '子 目录', '目标 二.md'), '# 目标 二\n含空格路径的目标文档。\n', 'utf8')
  writeFileSync(path.join(wsDir, 'images.md'), IMAGES_DOC, 'utf8')
  mkdirSync(path.join(wsDir, 'assets'), { recursive: true })
  writeFileSync(path.join(wsDir, 'assets', '图片 一.png'), Buffer.from(TINY_PNG_BASE64, 'base64'))

  console.log(`[runTest] fixture 工作区：${wsDir}`)
  await runTests({
    version: '1.86.2',
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'out', 'test', 'integration', 'suite', 'index.js'),
    launchArgs: [wsDir, '--disable-extensions'],
    extensionTestsEnv: {
      WORKSPACE_DIR: wsDir,
      LARGE_DOC_LINES: String(LARGE_LINES),
      // C-11：开启 _test.* 测试钩子命令（生产/常规开发不注册）
      OILE_TEST_HOOKS: '1',
    },
  })
} catch (err) {
  console.error('[runTest] 运行失败', err)
  process.exitCode = 1
} finally {
  rmSync(wsDir, { recursive: true, force: true })
}
