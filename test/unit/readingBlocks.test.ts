// 阅读块切分契约（工单 #6）：
// 阅读视图的基础版源锚点结构——把 LF 全文切成携带 [start, end) 源区间的
// 块序列。#7 按需挂载以块为最小单位；#9 任务勾选依赖 task.marker 区间；
// #8 引入 markdown-it 后块结构会被更完整的语义取代，但源区间坐标约定不变。
import { describe, it, expect } from 'vitest'
import {
  splitReadingBlocks,
  blockForOffset,
  type ReadingBlock,
} from '../../src/webview/readingBlocks'

describe('splitReadingBlocks：标题块', () => {
  it('ATX 标题行单独成块，start/end 不含尾换行', () => {
    const text = '# 一级标题\n正文\n'
    const blocks = splitReadingBlocks(text)
    expect(blocks).toHaveLength(2)
    const heading = blocks[0]!
    expect(heading.kind).toBe('heading')
    expect(heading.level).toBe(1)
    expect(heading.start).toBe(0)
    expect(heading.end).toBe('# 一级标题'.length)
  })

  it('各级标题级别识别 1-6', () => {
    const text = '# a\n## b\n### c\n#### d\n##### e\n###### f\n'
    const blocks = splitReadingBlocks(text)
    expect(blocks.map((b) => b.level)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('非行首 # 或 7 个 # 不是标题（并入段落）', () => {
    const blocks = splitReadingBlocks('中间 # 号\n####### 七个\n')
    expect(blocks.every((b) => b.kind === 'paragraph')).toBe(true)
  })
})

describe('splitReadingBlocks：段落块', () => {
  it('连续非空行合并为一个段落，空行分隔', () => {
    const text = '第一段甲\n第一段乙\n\n第二段\n'
    const blocks = splitReadingBlocks(text)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.start).toBe(0)
    expect(text.slice(blocks[0]!.start, blocks[0]!.end)).toBe('第一段甲\n第一段乙')
    expect(text.slice(blocks[1]!.start, blocks[1]!.end)).toBe('第二段')
  })

  it('标题/列表行打断段落（不与相邻普通行合并）', () => {
    const text = '段落行\n## 标题\n段落下一行\n'
    const blocks = splitReadingBlocks(text)
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'heading', 'paragraph'])
  })

  it('空文本与纯空白文本不产生块', () => {
    expect(splitReadingBlocks('')).toEqual([])
    expect(splitReadingBlocks('\n\n\n')).toEqual([])
  })

  it('UTF-16 坐标：中文与 emoji 偏移按 code unit 计', () => {
    const text = '中文🎉段\n\n下一块\n'
    const blocks = splitReadingBlocks(text)
    expect(text.slice(blocks[0]!.start, blocks[0]!.end)).toBe('中文🎉段')
    expect(blocks[1]!.start).toBe('中文🎉段\n\n'.length)
  })
})

describe('splitReadingBlocks：列表与任务', () => {
  it('列表标记行（-/*/+/缩进）各自成块', () => {
    const text = '- 甲\n* 乙\n+ 丙\n  - 丁\n'
    const blocks = splitReadingBlocks(text)
    expect(blocks).toHaveLength(4)
    expect(blocks.every((b) => b.kind === 'list-item')).toBe(true)
  })

  it('任务项带 marker 区间与勾选状态（空格/x/X）', () => {
    const text = '- [ ] 未完成\n- [x] 小写完成\n- [X] 大写完成\n'
    const blocks = splitReadingBlocks(text)
    expect(blocks.map((b) => b.task?.checked)).toEqual([false, true, true])
    // marker 区间恰为 [x] 三个字符
    expect(text.slice(blocks[1]!.task!.markerStart, blocks[1]!.task!.markerEnd)).toBe('[x]')
    // marker 位于列表标记之后
    expect(blocks[1]!.task!.markerStart).toBe(blocks[1]!.start + 2)
  })

  it('普通列表项无 task 字段；checkbox 方括号缺空格不是任务', () => {
    const text = '- 普通项\n- []不是任务\n'
    const blocks = splitReadingBlocks(text)
    expect(blocks[0]!.task).toBeUndefined()
    expect(blocks[1]!.task).toBeUndefined()
  })
})

describe('splitReadingBlocks：代码围栏', () => {
  it('围栏行间内容整体一个 code-block，内部伪标题/伪任务不解析', () => {
    const text = '```\n# 伪标题\n- [ ] 伪任务\n```\n## 真标题\n'
    const blocks = splitReadingBlocks(text)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.kind).toBe('code-block')
    expect(text.slice(blocks[0]!.start, blocks[0]!.end)).toBe('```\n# 伪标题\n- [ ] 伪任务\n```')
    expect(blocks[1]!.kind).toBe('heading')
  })

  it('未闭合围栏持续到文档末尾', () => {
    const blocks = splitReadingBlocks('```js\n未闭合内容')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.kind).toBe('code-block')
    expect(blocks[0]!.end).toBe('```js\n未闭合内容'.length)
  })

  it('~ 围栏同样识别；围栏后的段落继续切分', () => {
    const text = '~~~\ncode\n~~~\n\n围栏后段落\n'
    const blocks = splitReadingBlocks(text)
    expect(blocks.map((b) => b.kind)).toEqual(['code-block', 'paragraph'])
  })
})

describe('blockForOffset：源 offset ↔ 块身份映射', () => {
  const text = '# 标题\n\n第一段\n\n- [ ] 任务\n\n结尾\n'
  const blocks = splitReadingBlocks(text)
  // 块序列：heading[0,4) 段落[6,9) 任务[11,19) 段落[21,23)

  it('offset 落在块内返回该块', () => {
    const b = blockForOffset(blocks, 7)! // '第一段' [6,9) 内
    expect(text.slice(b!.start, b!.end)).toBe('第一段')
    const taskIn = blockForOffset(blocks, 12)! // '- [ ] 任务' [11,19) 内
    expect(taskIn.kind).toBe('list-item')
  })

  it('offset 落在块间缝隙（换行/空行）取其前最近内容块', () => {
    const b = blockForOffset(blocks, 4)! // 标题块后的换行
    expect(b.kind).toBe('heading')
    const b2 = blockForOffset(blocks, 9)! // 段落后的换行
    expect(text.slice(b2!.start, b2!.end)).toBe('第一段')
  })

  it('offset 超出文档末尾取最后块；块列表为空返回 null', () => {
    const last = blockForOffset(blocks, 9999)!
    expect(text.slice(last!.start, last!.end)).toBe('结尾')
    expect(blockForOffset([], 0)).toBeNull()
  })

  it('映射经切换使用的核心性质：任意 offset 落在映射块区间或其后的缝隙内', () => {
    for (let offset = 0; offset <= text.length; offset++) {
      const b = blockForOffset(blocks, offset)
      expect(b).not.toBeNull()
      const index = blocks.indexOf(b!)
      const next = blocks[index + 1]
      expect(b!.start <= offset).toBe(true)
      // offset 不得超过下一块 start（缝隙结束处）
      if (next) {
        expect(offset <= next.start).toBe(true)
      }
    }
  })
})

describe('块身份稳定性（#7/#8 依赖的结构契约）', () => {
  it('块序列单调有序且互不重叠', () => {
    const text = '# t\n\np1\n\n```\nc\n```\n\n- [ ] task\n\ntail\n'
    const blocks: ReadingBlock[] = splitReadingBlocks(text)
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i]!.start).toBeGreaterThan(blocks[i - 1]!.end)
    }
  })
})
