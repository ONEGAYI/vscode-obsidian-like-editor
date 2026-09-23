// 换行协调器：宿主文本（可能 CRLF/LF/混合行尾）与 webview 侧 LF 形态的
// 双向转换。CM6 内部把 \r\n 规范化为 \n（@codemirror/state 实测行为，
// lineSeparator facet 亦无法保真），因此协议约定 webview 全程使用 LF
// 坐标与文本，转换全部在持有权威全文的宿主侧完成。
//
// - 宿主 -> LF：坐标按「越过的 \r\n 行尾数」缩减，文本一律 \r\n -> \n
// - LF -> 宿主：坐标按「越过的行尾中属 CRLF 的数量」扩张；文本仅在文档
//   行尾全为 CRLF 时把 \n 还原为 \r\n（混合文档保持 LF，不改写既有风格）
import type { SerChange } from './protocol'

export class NewlineCoordinator {
  /** 宿主文本中每个 \r\n 的 \r 宿主坐标（升序） */
  private crlfPositions: number[] = []
  /** \n 总数（含 CRLF 行尾），用于判定「行尾全为 CRLF」 */
  private lineBreakCount = 0

  constructor(hostText?: string) {
    if (hostText !== undefined) {
      this.rebuild(hostText)
    }
  }

  /** 文档行尾全为 CRLF（此时插入文本的 \n 还原为 \r\n） */
  get isCrlfDoc(): boolean {
    return this.lineBreakCount > 0 && this.crlfPositions.length === this.lineBreakCount
  }

  hasCrlf(): boolean {
    return this.crlfPositions.length > 0
  }

  /** 依据当前宿主全文重建行尾位置表（O(n)，每次文档变更后调用） */
  rebuild(hostText: string): void {
    const positions: number[] = []
    let breaks = 0
    for (let i = 0; i < hostText.length; i++) {
      if (hostText.charCodeAt(i) === 13 && hostText.charCodeAt(i + 1) === 10) {
        positions.push(i)
        breaks++
        i++ // \r\n 的 \n 已计入行尾，跳过
      } else if (hostText.charCodeAt(i) === 10) {
        breaks++
      }
    }
    this.crlfPositions = positions
    this.lineBreakCount = breaks
  }

  toLfText(hostText: string): string {
    return hostText.replace(/\r\n/g, '\n')
  }

  /** 宿主 offset -> LF offset：越过的每个 \r\n 行尾贡献 -1 */
  hostOffsetToLf(hostPos: number): number {
    return hostPos - this.countCrlfBefore(hostPos)
  }

  /** LF offset -> 宿主 offset：越过的每个 CRLF 行尾贡献 +1 */
  lfOffsetToHost(lfPos: number): number {
    return lfPos + this.countCrlfLfBefore(lfPos)
  }

  /** 宿主坐标变更组 -> LF 坐标变更组 */
  hostChangesToLf(changes: readonly SerChange[]): SerChange[] {
    return changes.map((c) => ({
      offset: this.hostOffsetToLf(c.offset),
      length:
        this.hostOffsetToLf(c.offset + c.length) - this.hostOffsetToLf(c.offset),
      text: c.text.replace(/\r\n/g, '\n'),
    }))
  }

  /** LF 坐标变更组 -> 宿主坐标变更组（含插入文本换行还原策略） */
  lfChangesToHost(changes: readonly SerChange[]): SerChange[] {
    const toHostText = (text: string) =>
      this.isCrlfDoc ? text.replace(/\n/g, '\r\n') : text
    return changes.map((c) => ({
      offset: this.lfOffsetToHost(c.offset),
      length: this.lfOffsetToHost(c.offset + c.length) - this.lfOffsetToHost(c.offset),
      text: toHostText(c.text),
    }))
  }

  /** 统计宿主坐标 pos 之前（严格小于）的 \r\n 数量 */
  private countCrlfBefore(hostPos: number): number {
    let count = 0
    for (const p of this.crlfPositions) {
      if (p < hostPos) {
        count++
      } else {
        break
      }
    }
    return count
  }

  /** 统计 LF 坐标 lfPos 之前的 CRLF 行尾数量（第 i 个 CRLF 的 LF 坐标为 crlfPositions[i] - i） */
  private countCrlfLfBefore(lfPos: number): number {
    let count = 0
    for (let i = 0; i < this.crlfPositions.length; i++) {
      if (this.crlfPositions[i] - i < lfPos) {
        count++
      } else {
        break
      }
    }
    return count
  }
}
