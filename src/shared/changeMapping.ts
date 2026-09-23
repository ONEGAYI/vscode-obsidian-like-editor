// 变更重定位纯函数：宿主收到 baseVersion 落后的 edit.request 时，把请求的
// offset/length 穿过「从 baseVersion 到当前版本之间已应用的变更组」。
//
// 坐标约定：
// - appliedGroups 按时间顺序排列，每组对应一次文档变更事件；组内多个
//   SerChange 共享同一旧文档参考系（与 contentChanges / CM6 单事务同构）。
// - 待映射区间 [offset, offset+length] 的两端点独立映射（from 偏左邻、
//   to 偏右邻）；任一端点落入某个已应用变更的删除开区间 → 返回 null，
//   由调用方走全文重同步（保守优先，不静默丢字）。
import type { SerChange } from './protocol'

type Side = 'from' | 'to'

/** 在同参考系的一组变更内映射单个位置；不可安全映射返回 null */
function mapPosInGroup(pos: number, sorted: readonly SerChange[], side: Side): number | null {
  let delta = 0
  for (const c of sorted) {
    const left = side === 'from' ? pos <= c.offset : pos < c.offset
    if (left) {
      // pos 在此变更左侧（from 侧含左端点重合），排序保证后续变更更靠右
      break
    }
    if (pos >= c.offset + c.length) {
      delta += c.text.length - c.length
      continue
    }
    // pos 落在删除开区间 (offset, offset+length) 内
    return null
  }
  return pos + delta
}

function sortByOffset(group: readonly SerChange[]): SerChange[] {
  return [...group].sort((a, b) => a.offset - b.offset)
}

/** 映射单个位置（from 侧语义）穿过全部已应用变更组 */
export function mapOffsetThroughChanges(
  pos: number,
  appliedGroups: readonly (readonly SerChange[])[],
): number | null {
  let out = pos
  for (const group of appliedGroups) {
    const mapped = mapPosInGroup(out, sortByOffset(group), 'from')
    if (mapped === null) {
      return null
    }
    out = mapped
  }
  return out
}

/** 映射一个编辑区间穿过全部已应用变更组；不可安全映射返回 null */
export function mapChangeThroughChanges(
  change: SerChange,
  appliedGroups: readonly (readonly SerChange[])[],
): SerChange | null {
  let from = change.offset
  let to = change.offset + change.length
  for (const group of appliedGroups) {
    const sorted = sortByOffset(group)
    const fromMapped = mapPosInGroup(from, sorted, 'from')
    if (fromMapped === null) {
      return null
    }
    const toMapped = mapPosInGroup(to, sorted, 'to')
    if (toMapped === null) {
      return null
    }
    from = fromMapped
    to = toMapped
  }
  if (from > to) {
    return null
  }
  return { offset: from, length: to - from, text: change.text }
}
