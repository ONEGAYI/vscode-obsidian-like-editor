// 变更重定位纯函数：宿主收到 baseVersion 落后的 edit.request 时，把请求的
// offset/length 穿过「从 baseVersion 到当前版本之间已应用的变更组」。
//
// 坐标约定：
// - appliedGroups 按时间顺序排列，每组对应一次文档变更事件；组内多个
//   SerChange 共享同一旧文档参考系（与 contentChanges / CM6 单事务同构）。
// - 待映射区间 [offset, offset+length] 的两端点独立映射，端点相邻时保留
//   原有左右顺序；区间与已应用变更真正重叠时返回 null。只检查端点会漏掉
//   同区间替换与整个包含的情形，使过期本地编辑覆盖外部输入。
import type { SerChange } from './protocol'

/** 在同参考系的一组变更内映射单个位置；不可安全映射返回 null */
function mapPosInGroup(pos: number, sorted: readonly SerChange[]): number | null {
  let delta = 0
  for (const c of sorted) {
    if (pos <= c.offset) {
      // 左端点相邻不包含已应用变更；排序保证后续变更更靠右
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
    const mapped = mapPosInGroup(out, sortByOffset(group))
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
    if (from === to && sorted.some((c) => c.length === 0 && c.offset === from)) {
      return null // 同点双插入的顺序无法由过期请求确定
    }
    if (from < to && sorted.some((c) => (
      c.length > 0
        ? from < c.offset + c.length && to > c.offset
        : from <= c.offset && to > c.offset
    ))) {
      return null
    }
    const fromMapped = mapPosInGroup(from, sorted)
    if (fromMapped === null) {
      return null
    }
    const toMapped = mapPosInGroup(to, sorted)
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
