// 宿主侧双链目标解析契约（工单 #11，ADR-0002：按需解析不建持久索引）：
// resolveWikilinkFile 是「webview 上报目标 → 工作区内目标文件」的纯逻辑
// 核心（文件清单由 vscode 层按需 findFiles 后注入），必须先钉死：
// - 无工作区（未打开文件夹）：no-workspace——不猜测、不扫描
// - 按名查找（无分隔符）：工作区内任意位置 basename（去 .md）匹配
// - 显式路径（含 /）：文档相对与工作区相对双候选精确解析；两者命中不同
//   文件为 ambiguous（用户选择，不静默任选）；解析到同一文件去重为单目标
// - 大小写语义：Windows 宿主（本地 NTFS 语义）大小写不敏感匹配；POSIX
//   宿主（远程 Linux）严格匹配——两类语义不混用
// - 无扩展名补 .md 候选（与 #10 普通链接同语义）
// - findHeadingOffset：目标文档内标题定位——trim、空白折叠、大小写不敏感、
//   剥离 ATX 收尾 #、跳过围栏代码内伪标题；setext 标题不匹配（一期规则）
import { describe, it, expect } from 'vitest'
import {
  findHeadingOffset,
  normalizeHeadingText,
  resolveWikilinkFile,
  type WikilinkResolveContext,
} from '../../src/host/wikilinkTarget'

const WIN: WikilinkResolveContext = {
  docDir: 'd:\\notes\\子目录',
  rootDir: 'd:\\notes',
  isWindowsHost: true,
  hasWorkspace: true,
}

const POSIX: WikilinkResolveContext = {
  docDir: '/home/u/notes/sub',
  rootDir: '/home/u/notes',
  isWindowsHost: false,
  hasWorkspace: true,
}

/** 生成宿主平台形态的绝对路径（测试夹具辅助） */
function files(ctx: WikilinkResolveContext, ...rel: string[]): string[] {
  const sep = ctx.isWindowsHost ? '\\' : '/'
  return rel.map((r) => `${ctx.rootDir}${sep}${r.split('/').join(sep)}`)
}

describe('按名查找（无分隔符，全工作区 basename 匹配）', () => {
  it('唯一命中：任意目录深度、中文与空格文件名', () => {
    const md = files(WIN, '目标笔记.md', '子目录/其他.md', '深层/嵌套/目标 二.md')
    expect(resolveWikilinkFile({ path: '目标笔记' }, WIN, md)).toEqual({
      kind: 'target',
      fsPath: 'd:\\notes\\目标笔记.md',
    })
    expect(resolveWikilinkFile({ path: '目标 二' }, WIN, md)).toEqual({
      kind: 'target',
      fsPath: 'd:\\notes\\深层\\嵌套\\目标 二.md',
    })
  })

  it('重名命中多个：ambiguous（用户选择，不得静默任选）', () => {
    const md = files(WIN, 'dup/甲.md', 'other/甲.md', '别的.md')
    const r = resolveWikilinkFile({ path: '甲' }, WIN, md)
    expect(r.kind).toBe('ambiguous')
    expect(r.kind === 'ambiguous' && r.fsPaths.sort()).toEqual(
      ['d:\\notes\\dup\\甲.md', 'd:\\notes\\other\\甲.md'].sort(),
    )
  })

  it('零命中：not-found（不自动建文件）', () => {
    expect(resolveWikilinkFile({ path: '不存在' }, WIN, files(WIN, '其他.md'))).toEqual({
      kind: 'not-found',
    })
  })

  it('无工作区：no-workspace（不猜测目标）', () => {
    const r = resolveWikilinkFile({ path: '目标' }, { ...WIN, hasWorkspace: false }, [])
    expect(r).toEqual({ kind: 'no-workspace' })
  })
})

describe('显式路径（含 /）：文档相对与工作区相对双候选', () => {
  it('文档相对命中（docDir 下的路径）', () => {
    const md = files(WIN, '子目录/隔壁笔记.md')
    expect(resolveWikilinkFile({ path: './隔壁笔记' }, WIN, md)).toEqual({
      kind: 'target',
      fsPath: 'd:\\notes\\子目录\\隔壁笔记.md',
    })
    expect(resolveWikilinkFile({ path: '隔壁笔记.md' }, WIN, md)).toEqual({
      kind: 'target',
      fsPath: 'd:\\notes\\子目录\\隔壁笔记.md',
    })
  })

  it('工作区相对命中（rootDir 下的路径，文档目录不含）', () => {
    const md = files(WIN, '子 目录/目标 二.md')
    expect(resolveWikilinkFile({ path: '子 目录/目标 二' }, WIN, md)).toEqual({
      kind: 'target',
      fsPath: 'd:\\notes\\子 目录\\目标 二.md',
    })
  })

  it('文档相对与工作区相对命中不同文件：ambiguous（不静默选错）', () => {
    const md = files(WIN, '子目录/同名.md', '同名.md')
    const r = resolveWikilinkFile({ path: '同名.md' }, WIN, md)
    expect(r.kind).toBe('ambiguous')
    expect(r.kind === 'ambiguous' && r.fsPaths.length).toBe(2)
  })

  it('两候选解析到同一文件（文档在根目录时）：去重为单目标', () => {
    const md = files(WIN, '根目标.md')
    const rootCtx: WikilinkResolveContext = { ...WIN, docDir: WIN.rootDir }
    expect(resolveWikilinkFile({ path: '根目标.md' }, rootCtx, md)).toEqual({
      kind: 'target',
      fsPath: 'd:\\notes\\根目标.md',
    })
  })

  it('上行 ../ 越出资源根：不命中（路径不得静默越界）', () => {
    const md = files(WIN, '目标.md')
    expect(resolveWikilinkFile({ path: '../../目标.md' }, WIN, md)).toEqual({ kind: 'not-found' })
  })

  it('显式路径精确匹配：全路径命中；路径前缀不完整不做按名/后缀兜底', () => {
    const md = files(WIN, '深层/目录甲/笔记.md')
    expect(resolveWikilinkFile({ path: '深层/目录甲/笔记' }, WIN, md)).toEqual({
      kind: 'target',
      fsPath: 'd:\\notes\\深层\\目录甲\\笔记.md',
    })
    // 目录甲/笔记 只是被截断的路径片段：不得按「尾段匹配」落到 深层/目录甲/笔记.md
    expect(resolveWikilinkFile({ path: '目录甲/笔记' }, WIN, md)).toEqual({ kind: 'not-found' })
    expect(resolveWikilinkFile({ path: '别的/笔记' }, WIN, md)).toEqual({ kind: 'not-found' })
  })

  it('带 .md 扩展名的无分隔符目标按显式路径解析（不做按名匹配）', () => {
    const md = files(WIN, '隔壁笔记.md', '隔壁笔记.md.md')
    expect(resolveWikilinkFile({ path: '隔壁笔记.md' }, WIN, md)).toEqual({
      kind: 'target',
      fsPath: 'd:\\notes\\隔壁笔记.md',
    })
  })
})

describe('大小写语义（宿主平台决定，两类不混用）', () => {
  it('Windows 宿主：大小写不敏感匹配（NTFS 语义）', () => {
    const md = files(WIN, 'CaseNote.md')
    expect(resolveWikilinkFile({ path: 'casenote' }, WIN, md)).toEqual({
      kind: 'target',
      fsPath: 'd:\\notes\\CaseNote.md',
    })
    expect(resolveWikilinkFile({ path: 'CASENOTE.md' }, WIN, md)).toEqual({
      kind: 'target',
      fsPath: 'd:\\notes\\CaseNote.md',
    })
  })

  it('POSIX 宿主（远程）：严格匹配，大小写不同即 not-found', () => {
    const md = files(POSIX, 'CaseNote.md')
    expect(resolveWikilinkFile({ path: 'casenote' }, POSIX, md)).toEqual({ kind: 'not-found' })
    expect(resolveWikilinkFile({ path: 'CaseNote' }, POSIX, md)).toEqual({
      kind: 'target',
      fsPath: '/home/u/notes/CaseNote.md',
    })
  })

  it('POSIX 宿主：反斜杠是普通文件名字符（不是分隔符）；Windows 宿主按分隔符解析', () => {
    const mdPosix = files(POSIX, 'a\\b.md')
    expect(resolveWikilinkFile({ path: 'a\\b' }, POSIX, mdPosix)).toEqual({
      kind: 'target',
      fsPath: '/home/u/notes/a\\b.md',
    })
    const mdWin = files(WIN, 'a\\b.md')
    expect(resolveWikilinkFile({ path: 'a\\b' }, WIN, mdWin)).toEqual({
      kind: 'target',
      fsPath: 'd:\\notes\\a\\b.md',
    })
  })
})

describe('findHeadingOffset：目标文档标题定位（标题规范化写入测试）', () => {
  const DOC = [
    '# 顶部标题',
    '',
    '正文一。',
    '',
    '## 中部  小节', // 内部双空格
    '',
    '```text',
    '# 围栏内伪标题',
    '```',
    '',
    '## 中部小节', // 折叠空白后与上行同名——首个（围栏前）命中
    '',
    '### 带 收尾 #',
    '',
    '####### 七个井号不是标题',
    '',
    '    # 四空格缩进是代码块',
    '',
    '收尾段。',
    '',
  ].join('\n')

  it('trim + 内部空白折叠 + 大小写不敏感；首个命中（围栏内伪标题跳过）', () => {
    const hit = findHeadingOffset(DOC, '中部  小节')
    expect(hit).not.toBeNull()
    expect(DOC.slice(hit!.offset, hit!.end)).toBe('## 中部  小节')
    // 大小写不敏感命中英文
    const doc2 = '# Alpha Section\n\n正文\n'
    const hit2 = findHeadingOffset(doc2, 'alpha SECTION')
    expect(doc2.slice(hit2!.offset, hit2!.end)).toBe('# Alpha Section')
  })

  it('ATX 收尾 # 序列剥离后匹配；七个井号不是标题；缩进代码不是标题', () => {
    const hit = findHeadingOffset(DOC, '带 收尾')
    expect(hit).not.toBeNull()
    expect(DOC.slice(hit!.offset, hit!.end)).toBe('### 带 收尾 #')
    expect(findHeadingOffset(DOC, '七个井号不是标题')).toBeNull()
    expect(findHeadingOffset(DOC, '四空格缩进是代码块')).toBeNull()
  })

  it('围栏内的 # 行不作为标题（``` 与 ~~~ 两种围栏）', () => {
    const doc = '# 真\n\n~~~\n# 假\n~~~\n\n```js\n// 注释\n```\n'
    expect(DOC && findHeadingOffset(doc, '真')).not.toBeNull()
    expect(findHeadingOffset(doc, '假')).toBeNull()
  })

  it('setext 标题不匹配（一期规则：仅 ATX）；无命中返回 null', () => {
    const doc = '小节文本\n===\n\n正文\n'
    expect(findHeadingOffset(doc, '小节文本')).toBeNull()
    expect(findHeadingOffset(doc, '不存在')).toBeNull()
  })

  it('CRLF 行尾容错（宿主 TextDocument 可能保留 CRLF）', () => {
    const doc = '# 标题甲\r\n正文\r\n## 标题乙\r\n'
    const hit = findHeadingOffset(doc, '标题乙')
    expect(hit).not.toBeNull()
    expect(doc.slice(hit!.offset, hit!.end)).toBe('## 标题乙')
  })

  it('end 为标题行行尾（不含换行）——selection reveal 的区间依据', () => {
    const doc = '# 甲\n正文行\n'
    const hit = findHeadingOffset(doc, '甲')!
    expect(hit.end - hit.offset).toBe('# 甲'.length)
  })
})

describe('normalizeHeadingText：标题比较键', () => {
  it('trim + 空白折叠 + 小写', () => {
    expect(normalizeHeadingText('  中部   小节 ')).toBe('中部 小节')
    expect(normalizeHeadingText('ABC')).toBe('abc')
  })
})
