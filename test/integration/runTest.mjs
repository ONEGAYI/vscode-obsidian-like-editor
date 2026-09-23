// 集成测试启动器：生成临时 fixture 工作区，下载并启动 VSCode 1.86.2，
// 以 extensionDevelopmentPath 模式加载扩展后运行 out/test/integration/suite。
// fixture 字节由脚本直接生成（不经 git 检出），避免 autocrlf 干扰断言。
import { runTests } from '@vscode/test-electron'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const LF_DOC = '中文编辑测试\n\n包含 emoji：🎉 与组合 emoji 👨‍👩‍👧‍👦\n\n- 列表项一\n- 列表项二\n'
const CRLF_DOC = '标题一\r\n正文 A 行\r\n正文 B 行\r\n'
const SPLIT_DOC = 'split 起始行\n'
const UNDO_DOC = '撤销链路第一行\n撤销链路第二行\n'
const UNDO2_DOC = '全局命令撤销甲行\n全局命令撤销乙行\n'
const RESYNC_DOC = '重同步起始内容\n重同步第二段\n'
const LARGE_LINES = 100_000

const wsDir = mkdtempSync(path.join(tmpdir(), 'oile-itest-'))
try {
  writeFileSync(path.join(wsDir, 'lf.md'), LF_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'untouched.md'), '未触碰文档\n保持原样\n', 'utf8')
  writeFileSync(path.join(wsDir, 'crlf.md'), CRLF_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'split.md'), SPLIT_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'undo.md'), UNDO_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'undo2.md'), UNDO2_DOC, 'utf8')
  writeFileSync(path.join(wsDir, 'resync.md'), RESYNC_DOC, 'utf8')
  const largeLines = Array.from({ length: LARGE_LINES }, (_, i) => `第 ${i + 1} 行 ——固定宽度填充文本，用于长文档视口渲染验证——`)
  writeFileSync(path.join(wsDir, 'large.md'), largeLines.join('\n') + '\n', 'utf8')

  console.log(`[runTest] fixture 工作区：${wsDir}`)
  await runTests({
    version: '1.86.2',
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, 'out', 'test', 'integration', 'suite', 'index.js'),
    launchArgs: [wsDir, '--disable-extensions'],
    extensionTestsEnv: {
      WORKSPACE_DIR: wsDir,
      LARGE_DOC_LINES: String(LARGE_LINES),
    },
  })
} catch (err) {
  console.error('[runTest] 运行失败', err)
  process.exitCode = 1
} finally {
  rmSync(wsDir, { recursive: true, force: true })
}
