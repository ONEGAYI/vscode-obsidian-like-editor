// 大纲标题搜索纯函数（#68）：大小写不敏感子串匹配与搜索态可见性合成。
//
// 语义单一事实源（供契约测试 outlineSearch.test.ts 对拍）：
//
// 1. 匹配对象是剥标记可见文本（plainText——`**粗体**` 输「粗体」命中，
//    与渲染/无障碍口径同源，见 outline.ts 的 PlainTextCollector）；不做
//    正则，两侧 toLowerCase 后 indexOf 子串判定。两侧都是**整串**口径
//    （标题侧 `plainText.toLowerCase()` 一次算出、查询侧 `query.toLowerCase()`），
//    对上下文相关的大小写映射才等价——见 foldText 注释的终写 sigma。
//
// 2. 保留口径：命中条目 + 其全部祖先（匹配路径）保留，其余隐藏——
//    祖先链由 outlineCollapse 的栈算法父子结构派生（跨级自然挂靠）。
//    祖先「保留」不等于「高亮」：ranges 只记直接命中区间。
//
// 3. 片段级高亮：同条目内多处出现全部收集（有序不重叠区间，渲染层逐段
//    包 mark）；空输入等于无过滤（kept 全 true、无区间、noMatch 恒 false）。
//
// 4. 展开集合成（搜索态自动展开匹配路径）：base（进入搜索时的快照、或
//    搜索态切档后的档位精确集）∪ 全部命中条目的祖先链——只增不减，用户
//    在搜索态的手动展开/折叠保留在 base 之外的当前集合里由调用方合成。
//
// 5. 组合可见口径：条目可见 ⟺ 折叠可见（outlineCollapse 的祖先全展开
//    判定）∧ 搜索保留（kept）。高亮代表沿祖先链找第一个组合可见条目；
//    链上无可见代表（含顶层被过滤）返回 null——搜索态下当前控制域与
//    搜索无关时高亮消失，不强加。
//
// 与外层的分工：本模块不触 DOM、不持状态；搜索词与展开快照的生命周期
// （进入快照、清空回放、切档基准同步）在 syncController，见其 #68 区块。
import { outlineCollapseFacts, outlineHiddenFlags } from './outlineCollapse'

/** 搜索状态机消费的条目形状（与 outlineCollapse 同款：plainText 即匹配口径） */
type SearchableItem = { level: number; plainText: string }

/** 命中区间（plainText 内偏移；start 含、end 不含） */
export interface OutlineSearchRange {
  start: number
  end: number
}

/** 搜索过滤结果（与条目序列同序） */
export interface OutlineSearchFilter {
  /** 直接命中条目索引（plainText 含查询子串） */
  matchedIndices: number[]
  /** kept[i]：搜索态保留（命中或命中路径祖先） */
  kept: boolean[]
  /** ranges[i]：第 i 条目 plainText 的全部命中区间（非命中条目为空数组） */
  ranges: OutlineSearchRange[][]
  /** 有词条但无任何命中（「无匹配」占位判据；空输入/空序列恒 false） */
  noMatch: boolean
}

/** 折叠文本 + 折叠码元 → 原串坐标映射（review-loops 第 3 轮：整串折叠口径）。
 *
 *  - **内容取整串折叠**：`s.toLowerCase()` 一次算出。默认（非 locale）大小写
 *    映射含上下文相关规则，逐字符折叠与整串折叠**不等价**——希腊文终写 sigma
 *    （U+03A3 GREEK CAPITAL LETTER SIGMA 在词尾折 U+03C2 ς、在字中折 U+03C3 σ）：
 *    'ΟΔΟΣ' 整串得 'οδος'、逐字符拼接得 'οδοσ'。查询侧 needle 是整串
 *    `query.toLowerCase()`，标题侧只有同用整串结果才与它同处一个坐标系
 *    （旧实现按逐字符结果建索引 → 标题原文直接粘贴进搜索框检索落空，条目被过滤）。
 *  - **分段长度取逐字符折叠**：上下文规则只改内容不改长度（'ΟΔΟΣ' 两侧都是 4
 *    码元；对 U+0000–U+10FFFF 逐码点 × 63 组前后文（9 前文 × 7 后文）枚举，
 *    默认 toLowerCase 下只有 U+03A3 整串 ≠ 逐字符、且无长度歧义），故长度是
 *    这里唯一能逐字符拿到的量，分段与整串结果逐段对齐。
 *  - `start[k]`/`end[k]` 是折叠串第 k 码元所属原串字符的 [起, 止) 区间：
 *    末端取「所属字符的终点」而非「下一字符的起点」——命中末端落在折叠展开
 *    的字符内部时区间才不被截短，整个命中落在展开内部时也不为零宽。
 *  - 单字符折多码元时（İ → i+U+0307）各码元同属该字符；非 BMP 字母按**码点**
 *    折叠（`for…of` 遍历，代理对整体折：U+10400 → U+10428），逐 UTF-16 码元
 *    折叠会拆开代理对、丢掉大小写映射。 */
function foldText(s: string): { folded: string; start: number[]; end: number[] } {
  const folded = s.toLowerCase()
  const start: number[] = []
  const end: number[] = []
  let i = 0 // 原串码元游标
  let k = 0 // 折叠串码元游标（start/end 的下标）
  let lastStart = 0
  for (const ch of s) {
    // 逐字符折叠长度即该字符在整串折叠里的码元数；以 folded 余量为上限只是
    // 防御未知映射规则（默认映射下恒不触发），保证映射不越出 folded
    const take = Math.min(ch.toLowerCase().length, folded.length - k)
    for (let u = 0; u < take; u++) {
      start.push(i)
      end.push(i + ch.length)
    }
    k += take
    lastStart = i
    i += ch.length
  }
  // 防御：逐字符长度之和短于整串折叠时（默认映射下不存在），余下码元归最后
  // 一个原串字符——start/end 长度恒等于 folded.length，区间不越出原串
  while (k < folded.length) {
    start.push(lastStart)
    end.push(s.length)
    k++
  }
  return { folded, start, end }
}

/**
 * 搜索过滤：query 为空串时等于无过滤（kept 全 true、matched/ranges 空、
 * noMatch false）。多出现全收集；kept = 命中 ∪ 命中祖先
 */
export function outlineSearchFilter(items: readonly SearchableItem[], query: string): OutlineSearchFilter {
  const n = items.length
  const kept: boolean[] = new Array(n).fill(false)
  const ranges: OutlineSearchRange[][] = Array.from({ length: n }, () => [])
  const matchedIndices: number[] = []
  if (query === '' || n === 0) {
    kept.fill(true)
    return { matchedIndices, kept, ranges, noMatch: false }
  }
  const needle = query.toLowerCase()
  for (let i = 0; i < n; i++) {
    const { folded, start, end } = foldText(items[i]!.plainText)
    let at = folded.indexOf(needle)
    while (at !== -1) {
      // 折叠区间 [at, at+len) 经映射回原串坐标（mark 高亮的真实区间）
      ranges[i]!.push({ start: start[at]!, end: end[at + needle.length - 1]! })
      at = folded.indexOf(needle, at + needle.length)
    }
    if (ranges[i]!.length > 0) {
      matchedIndices.push(i)
      kept[i] = true
    }
  }
  if (matchedIndices.length > 0) {
    // 命中路径祖先保留（栈算法父子结构；顶层祖先自然可见）
    const { parents } = outlineCollapseFacts(items)
    for (const i of matchedIndices) {
      let cur = parents[i]
      while (cur !== null) {
        kept[cur] = true
        cur = parents[cur]
      }
    }
  }
  return { matchedIndices, kept, ranges, noMatch: matchedIndices.length === 0 }
}

/**
 * 搜索展开集合成：base ∪ 全部命中条目的祖先链（匹配路径自动展开——
 * 命中条目在折叠口径下可见）。命中自身不必然入选（其非命中子树由过滤
 * 口径隐藏，无展开需求）。空命中返回 base 引用（调用方零成本判无变化）
 */
export function outlineSearchExpandSet(
  items: readonly SearchableItem[],
  base: ReadonlySet<number>,
  matchedIndices: readonly number[],
): ReadonlySet<number> {
  if (matchedIndices.length === 0) {
    return base
  }
  const { parents } = outlineCollapseFacts(items)
  const out = new Set(base)
  for (const i of matchedIndices) {
    let cur = parents[i] ?? null
    while (cur !== null) {
      out.add(cur)
      cur = parents[cur]
    }
  }
  return out
}

/**
 * 搜索态高亮代表：index 的第一个「折叠可见 ∧ 搜索保留」的自身或祖先。
 * 链上无组合可见者（含顶层被过滤）或索引越界返回 null——搜索态下高亮
 * 消失而非强加到无关条目
 */
export function outlineSearchRepresentativeIndex(
  items: readonly SearchableItem[],
  expanded: ReadonlySet<number>,
  kept: readonly boolean[],
  index: number,
): number | null {
  if (index < 0 || index >= items.length) {
    return null
  }
  const { parents } = outlineCollapseFacts(items)
  const hidden = outlineHiddenFlags(items, expanded)
  let cur: number | null = index
  while (cur !== null) {
    if (!hidden[cur] && kept[cur] === true) {
      return cur
    }
    cur = parents[cur]
  }
  return null
}

/** 组合可见口径的条目索引序列：折叠可见 ∩ 搜索保留（probe 的
 *  filteredVisibleIndices；搜索关闭时 kept 传全 true 即折叠口径） */
export function outlineFilteredVisibleIndices(
  items: readonly SearchableItem[],
  expanded: ReadonlySet<number>,
  kept: readonly boolean[],
): number[] {
  const hidden = outlineHiddenFlags(items, expanded)
  const out: number[] = []
  for (let i = 0; i < items.length; i++) {
    if (!hidden[i] && kept[i] === true) {
      out.push(i)
    }
  }
  return out
}
