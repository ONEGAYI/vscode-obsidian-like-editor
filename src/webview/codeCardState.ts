// 代码块卡片共享状态（中立模块，#79–#85 演进中拆出）：卡片配置 facet、
// 复制/折叠 effects 与折叠状态 field。原先全部住在 liveCodeCard——渲染型
// 围栏（mermaid）接入后 liveMermaid 需要感知折叠态（折叠收起时让位给
// 卡片），而 liveCodeCard 依赖 liveMermaid 的围栏表，直接引用会循环依赖；
// 本模块不依赖任何装饰模块，两侧各自单向引用。
//
// 折叠语义：视图态（不写源文件、不跨会话持久化，重开文档全展开）。
// 消费点（卡片装饰与 mermaid 装饰）均以「当前围栏起始位置」查询——
// update 只做位置映射，不做围栏表修剪：残留条目落在非围栏起点位置时
// 天然查不中，无行为影响（避免本模块反向依赖围栏表）。卡片总开关关闭
// 时清空：mermaid 的让位判定不读卡片配置，只看折叠集，若不清空，关闭
// 瞬间会出现「SVG 与收起形态同时缺席」的空白。
import { Facet, StateEffect, StateField } from '@codemirror/state'

/** 卡片运行配置（设置驱动；liveCodeCard 消费全部键，card 同时是 mermaid 让位的门控） */
export interface CodeCardConfig {
  /** 卡片总开关（codeblock.card）：关闭回到朴素围栏源码外观 */
  card: boolean
  /** 卡内行号（codeblock.lineNumbers，#80） */
  lineNumbers: boolean
  /** 复制按钮（codeblock.copyButton，#81） */
  copyButton: boolean
  /** 语法高亮（codeblock.highlight，#83；卡片关闭时朴素围栏仍可着色） */
  highlight: boolean
}

// facet 兜底默认 card:false 是刻意的保守缺省：装配早期（设置快照未到达）
// 不发射卡片；syncController 恒以 CODEBLOCK_*_DEFAULT 提供配置，此兜底
// 仅测试直驱可触达。
const DEFAULT_CONFIG: CodeCardConfig = { card: false, lineNumbers: true, copyButton: true, highlight: true }

/** 卡片配置通道（Compartment 内静态值；变更经 reconfigure 触发全量重建） */
export const codeCardConfigFacet = Facet.define<CodeCardConfig, CodeCardConfig>({
  combine: (inputs) => (inputs.length > 0 ? inputs[inputs.length - 1]! : DEFAULT_CONFIG),
})

/**
 * 复制请求 effect（#81）：按钮点击 → 零写回事务携带代码体原文，由
 * syncController 的 updateListener 转发 codeblock.copy 出站（宿主剪贴板）。
 * 不落文档、不产生撤销历史。
 */
export const codeCardCopyRequest = StateEffect.define<string>()

/**
 * 折叠切换 effect（#82）：chevron 点击 → 零写回事务携带围栏起始位置，
 * 由 codeCardFoldField 消费（视图态，不写源文件、不跨会话持久化）。
 */
export const codeCardFoldToggle = StateEffect.define<number>()

const EMPTY_FOLD: ReadonlySet<number> = new Set<number>()

/**
 * 折叠状态（#82）：已收起围栏的起始位置集合（card 关闭时恒空，见模块
 * 头注释）。值按围栏起始位置标识，docChanged 时随 ChangeSet 映射。
 */
export const codeCardFoldField = StateField.define<ReadonlySet<number>>({
  create: () => EMPTY_FOLD,
  update(value, tr) {
    if (!tr.state.facet(codeCardConfigFacet).card) {
      return EMPTY_FOLD
    }
    let next = value
    let changed = false
    for (const eff of tr.effects) {
      if (eff.is(codeCardFoldToggle)) {
        const toggled = new Set(next)
        if (!toggled.delete(eff.value)) {
          toggled.add(eff.value)
        }
        next = toggled
        changed = true
      }
    }
    if (tr.docChanged) {
      const mapped = new Set<number>()
      for (const pos of next) {
        mapped.add(tr.changes.mapPos(pos, 1))
      }
      next = mapped
      changed = true
    }
    return changed ? next : value
  },
})
