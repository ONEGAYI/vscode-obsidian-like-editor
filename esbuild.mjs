// 双产物构建脚本：
// - extension host 端：src/extension.ts -> out/extension.js（node18 / cjs / external vscode）
// - webview 端：src/webview/main.ts -> out/webview/main.js（chrome118 / iife，css 随 import 打包为同名 .css）
// - 设置页 webview 端（#33）：src/webview/settingsMain.ts -> out/webview/settings.js（同 browser/iife 形态）
// - Mermaid 独立产物（#60）：src/webview/mermaidEntry.ts -> out/webview/mermaid.js
//   （同 browser/iife 形态）。mermaid 不进主 bundle（约 2.7MB 会让每个 webview
//   启动都付出解析成本），宿主在 webview HTML 注入资源 URI、webview 存在
//   mermaid 围栏时按需 <script> 加载。
// - 集成测试入口（仅开发构建）：test/integration/suite/index.ts -> out/test/integration/suite/index.js
// 类型检查由 `tsc --noEmit`（npm run typecheck / compile）负责，esbuild 只做转译打包。
//
// #59 KaTeX 字体裁剪：webview 构建经 katexFontPlugin 在加载 katex.min.css 时
// 移除 woff/ttf 回退条目（chrome118 目标只需 woff2），并以 assetNames 固定
// 产物名为 out/webview/assets/<原名>（无 hash，供发布检查的必需清单逐文件登记）。
import * as esbuild from 'esbuild'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const production = process.argv.includes('--production')
const watch = process.argv.includes('--watch')

/** 裁剪 katex.min.css 的 woff/ttf src 条目（保留首个 woff2 源）：
 *  esbuild 按引用复制资产，去掉引用后 woff/ttf 不再进产物（体积约省一半） */
const katexFontPlugin = {
  name: 'katex-font-fallback-strip',
  setup(build) {
    build.onLoad({ filter: /katex[\\/]dist[\\/]katex\.min\.css$/ }, async (args) => ({
      contents: (await readFile(args.path, 'utf8')).replace(
        /,\s*url\([^)]+\.(?:woff|ttf)\)\s*format\((["']?)(?:woff|truetype)\1\)/g,
        '',
      ),
      loader: 'css',
    }))
  },
}

/** 裸导入 `katex` 重定向到官方预压缩 UMD（#59）：从 ESM 源打包经 esbuild
 *  压缩约 800KB，直用 dist/katex.min.js（约 272KB）省 500KB+；tsc 的类型
 *  解析不受影响（仍读 katex 包自带类型）。子路径导入（katex/dist/*.css）
 *  不匹配，走原解析。 */
const katexMinJsPlugin = {
  name: 'katex-min-js',
  setup(build) {
    build.onResolve({ filter: /^katex$/ }, () => ({
      path: path.resolve('node_modules/katex/dist/katex.min.js'),
    }))
  },
}

/** webview 产物共用配置（browser/iife/chrome118 + KaTeX 字体装载） */
const webviewBase = {
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome118',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  loader: { '.woff2': 'file' },
  assetNames: 'assets/[name]',
  plugins: [katexFontPlugin, katexMinJsPlugin],
}

/** @type {Array<import('esbuild').BuildOptions>} */
const targets = [
  {
    entryPoints: ['src/extension.ts'],
    outfile: 'out/extension.js',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
    sourcemap: !production,
    minify: production,
    logLevel: 'info',
  },
  {
    entryPoints: ['src/webview/main.ts'],
    outfile: 'out/webview/main.js',
    ...webviewBase,
  },
  {
    // 设置页 webview 产物（#33）：独立入口，样式经 import 产出 settings.css
    entryPoints: ['src/webview/settingsMain.ts'],
    outfile: 'out/webview/settings.js',
    ...webviewBase,
  },
  {
    // Mermaid 独立产物（#60）：经 ESM 源打包（官方 UMD 的模块作用域下
    // 全局自赋值会落空抛错，见 mermaidEntry.ts 头注释），入口显式挂
    // globalThis.mermaid；minify 后 2,724,795 B，与官方预压缩产物相当
    entryPoints: ['src/webview/mermaidEntry.ts'],
    outfile: 'out/webview/mermaid.js',
    ...webviewBase,
  },
]

if (!production) {
  targets.push({
    entryPoints: ['test/integration/suite/index.ts'],
    outfile: 'out/test/integration/suite/index.js',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
    sourcemap: true,
    logLevel: 'info',
  })
  targets.push({
    // 性能测量套件（#5）：由 test/perf/runPerf.mjs 以 extensionTestsPath 启动
    entryPoints: ['test/perf/suite.ts'],
    outfile: 'out/test/perf/suite.js',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
    sourcemap: true,
    logLevel: 'info',
  })
  targets.push({
    // 空窗口命令激活实测套件（#33）：由 test/integration/runSettingsActivation.mjs
    // 以空启动参数运行（套件内不得显式 activate 扩展）
    entryPoints: ['test/integration/settingsActivation/index.ts'],
    outfile: 'out/test/integration/settingsActivation/index.js',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
    sourcemap: true,
    logLevel: 'info',
  })
}

async function main() {
  const contexts = await Promise.all(targets.map((t) => esbuild.context(t)))
  if (watch) {
    await Promise.all(contexts.map((ctx) => ctx.watch()))
    console.log('[esbuild] watching...')
  } else {
    await Promise.all(contexts.map((ctx) => ctx.rebuild()))
    await Promise.all(contexts.map((ctx) => ctx.dispose()))
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
