// Mermaid 围栏形态学契约测试（工单 #60）：shared/mermaid.ts 的 info 识别与
// CommonMark 围栏状态机行扫描。live 装饰与阅读渲染共用同一判定口径。
import { describe, expect, it } from 'vitest'
import {
  isMermaidInfo,
  scanFenceSpans,
  scanFencesDetailed,
  type FenceSpan,
} from '../../src/shared/mermaid'

/** 便捷：行数组 + 首行 offset 0 扫描，返回紧凑断言形态 */
function scan(text: string): Array<{ from: number; to: number; mermaid: boolean; code: string }> {
  return scanFenceSpans(text.split('\n'), 0).map((s) => ({
    from: s.from,
    to: s.to,
    mermaid: s.mermaid,
    code: s.code,
  }))
}

describe('isMermaidInfo：info string 判定', () => {
  it('精确匹配 mermaid（前后空白容忍）', () => {
    expect(isMermaidInfo('mermaid')).toBe(true)
    expect(isMermaidInfo(' mermaid ')).toBe(true)
    expect(isMermaidInfo('mermaid\t')).toBe(true)
  })

  it('大小写敏感；非 mermaid 语言与多余词不命中', () => {
    expect(isMermaidInfo('Mermaid')).toBe(false)
    expect(isMermaidInfo('MERMAID')).toBe(false)
    expect(isMermaidInfo('mermaid flowchart')).toBe(false)
    expect(isMermaidInfo('js')).toBe(false)
    expect(isMermaidInfo('')).toBe(false)
  })
})

describe('scanFenceSpans：围栏状态机', () => {
  it('标准 mermaid 围栏：from/to 覆盖开闭围栏行，code 为内容', () => {
    const text = ['前言', '', '```mermaid', 'graph TD', 'A-->B', '```', '', '结尾'].join('\n')
    const spans = scan(text)
    expect(spans).toHaveLength(1)
    const s = spans[0]!
    expect(s.mermaid).toBe(true)
    expect(s.from).toBe(text.indexOf('```mermaid'))
    expect(s.to).toBe(text.indexOf('```', 3 + '```mermaid'.length) + 3) // 闭围栏行行尾（不含换行，排他端）
    expect(s.code).toBe('graph TD\nA-->B')
  })

  it('波浪线围栏同样识别；info 前后空白容忍', () => {
    const spans = scan('~~~mermaid  \nflowchart LR\nA-->B\n~~~')
    expect(spans).toHaveLength(1)
    expect(spans[0]!.mermaid).toBe(true)
    expect(spans[0]!.code).toBe('flowchart LR\nA-->B')
  })

  it('非 mermaid 围栏产出 span（mermaid=false）供嵌套抑制消费', () => {
    const spans = scan('```js\nlet a = 1\n```')
    expect(spans).toHaveLength(1)
    expect(spans[0]!.mermaid).toBe(false)
  })

  it('普通围栏内的伪 mermaid 围栏不产出（嵌套抑制）', () => {
    // 外层 4 反引号围栏包含 ```mermaid 文本：内层不是围栏
    const text = ['````md', '```mermaid', 'graph TD', 'A-->B', '```', '````'].join('\n')
    const spans = scan(text)
    expect(spans).toHaveLength(1)
    expect(spans[0]!.mermaid).toBe(false)
    expect(spans[0]!.code).toBe('```mermaid\ngraph TD\nA-->B\n```')
  })

  it('缩进 4 空格的行不开启围栏（缩进代码块语义）', () => {
    const text = ['    ```mermaid', '    graph TD', '    A-->B', '    ```'].join('\n')
    expect(scan(text)).toHaveLength(0)
  })

  it('缩进 0-3 空格的围栏正常识别（列表内围栏容忍）', () => {
    const spans = scan('  ```mermaid\n  graph TD\n  ```')
    expect(spans).toHaveLength(1)
    expect(spans[0]!.mermaid).toBe(true)
  })

  it('闭合围栏要求 run ≥ 开启 run 且行内无其他内容', () => {
    // ```` 开启，``` 不闭合
    const shortClose = scan('````mermaid\nA-->B\n```\n````')
    expect(shortClose).toHaveLength(1)
    expect(shortClose[0]!.code).toBe('A-->B\n```')
    // 闭合行带 info → 不是闭合围栏，为内容
    const infoClose = scan('```mermaid\nA-->B\n``` tail')
    expect(infoClose).toHaveLength(0)
  })

  it('未闭合围栏（EOF）不产出（稳定降级为源码）', () => {
    expect(scan('```mermaid\ngraph TD\nA-->B')).toHaveLength(0)
  })

  it('反引号围栏的 info 含反引号时不开启（CommonMark）', () => {
    expect(scan('```mermaid`\nA\n```')).toHaveLength(0)
  })

  it('围栏之后的内容照常开启新围栏；多围栏互不吞并', () => {
    const text = [
      '```mermaid',
      'graph TD',
      'A-->B',
      '```',
      '正文',
      '```mermaid',
      'sequenceDiagram',
      'A->>B: hi',
      '```',
    ].join('\n')
    const spans = scan(text)
    expect(spans).toHaveLength(2)
    expect(spans.every((s) => s.mermaid)).toBe(true)
    expect(spans[1]!.code).toBe('sequenceDiagram\nA->>B: hi')
  })

  it('firstLineStart 非零时区间以全文坐标产出（增量窗口直驱）', () => {
    const lines = ['```mermaid', 'graph TD', '```']
    const spans = scanFenceSpans(lines, 100)
    expect(spans[0]!.from).toBe(100)
    expect(spans[0]!.to).toBe(100 + lines.join('\n').length)
  })
})

describe('scanFencesDetailed：窗口扫描的开放状态回报', () => {
  it('窗口末尾处于开放围栏内时 open 回报开启信息', () => {
    const r = scanFencesDetailed(['正文', '```mermaid', 'graph TD'], 0)
    expect(r.spans).toHaveLength(0)
    expect(r.open).not.toBeNull()
    expect(r.open!.from).toBe('正文\n'.length)
    expect(r.open!.mermaid).toBe(true)
  })

  it('窗口全部闭合时 open 为 null', () => {
    const r = scanFencesDetailed(['```mermaid', 'A-->B', '```'], 0)
    expect(r.open).toBeNull()
    expect(r.spans).toHaveLength(1)
  })
})

describe('FenceSpan 与增量重建的坐标契约', () => {
  it('to 为闭围栏行行尾（不含换行），映射语义与 MathOccurrence 同构', () => {
    const text = '```mermaid\nA\n```\ntail'
    const s: FenceSpan | undefined = scanFenceSpans(text.split('\n'), 0)[0]
    expect(s).toBeDefined()
    expect(text.slice(s!.from, s!.to)).toBe('```mermaid\nA\n```')
  })
})
