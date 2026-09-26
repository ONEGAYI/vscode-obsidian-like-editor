// 浏览器回归共用的语言数据岛构建（#94/#95 i18n）：编辑器/设置页文案经
// t() 取词后，页面无岛时取词回退键名、中文断言全挂。此模块经 esbuild 打包
// 生产侧 buildLocaleIslandHtml + zhCn 生成与宿主 HTML 生成点同源的岛（转义
// 规则一致），harness 注入 setContent 页面，fixture 入口 bootLocaleFromDocument
// 装配——与 webview 首帧同路径，不旁路生产机制。zhCnMessages 一并导出，供
// 断言与字典同源取值（不再复制字面量）。
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

/** 构建 zh-cn 语言数据岛 HTML；返回 { islandHtml, zhCnMessages } */
export async function buildZhLocaleIsland(root) {
  const outfile = path.join(root, 'out/test/browser/locale-island.mjs')
  // stdin 说明符须为相对路径 + resolveDir（盘符绝对路径会被当裸包名，解析失败）
  const entry = [
    `import { zhCn } from './src/shared/locales/zh-cn.ts'`,
    `import { buildLocaleIslandHtml } from './src/shared/locales/island.ts'`,
    'export const islandHtml = buildLocaleIslandHtml("zh-cn", zhCn)',
    'export const zhCnMessages = zhCn',
  ].join('\n')
  await build({ stdin: { contents: entry, loader: 'ts', resolveDir: root }, bundle: true, format: 'esm',
    outfile, platform: 'browser', logLevel: 'silent' })
  return await import(pathToFileURL(outfile).href)
}
