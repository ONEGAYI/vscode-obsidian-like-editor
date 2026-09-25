// 大纲折叠状态机纯函数（#67）：档位 + 展开集合 → 条目可见性。
//
// 语义单一事实源（供契约测试 outlineCollapse.test.ts 对拍）：
//
// 1. 父结构：parent[i] = 向上最近的更浅标题（栈算法，跨级标题自然挂靠：
//    H1 直接跟 H3 时 H3 挂 H1 下）；hasChildren[i] = 紧邻后一标题层级更深
//    （叶节点永不进展开集；H6 恒为叶——Markdown 无更深层级）。
//
// 2. 档位（No-Expand=0、展开到 Hn=n∈1..5）：档位 n 的精确展开集 =
//    所有 level≤n 且有子项的父节点。「展开到 Hn」是展开这些父节点
//    （其直接子级全部可见），不是只显示 level≤n 的标题。
//
// 3. 展开集合（expanded：父节点索引集合）是唯一的折叠状态载体——
//    档位切换 = 整体替换为档位精确集（手动微调不保留）；手动折叠/展开 =
//    删/加单键；滚动动态展开（only-expand）= 目标被遮蔽时并入其祖先链
//    （只增不减，不打扰其他折叠区）。
//
// 4. 可见性：条目可见 ⟺ 其全部祖先都在展开集中（折叠父节点遮蔽整个
//    子树，即使子树内有已展开节点）。顶层条目无祖先，恒可见。
//
// 5. 高亮回退：条目被折叠遮蔽时，其「可见代表」= 沿祖先链向上的第一个
//    可见条目（常驻高亮施加在代表上；真实控制域索引不变）。
//
// 6. 编辑后迁移（刷新存活）：Myers diff 以 (level, plainText) 为等价
//    判据求锚点（行号不参与——纯增删行不扰动），连续的删除+插入段内按
//    顺序 1:1 配对（重命名 = 一删一插，保键不扰动视图）。删除条目丢键；
//    safeFilter 清除指向叶节点的键；新增条目与其升格为父的祖先自动展开
//    （新标题可见，QO 同款语义；副作用是折叠父下新增子标题会展开该父——
//    「不无故折叠用户视图」优先于「绝不展开」）。
//
// 与外层的分工：本模块不触 DOM、不持状态；syncController 持有档位与
// 展开集合并负责落 DOM（hidden/collapsed 类）与持久化（档位经 bridge
// state 全局记忆；展开集合是会话内内存态，重载后回到档位精确集）。

/** 档位数（0=No-Expand、1..5=展开到 H1..H5） */
export type OutlineExpandLevel = 0 | 1 | 2 | 3 | 4 | 5

/** 默认档位：H5 全展开 */
export const OUTLINE_EXPAND_LEVEL_DEFAULT: OutlineExpandLevel = 5

/** 档位 → 滑块圆点的可访问名称（aria-label 与 title 共用） */
export function outlineExpandLevelLabel(level: number): string {
  if (level === 0) {
    return '全部折叠'
  }
  const names = ['', '一', '二', '三', '四', '五']
  return `展开到${names[level] ?? ''}级标题`
}

/** 校验持久化恢复的档位值（脏 state 防御：越界/非整数回退默认） */
export function normalizeOutlineExpandLevel(v: unknown): OutlineExpandLevel {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 5) {
    return v as OutlineExpandLevel
  }
  return OUTLINE_EXPAND_LEVEL_DEFAULT
}

/** 折叠状态机消费的条目形状（只需 level 与 plainText，迁移判据同源） */
type LevelLike = { level: number; plainText: string }

/** 条目父子结构（从标题序列线性派生） */
export interface OutlineCollapseFacts {
  /** parent[i]：向上最近的更浅标题索引（顶层为 null） */
  parents: ReadonlyArray<number | null>
  /** hasChildren[i]：紧邻后一标题层级更深（父节点判定） */
  hasChildren: readonly boolean[]
}

/** 父子结构：单遍栈算法（栈内 level 严格递减，弹到更浅者即父） */
export function outlineCollapseFacts(items: readonly LevelLike[]): OutlineCollapseFacts {
  const parents: Array<number | null> = new Array(items.length).fill(null)
  const hasChildren: boolean[] = new Array(items.length).fill(false)
  const stack: number[] = [] // 栈内条目 level 严格递减（更浅在底）
  for (let i = 0; i < items.length; i++) {
    while (stack.length > 0 && items[stack[stack.length - 1]!]!.level >= items[i]!.level) {
      stack.pop()
    }
    parents[i] = stack.length > 0 ? stack[stack.length - 1]! : null
    if (parents[i] !== null) {
      hasChildren[parents[i]!] = true
    }
    stack.push(i)
  }
  return { parents, hasChildren }
}

/** 档位 n 的精确展开集：所有 level≤n 且有子项的父节点（叶节点永不入选） */
export function outlineExpandSetForLevel(items: readonly LevelLike[], level: number): Set<number> {
  const out = new Set<number>()
  for (let i = 0; i + 1 < items.length; i++) {
    if (items[i]!.level <= level && items[i + 1]!.level > items[i]!.level) {
      out.add(i)
    }
  }
  return out
}

/** 每条目是否被折叠遮蔽（hidden[i]：任一祖先不在展开集中）。
 *  线性扫描：hideBelow 记录最近一个「是父节点且未展开」的层级——
 *  更深的连续条目都属于其子树，直到层级回到 ≤hideBelow */
export function outlineHiddenFlags(
  items: readonly LevelLike[],
  expanded: ReadonlySet<number>,
): boolean[] {
  const hidden: boolean[] = new Array(items.length).fill(false)
  let hideBelow: number | null = null
  for (let i = 0; i < items.length; i++) {
    const level = items[i]!.level
    if (hideBelow !== null && level > hideBelow) {
      hidden[i] = true
      continue
    }
    hideBelow = null
    const isParent = i + 1 < items.length && items[i + 1]!.level > level
    if (isParent && !expanded.has(i)) {
      hideBelow = level
    }
  }
  return hidden
}

/** 可见条目索引序列（hiddenFlags 的紧凑形态；probe 的 visibleIndices） */
export function outlineVisibleIndices(
  items: readonly LevelLike[],
  expanded: ReadonlySet<number>,
): number[] {
  const out: number[] = []
  const hidden = outlineHiddenFlags(items, expanded)
  for (let i = 0; i < hidden.length; i++) {
    if (!hidden[i]) {
      out.push(i)
    }
  }
  return out
}

/** 高亮回退：index 的可见代表（自身可见即自身；否则沿祖先链向上的第一个
 *  可见条目）。索引越界或空序列返回 null。顶层恒可见保证回退有解 */
export function outlineRepresentativeIndex(
  items: readonly LevelLike[],
  expanded: ReadonlySet<number>,
  index: number,
): number | null {
  if (index < 0 || index >= items.length) {
    return null
  }
  const { parents } = outlineCollapseFacts(items)
  const hidden = outlineHiddenFlags(items, expanded)
  let cur: number | null = index
  while (cur !== null) {
    if (!hidden[cur]) {
      return cur
    }
    cur = parents[cur]!
  }
  return null // 不可达（顶层恒可见）；类型完备性兜底
}

/** only-expand（滚动动态展开）：目标被折叠遮蔽时并入其全部祖先链
 *  （只增不减，其他折叠区不动），返回新集合；已可见返回原集合引用
 *  （调用方零成本判无变化）。索引越界原样返回 */
export function outlineExpandAncestors(
  items: readonly LevelLike[],
  expanded: ReadonlySet<number>,
  index: number,
): ReadonlySet<number> {
  if (index < 0 || index >= items.length) {
    return expanded
  }
  const { parents } = outlineCollapseFacts(items)
  const hidden = outlineHiddenFlags(items, expanded)
  if (!hidden[index]) {
    return expanded
  }
  const out = new Set(expanded)
  let cur: number | null = parents[index]!
  while (cur !== null) {
    out.add(cur)
    cur = parents[cur]!
  }
  return out
}

// ---- 编辑后迁移（Myers diff + 段内配对 + safeFilter + 新增展开） ----

/** diff 结果：键索引映射（prev → next；已删除不进 map）+ 新增条目需
 *  自动展开的父节点集合（祖先链 + 新增自身是父节点者） */
interface OutlineDiffResult {
  map: Map<number, number>
  autoExpand: Set<number>
}

/** prev/next 的结构 diff：Myers 最短编辑脚本 + 段内 1:1 配对 */
function outlineDiff(prev: readonly LevelLike[], next: readonly LevelLike[]): OutlineDiffResult {
  // Myers O(ND)（标题序列的编辑量 D 常态极小）。等价判据 = level +
  // plainText（行号与标记结构不参与：纯增删行/改标记不扰动折叠状态）
  const eq = (a: number, b: number): boolean =>
    prev[a]!.level === next[b]!.level && prev[a]!.plainText === next[b]!.plainText
  const n = prev.length
  const m = next.length
  const max = n + m
  const trace: Int32Array[] = []
  let v = new Int32Array(2 * max + 1)
  let foundD = -1
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[k - 1 + max]! < v[k + 1 + max]!)) {
        x = v[k + 1 + max]!
      } else {
        x = v[k - 1 + max]! + 1
      }
      let y = x - k
      while (x < n && y < m && eq(x, y)) {
        x += 1
        y += 1
      }
      v[k + max] = x
      if (x >= n && y >= m) {
        foundD = d
        break
      }
    }
    if (foundD >= 0) {
      break
    }
  }
  // 回溯编辑脚本（keep(x,y) / delete x / insert y），恢复正序
  type Op = { op: 'keep' | 'del' | 'ins'; a: number; b: number }
  const script: Op[] = []
  if (foundD >= 0) {
    let x = n
    let y = m
    for (let d = foundD; d > 0; d--) {
      const vi = trace[d]!
      const k = x - y
      let prevK: number
      if (k === -d || (k !== d && vi[k - 1 + max]! < vi[k + 1 + max]!)) {
        prevK = k + 1
      } else {
        prevK = k - 1
      }
      const prevX = vi[prevK + max]!
      const prevY = prevX - prevK
      while (x > prevX && y > prevY) {
        x -= 1
        y -= 1
        script.push({ op: 'keep', a: x, b: y })
      }
      if (x > prevX) {
        x -= 1
        script.push({ op: 'del', a: x, b: -1 })
      } else {
        y -= 1
        script.push({ op: 'ins', a: -1, b: y })
      }
    }
    while (x > 0 && y > 0) {
      x -= 1
      y -= 1
      script.push({ op: 'keep', a: x, b: y })
    }
    while (x > 0) {
      x -= 1
      script.push({ op: 'del', a: x, b: -1 })
    }
    while (y > 0) {
      y -= 1
      script.push({ op: 'ins', a: -1, b: y })
    }
    script.reverse()
  }
  // 连续 del 块与紧随 ins 块按顺序 1:1 配对为 modify（重命名 = 一删一插，
  // 保键不扰动视图）；多出的 del 丢弃、多出的 ins 记为新增
  const map = new Map<number, number>()
  const inserted: number[] = []
  let i = 0
  while (i < script.length) {
    if (script[i]!.op === 'keep') {
      map.set(script[i]!.a, script[i]!.b)
      i += 1
      continue
    }
    const dels: number[] = []
    const inss: number[] = []
    while (i < script.length && script[i]!.op === 'del') {
      dels.push(script[i++]!.a)
    }
    while (i < script.length && script[i]!.op === 'ins') {
      inss.push(script[i++]!.b)
    }
    const pairs = Math.min(dels.length, inss.length)
    for (let p = 0; p < pairs; p++) {
      map.set(dels[p]!, inss[p]!)
    }
    for (let p = pairs; p < inss.length; p++) {
      inserted.push(inss[p]!)
    }
  }
  // 新增条目的祖先链展开（QO 同款）：让新标题可见，同时其由叶升格为父
  // 的祖先随链并入展开集（升格展开）；新增条目自身是父节点（前插新
  // 顶层等）同样展开。调用方 safeFilter 后才真正入集
  const autoExpand = new Set<number>()
  if (inserted.length > 0) {
    const { parents: np, hasChildren } = outlineCollapseFacts(next)
    for (const j of inserted) {
      let cur: number | null = np[j]!
      while (cur !== null) {
        autoExpand.add(cur)
        cur = np[cur]!
      }
      if (hasChildren[j]) {
        autoExpand.add(j)
      }
    }
  }
  return { map, autoExpand }
}

/**
 * 编辑后展开集合迁移（刷新存活的核心）：prev/next 为重建前后的标题序列，
 * prevExpanded 为旧展开集。规则见模块头 6：keep/modify 迁移键、删除丢键、
 * safeFilter 清除叶键、新增/升格父自动展开。返回新的展开集
 */
export function migrateOutlineExpanded(
  prev: readonly LevelLike[],
  next: readonly LevelLike[],
  prevExpanded: ReadonlySet<number>,
): Set<number> {
  const { map, autoExpand } = outlineDiff(prev, next)
  const nextFacts = outlineCollapseFacts(next)
  const out = new Set<number>()
  for (const [from, to] of map) {
    if (prevExpanded.has(from) && nextFacts.hasChildren[to]) {
      out.add(to) // safeFilter：目标降格为叶（或本就非法）则丢键
    }
  }
  for (const j of autoExpand) {
    if (nextFacts.hasChildren[j]) {
      out.add(j)
    }
  }
  return out
}
