/** 在光标/选区处插入两列、表头加一行数据的空 GFM 表格。 */
export interface PlannedTableCreation {
  changes: { from: number; to: number; insert: string }
  selection: number
}

const EMPTY_TABLE = '|  |  |\n| --- | --- |\n|  |  |'

export function planCreateTable(doc: string, from: number, to = from): PlannedTableCreation {
  if (from < 0 || to < from || to > doc.length) {
    throw new RangeError('表格插入位置超出文档范围')
  }
  const lineStart = doc.lastIndexOf('\n', from - 1) + 1
  const nextBreak = doc.indexOf('\n', to)
  const lineEnd = nextBreak < 0 ? doc.length : nextBreak
  const before = doc.slice(0, lineStart)
  const after = doc.slice(lineEnd)
  const left = doc.slice(lineStart, from)
  const right = doc.slice(to, lineEnd)
  const leftText = left.trim() ? left : ''
  const rightText = right.trim() ? right : ''
  const previousLine = before.endsWith('\n') ? before.slice(0, -1).split('\n').at(-1) ?? '' : ''
  const nextLine = after.startsWith('\n') ? after.slice(1).split('\n', 1)[0] ?? '' : ''
  const prefix = leftText ? `${leftText}\n\n` : previousLine.trim() ? '\n' : ''
  const suffix = rightText ? `\n\n${rightText}` : nextLine.trim() ? '\n' : ''
  return {
    changes: { from: lineStart, to: lineEnd, insert: prefix + EMPTY_TABLE + suffix },
    selection: lineStart + prefix.length + 2,
  }
}
