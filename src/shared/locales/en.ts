// 英文语言包（#93 i18n 基础设施）——字典单一事实源的【类型基准】：
// `MessageKey = keyof typeof en`，zh-cn.ts 以 `Record<MessageKey, string>`
// 约束（缺键/多键即 tsc 编译失败，编译期 parity）。
//
// 翻译约定（规格「翻译流程与术语」）：术语以 docs/specs/i18n.md 附录术语表
// 为唯一术语源；按钮与动作用祈使动词，标题与标签名词短语，描述为完整句、
// 句尾句号，sentence case。本票只入基础设施所需词条，存量文案随 #94/#95
// 迁移工单逐面补齐（键前缀分组见规格「字典架构」表）。
export const en = {
  /** 设置页面板标题（宿主 createWebviewPanel 标题与页面 h1 同源） */
  'settings.pageTitle': 'Vsidian Settings',

  // ---- #94 编辑器 webview 呈现面 ----

  /** 跨面通用：快捷键提示前缀与多键位连接符（zh 顿号、en 逗号） */
  'common.keybindingHint': 'Keybinding: {keys}',
  'common.keySeparator': ', ',

  /** 快捷操作工具条 21 条操作标题（兼作命令 title 的 NLS 生成源，#97 映射） */
  'format.bold': 'Bold',
  'format.italic': 'Italic',
  'format.strikethrough': 'Strikethrough',
  'format.inlineCode': 'Inline code',
  'format.heading1': 'Heading 1',
  'format.heading2': 'Heading 2',
  'format.heading3': 'Heading 3',
  'format.heading4': 'Heading 4',
  'format.heading5': 'Heading 5',
  'format.heading6': 'Heading 6',
  'format.headingNone': 'Remove heading',
  'format.bulletList': 'Bullet list',
  'format.orderedList': 'Numbered list',
  'format.taskList': 'Task list',
  'format.quote': 'Quote',
  'format.codeBlock': 'Code block',
  'format.link': 'Link',
  'format.clearInline': 'Clear inline formatting',
  'format.inlineMath': 'Insert inline math',
  'format.blockMath': 'Insert block math',
  'format.wikilink': 'Insert wikilink',

  /** 快捷操作工具条框架（分组、标题菜单；非命令标题，不进 #97 映射） */
  'format.toolbarAria': 'Formatting quick actions',
  'format.groupText': 'Text',
  'format.groupParagraph': 'Paragraph',
  'format.groupInsert': 'Insert',
  'format.heading': 'Heading',
  'format.headingMenu': 'Heading level',
  /** 标题菜单里「无标题」档的文字图标（与 H1–H6 同宽槽位，取正文术语缩写） */
  'format.bodyText': 'Body',
  'format.insertTable': 'Insert table',

  /** 右侧栏（顶栏按钮与侧栏切换） */
  'sidebar.settings': 'Open Vsidian settings',
  'sidebar.quickActions': 'Quick actions',
  'sidebar.collapse': 'Collapse sidebar',
  'sidebar.expand': 'Expand sidebar',

  /** 查找控件 */
  'find.placeholder': 'Find',
  'find.label': 'Find in document',
  'find.caseToggle': 'Ignore case',
  'find.prev': 'Previous match',
  'find.next': 'Next match',
  'find.close': 'Close find',

  /** 外部修改冲突横幅 */
  'conflict.bannerText':
    'An external change was detected that cannot be synced safely: writing back is paused, and your local input is kept and will not be overwritten.',
  'conflict.copyUnconfirmed': 'Copy unconfirmed input',
  'conflict.resume': 'Discard local changes and resync',

  /** 大纲面板（标题、空态、折叠滑块、搜索工具条） */
  'outline.label': 'Outline',
  'outline.empty': 'No headings',
  'outline.chevron': 'Collapse or expand',
  'outline.searchPlaceholder': 'Input to search',
  'outline.searchLabel': 'Search headings',
  'outline.jumpBottom': 'Jump to end of note',
  'outline.reset': 'Reset',
  'outline.noMatch': 'No match',
  'outline.expandLevels': 'Outline expand level',
  'outline.collapseAll': 'Collapse all',
  'outline.expandLevel1': 'Expand to level 1',
  'outline.expandLevel2': 'Expand to level 2',
  'outline.expandLevel3': 'Expand to level 3',
  'outline.expandLevel4': 'Expand to level 4',
  'outline.expandLevel5': 'Expand to level 5',
  'outline.renameHeading': 'Rename heading',

  /** 大纲右键菜单 */
  'outlineMenu.expandRecursively': 'Expand recursively',
  'outlineMenu.collapseSiblings': 'Collapse siblings',
  'outlineMenu.expandSiblings': 'Expand siblings',
  'outlineMenu.copy': 'Copy',
  'outlineMenu.copyHeading': 'Heading',
  'outlineMenu.copySiblings': 'Heading and sibling headings',
  'outlineMenu.copyChildren': 'Heading and child headings',
  'outlineMenu.copyLink': 'Heading link',
  'outlineMenu.copySection': 'Section content',
  'outlineMenu.adjustLevel': 'Adjust level',
  'outlineMenu.levelUp': 'Increase by one level',
  'outlineMenu.levelUpRecursive': 'Increase by one level recursively',
  'outlineMenu.levelDown': 'Decrease by one level',
  'outlineMenu.levelDownRecursive': 'Decrease by one level recursively',
  'outlineMenu.rename': 'Rename',
  'outlineMenu.delete': 'Delete',

  /** 表格可见行控件 */
  'table.controls': 'Table controls',
  'table.insertColumnRight': 'Add column on the right',
  'table.insertRowBelow': 'Add row at the bottom',
  'table.selectRow': 'Select or drag row {n}',
  'table.selectColumn': 'Select or drag column {n}',

  /** 代码块卡片 */
  'codeblock.copy': 'Copy code',
  'codeblock.expand': 'Expand code block',
  'codeblock.collapse': 'Collapse code block',

  /** 图片/公式/任务/Mermaid 装饰与错误占位 */
  'decor.taskCheck': 'Check task',
  'decor.taskUncheck': 'Uncheck task',
  'decor.emptyCell': 'Empty cell',
  'decor.mathError': 'Math failed to parse: source text is shown; move the cursor in to edit',
  'decor.imageError': 'Image failed to load ({reason}). Click to retry',
  'decor.unknownReason': 'unknown reason',
  'decor.mermaidUnavailable': 'Diagram renderer unavailable (mermaid.js failed to load)',
  'decor.mermaidError': 'Diagram failed to render: {message}',
} as const satisfies Record<string, string>

/** 字典键：点分扁平键，以本包为类型基准（编译期检查 t() 取词键） */
export type MessageKey = keyof typeof en
