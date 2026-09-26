// i18n 防回潮扫描白名单（#93 生成；由 i18nNoHardcodedCjk.test.ts 契约钉住）。
// 文件（仓库相对路径）→ 允许在案的 CJK 字面量（集合语义）。
// 迁移工单（#94–#97）迁移一处删一条；条目失效时契约测试报错，须同步清除。
// 再生：VSIDIAN_I18N_DUMP_WHITELIST=1 npx vitest run test/unit/i18nNoHardcodedCjk.test.ts
// 在案说明（防回潮「清零」终态=仅剩永久合法类别，见规格「防回潮纪律」）：
// settings.ts「简体中文」为语言自名直显（#96，规格「语言设置项」，不自译）；
// perfProbe「探」为探针徽标标识；tableEditing 3 条为开发面诊断 reason 经
// helper 间接传递（console 参数豁免口径之外的开发面残留）。
export const CJK_LITERALS_WHITELIST: Readonly<Record<string, readonly string[]>> = {
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
