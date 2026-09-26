// 浏览器测试的语言装配辅助（#95 i18n）：构建 zh-cn 字典的 ESM 产物供
// node 侧取词（断言与字典同源，不再复制字面量），并产出与生产
// shared/locales/island.ts 同语义的数据岛 HTML（`<` 转义 \u003c）——
// setContent 注入后 webview 首帧即装配语言包（bootLocaleFromDocument）。
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const output = path.join(root, 'out/test/browser/zh-cn.mjs')

/** 构建并加载 zh-cn 字典（node 侧经 ESM 产物取值，避免直接 import TS 源） */
export async function loadZhCn() {
  await build({
    stdin: {
      contents: "export { zhCn } from './src/shared/locales/zh-cn.ts'",
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    outfile: output,
  })
  return (await import(pathToFileURL(output).href)).zhCn
}

/** 生成 zh-cn 数据岛 script 元素（HTML 文本，须置于主脚本加载之前） */
export function localeIslandScript(zhCn) {
  const payload = JSON.stringify({ lang: 'zh-cn', messages: zhCn }).replaceAll('<', '\\u003c')
  return `<script type="application/json" id="vsidian-locale">${payload}</script>`
}
