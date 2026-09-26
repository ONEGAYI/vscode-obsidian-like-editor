/** 格式与插入操作的统一注册表。快捷键管理和快速操作条消费同一 id。 */
export const FORMAT_OPERATIONS = [
  { id: 'bold', command: 'onegayi.vsidian.format.bold', title: '粗体', mode: 'live', writes: true, defaultKey: 'ctrl+b' },
  { id: 'italic', command: 'onegayi.vsidian.format.italic', title: '斜体', mode: 'live', writes: true, defaultKey: null },
  { id: 'strikethrough', command: 'onegayi.vsidian.format.strikethrough', title: '删除线', mode: 'live', writes: true, defaultKey: null },
  { id: 'inlineCode', command: 'onegayi.vsidian.format.inlineCode', title: '行内代码', mode: 'live', writes: true, defaultKey: null },
  { id: 'heading1', command: 'onegayi.vsidian.format.heading1', title: '一级标题', mode: 'live', writes: true, defaultKey: 'ctrl+1' },
  { id: 'heading2', command: 'onegayi.vsidian.format.heading2', title: '二级标题', mode: 'live', writes: true, defaultKey: 'ctrl+2' },
  { id: 'heading3', command: 'onegayi.vsidian.format.heading3', title: '三级标题', mode: 'live', writes: true, defaultKey: 'ctrl+3' },
  { id: 'heading4', command: 'onegayi.vsidian.format.heading4', title: '四级标题', mode: 'live', writes: true, defaultKey: 'ctrl+4' },
  { id: 'heading5', command: 'onegayi.vsidian.format.heading5', title: '五级标题', mode: 'live', writes: true, defaultKey: 'ctrl+5' },
  { id: 'heading6', command: 'onegayi.vsidian.format.heading6', title: '六级标题', mode: 'live', writes: true, defaultKey: 'ctrl+6' },
  { id: 'headingNone', command: 'onegayi.vsidian.format.headingNone', title: '取消标题', mode: 'live', writes: true, defaultKey: 'ctrl+0' },
  { id: 'bulletList', command: 'onegayi.vsidian.format.bulletList', title: '无序列表', mode: 'live', writes: true, defaultKey: null },
  { id: 'orderedList', command: 'onegayi.vsidian.format.orderedList', title: '有序列表', mode: 'live', writes: true, defaultKey: null },
  { id: 'taskList', command: 'onegayi.vsidian.format.taskList', title: '任务列表', mode: 'live', writes: true, defaultKey: null },
  { id: 'quote', command: 'onegayi.vsidian.format.quote', title: '引用', mode: 'live', writes: true, defaultKey: null },
  { id: 'codeBlock', command: 'onegayi.vsidian.format.codeBlock', title: '代码块', mode: 'live', writes: true, defaultKey: null },
  { id: 'link', command: 'onegayi.vsidian.format.link', title: '链接', mode: 'live', writes: true, defaultKey: null },
  { id: 'clearInline', command: 'onegayi.vsidian.format.clearInline', title: '清除行内格式', mode: 'live', writes: true, defaultKey: null },
  { id: 'inlineMath', command: 'onegayi.vsidian.insert.inlineMath', title: '插入行内公式', mode: 'live', writes: true, defaultKey: null },
  { id: 'blockMath', command: 'onegayi.vsidian.insert.blockMath', title: '插入块级公式', mode: 'live', writes: true, defaultKey: null },
  { id: 'wikilink', command: 'onegayi.vsidian.insert.wikilink', title: '插入双链', mode: 'live', writes: true, defaultKey: null },
] as const

export type FormatOperationId = (typeof FORMAT_OPERATIONS)[number]['id']

export function isFormatOperationId(value: unknown): value is FormatOperationId {
  return typeof value === 'string' && FORMAT_OPERATIONS.some((item) => item.id === value)
}
