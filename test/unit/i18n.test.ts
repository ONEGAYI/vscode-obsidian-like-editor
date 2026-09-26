// t() 取词模块契约（#93 i18n 基础设施）：{x} 简单占位插值、运行时回退链
// （当前包 → en 包 → 键名本身）、装配通知（locale 换包后监听者重渲染）。
// 单测路径 = 装配三径之一：直接向 t() 注入测试语言包（规格「字典架构」）。
import { describe, it, expect, vi } from 'vitest'
import {
  installLocale,
  t,
  currentLocaleLang,
  onLocaleChanged,
} from '../../src/shared/i18n'

describe('t() 插值（{x} 简单占位，无复数语法）', () => {
  it('单占位符与多占位符替换；数值参数转字符串', () => {
    installLocale('en', { 'find.count': 'Found {total} matches' })
    expect(t('find.count', { total: 3 })).toBe('Found 3 matches')

    installLocale('en', { 'find.status': '{index} / {total} of {name}' })
    expect(t('find.status', { index: 1, total: 9, name: 'a' })).toBe('1 / 9 of a')
  })

  it('缺参占位符原样保留；无参调用返回原文', () => {
    installLocale('en', { 'find.count': 'Found {total} matches' })
    expect(t('find.count', { other: 1 })).toBe('Found {total} matches')
    expect(t('find.count')).toBe('Found {total} matches')
  })

  it('非占位符花括号不参与替换', () => {
    installLocale('en', { 'math.brace': 'set {x} = {{literal}}' })
    expect(t('math.brace', { x: '1' })).toBe('set 1 = {{literal}}')
  })

  it('插值单遍扫描：替换值中的占位符字样不被后续轮二次替换（R2）', () => {
    installLocale('en', { 'a.chain': '{x} and {y}', 'a.adjacent': '{x}{y}' })
    // 旧实现按 params 顺序逐个 replaceAll：先替换的 {x} 值 "{y}" 会被第二轮
    // {y} 替换吞掉（级联）；单遍扫描的值不参与后续替换
    expect(t('a.chain', { x: '{y}', y: 'V' })).toBe('{y} and V')
    expect(t('a.adjacent', { x: '{y}', y: 'z' })).toBe('{y}z')
  })
})

describe('t() 回退链（当前包 → en 包 → 键名本身，防御性）', () => {
  it('三段回退逐级命中', () => {
    installLocale(
      'zh-cn',
      { 'a.onlyZh': '当前包命中', 'a.both': '当前包优先' },
      { fallback: { 'a.both': 'en包值', 'a.onlyEn': 'en包独有' } },
    )
    expect(t('a.onlyZh')).toBe('当前包命中')
    expect(t('a.both')).toBe('当前包优先')
    expect(t('a.onlyEn')).toBe('en包独有')
    expect(t('a.nowhere')).toBe('a.nowhere')
  })

  it('未装配任何语言包时直接回退键名（不抛错）', () => {
    installLocale('en', {})
    expect(t('nothing.installed')).toBe('nothing.installed')
  })

  it('回退命中的词条同样参与插值', () => {
    installLocale('zh-cn', {}, { fallback: { 'a.fallback': 'fb {n}' } })
    expect(t('a.fallback', { n: 7 })).toBe('fb 7')
  })
})

describe('装配状态与变更通知', () => {
  it('installLocale 记录当前语言代码', () => {
    installLocale('zh-cn', { 'k.a': '甲' })
    expect(currentLocaleLang()).toBe('zh-cn')
    installLocale('en', { 'k.a': 'a' })
    expect(currentLocaleLang()).toBe('en')
  })

  it('installLocale 通知监听者（换包后重渲染常驻文本的驱动源）', () => {
    const listener = vi.fn()
    const off = onLocaleChanged(listener)
    installLocale('en', { 'k.a': 'a' })
    expect(listener).toHaveBeenCalledTimes(1)
    installLocale('zh-cn', { 'k.a': '甲' })
    expect(listener).toHaveBeenCalledTimes(2)
    off()
    installLocale('en', { 'k.a': 'a' })
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
