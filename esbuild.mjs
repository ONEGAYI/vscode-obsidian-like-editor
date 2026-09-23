// 双产物构建脚本：
// - extension host 端：src/extension.ts -> out/extension.js（node18 / cjs / external vscode）
// - webview 端：src/webview/main.ts -> out/webview/main.js（chrome118 / iife，css 随 import 打包为同名 .css）
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
