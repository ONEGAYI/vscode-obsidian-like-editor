// i18n 防回潮扫描白名单（#93 生成；由 i18nNoHardcodedCjk.test.ts 契约钉住）。
// 文件（仓库相对路径）→ 允许在案的 CJK 字面量（集合语义）。
// 迁移工单（#94–#97）迁移一处删一条；条目失效时契约测试报错，须同步清除。
// 再生：VSIDIAN_I18N_DUMP_WHITELIST=1 npx vitest run test/unit/i18nNoHardcodedCjk.test.ts
// 在案说明：keybindings.ts 的 22 条为 extra/UI 源操作名存量（format 源已随
// #94 键化）；settings.ts「简体中文」为语言自名直显（#96，规格「语言设置项」）；
// perfProbe「探」与 tableEditing 3 条（console 诊断 reason）为开发面残留，
// 票面未列、待后续处理。
export const CJK_LITERALS_WHITELIST: Readonly<Record<string, readonly string[]>> = {
  'src/shared/keybindings.ts': [
    "上一个查找结果",
    "下一个查找结果",
    "切换到实时预览",
    "切换到源码编辑器",
    "切换到阅读模式",
    "切换视图模式",
    "创建表格",
    "展开全部大纲",
    "展开或收起右侧栏",
    "打开设置",
    "折叠全部大纲",
    "搜索大纲标题",
    "显示或隐藏大纲",
    "查找",
    "表格：上方插入行",
    "表格：下方插入行",
    "表格：删除列",
    "表格：删除行",
    "表格：右侧插入列",
    "表格：左侧插入列",
    "跳转到笔记末尾",
    "重置大纲",
  ],
  // #96 语言设置项残留：语言自名不自译（规格「语言设置项」）——静态直显的
  // 「简体中文」是刻意的字面量，不随界面语言翻译；title/description 字面量
  // 已随 #95 键化（setting.language.*）消灭，不入白名单
  'src/shared/settings.ts': [
    "简体中文",
  ],
  'src/webview/perfProbe.ts': [
    "探",
  ],
  'src/webview/tableEditing.ts': [
    "多段变更",
    "结构无法保持",
    "选区无可见表格内容交集",
  ],
}
