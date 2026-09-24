// 双产物构建脚本：
// - extension host 端：src/extension.ts -> out/extension.js（node18 / cjs / external vscode）
// - webview 端：src/webview/main.ts -> out/webview/main.js（chrome118 / iife，css 随 import 打包为同名 .css）
// - 设置页 webview 端（#33）：src/webview/settingsMain.ts -> out/webview/settings.js（同 browser/iife 形态）
// - 集成测试入口（仅开发构建）：test/integration/suite/index.ts -> out/test/integration/suite/index.js
// 类型检查由 `tsc --noEmit`（npm run typecheck / compile）负责，esbuild 只做转译打包。
import * as esbuild from 'esbuild'

const production = process.argv.includes('--production')
const watch = process.argv.includes('--watch')

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
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome118',
    sourcemap: !production,
    minify: production,
    logLevel: 'info',
  },
  {
    // 设置页 webview 产物（#33）：独立入口，样式经 import 产出 settings.css
    entryPoints: ['src/webview/settingsMain.ts'],
    outfile: 'out/webview/settings.js',
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome118',
    sourcemap: !production,
    minify: production,
    logLevel: 'info',
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
