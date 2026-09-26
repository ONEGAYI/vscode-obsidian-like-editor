// Mermaid 独立产物入口（工单 #60）：产出 out/webview/mermaid.js（esbuild
// browser/iife/chrome118），宿主在 webview HTML 注入其资源 URI、webview
// 存在 mermaid 围栏时按需 <script> 加载——mermaid 不进主 bundle（约 2.7MB
// 会让每个 webview 启动都付出解析成本）。
//
// 为什么需要本入口而不是直接打包官方 UMD（dist/mermaid.min.js）：UMD 尾部
// 以 `globalThis.__esbuild_esm_mermaid_nm.mermaid.default` 完成全局自赋值，
// 该内部命名空间在独立脚本里是全局 var、被 esbuild 模块包裹后变成模块
// 作用域局部变量——globalThis 引用落空抛 TypeError，全局永远挂不上。经
// ESM 源（dist/mermaid.core.mjs）打包并由本入口显式挂全局即可，且 minify
// 后体积与官方预压缩产物相当（实测 2.72MB vs 2.75MB）。
import mermaid from 'mermaid'

;(globalThis as { mermaid?: unknown }).mermaid = mermaid
