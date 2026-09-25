# 公式渲染性能实测（工单 #59）

> 测量日期：2026-09-25。测量通道：Playwright headless Chromium（生产控制器
> 装配，`test/browser/tableCaretFixture.ts` 的 bundle），不占真宿主集成车道；
> 真宿主（VSCode 1.86.2 webview）的对应数据由 `test/perf` 套件在合并阶段
> 补测（挂点见文末「宿主车道待补项」）。

## 架构性能设计（先讲机制，数据再验证）

- **渲染缓存**：KaTeX `renderToString` 结果按 `tex + displayMode` 做 LRU 缓存
  （上限 512），**live 与阅读两条渲染通道共用同一缓存实例**（共享模块
  `src/webview/mathRenderCache.ts`，#59 评审 C2 修正：此前两通道各自直调
  `renderToString`，本文档曾以「各自通道但键同构」描述与实现不符的缓存，
  现已抽离为真实共享）；widget 装饰实例同样按参数缓存（`RangeSet.eq` 成立
  的前提）。同一公式的失败解析也只发生一次。
- **按视口物化**：live 侧行内公式装饰由 ViewPlugin 按 `visibleRanges` 重建，
  屏外公式无装饰、无 widget DOM；跨行块装饰虽在 StateField 全量映射（CM6
  约束：跨行 replace 必须走 field），但 widget 的 `toDOM` 只在进入视口时由
  CM6 调用——屏外块只有数据无 DOM。阅读侧沿用块级按需挂载（`$$` 块独立成
  块，挂载即渲染、卸载即释放）。
- **块表增量**：跨行 `$$` 块表（`mathBlocksField`）create 全量扫描、
  docChanged 增量重建（种子 = 变更区间 ∪ 相交旧块，向上回溯 512 行），纯
  选区移动零成本。行内扫描限视口行。
- **降级零放大**：解析失败的公式渲染为原文 span（无 KaTeX 调用），成本与
  普通文本等同。

## 实测数据（240 块公式密集样例）

样例：`generateMathDenseSample(240)`（`test/perf/gen-sample.mjs`）——行内
公式、跨行 `$$` 块、段内 `$$`、普通段落按 1:1:1:1 交替，约 13.4 KB / 960
行 / 约 480 个公式出现。**mathDense 档位的挂点已建（样例生成器 +
`test/browser` 车道），宿主车道数据待跑**——下表数字全部来自浏览器车道
（Playwright headless Chromium），真宿主数值随合并阶段的 `test/perf`
档位补测后回填。

| 指标 | 数值 | 判读 |
| --- | --- | --- |
| 普通行真实击键延迟（40 键） | avg 0.35 ms / max 1.10 ms | 含块表增量与装饰重建，远低于感知阈值 |
| 选区移动事务（公式行间往返 ×1000） | 0.49 ms/事务 | ViewPlugin 装饰重建 + 块表零成本路径 |
| live 滚动全程往返，视口内公式 DOM 上限 | 42（全文约 480 个） | 窗口有界，屏外不物化 |
| 阅读滚动全程往返，窗口内 KaTeX 上限 | 57 | 块级挂载/回收正常 |
| 初始装载（960 行全文切块 + 首屏渲染） | 约 0.5 s 内稳定（rAF 双帧） | 阅读切块含 KaTeX 渲染 |

对照 MVP 性能契约（docs/specs/mvp.md「MVP 性能契约」）：公式密集文档的
击键延迟与普通文档同量级（毫秒级），滚动回收保持窗口有界——契约面满足。

## 体积成本

- `main.js`（生产 minify）：545,586 B → 829,024 B（+283 KB，KaTeX 官方
  min 产物直传 + markdown-it-katex 插件）。
- `main.css`：18,571 B → 41,308 B（+23 KB，KaTeX 样式 + 适配规则）。
- 字体：`out/webview/assets/KaTeX_*.woff2` × 20 共约 254 KB（仅 woff2，
  构建期裁掉 woff/ttf 回退引用——chrome118 目标足够）。
- VSIX 总量：约 0.75 MB → 约 1.32 MB（`npm run release:check` 实测），低于
  1.5 MB 总量警告线；main.js 超 700 KB 单文件警告线（未超 1 MB 上限），
  发布检查按「预期警告」放行（见 test/release/release.test.mjs 对应用例）。

## 宿主车道待补项（合并阶段）

- `test/perf/runPerf.mjs` 增加 `perf-math.md` 档位（复用
  `generateMathDenseSample`）与 `test/perf/suite.ts` 的对应测量用例（打开 →
  `perf.probe` / `reading.perf` 探针 → 报告落 `docs/perf/data/`）。
- 真宿主输入延迟与滚动回收与浏览器车道对拍（关注 webview 内联样式注入对
  KaTeX 层级渲染的影响，`cssProbe.liveMathFontFamily` 为观测位）。

## 已知差异与限制（如实记录）

- markdown-it 的段内文本允许跨行 `$…$`（软换行），live 行扫描以行为单位
  不识别——live 显源码、阅读渲染公式，降级方向安全（源文不丢）。该差异
  已由对拍钉子测试固定（readingMath.test.ts「段落内跨行 $…$」用例），
  语义变更时须同步本清单。行内 `` $`1+1`$ `` 的反引号剥离此前两视图
  不一致（live 保留反引号进渲染输入），现已统一经 `stripInlineTexTicks`
  剥离（#59 评审 C5）。
- 块中段混入围栏代码的形态：live 抑制渲染（显源码），markdown-it 按自身
  规则可能渲染——同为降级方向差异。
- 超过 512 行的跨行块，远端击键后的增量重建可能暂时漏配对（live 显源码），
  文档装载/resync 的全量扫描恢复。未闭合 `$$` 的向下延伸扫描按增量续扫
  （每批 256 行只扫新行段，不再从零重扫——此前的平方级长尾成本已消除，
  #59 评审 C3），并在延伸 4096 行（`MATH_BLOCK_EXTEND_LIMIT`）后熔断：
  闭合点在更远处的超长块增量窗口漏配对、live 显源码，全量扫描恢复。
- 空内容的行首闭合形态（`$$  $$` / `$$$$`）：插件按单行空块渲染，
  live 扫描按原文降级（不产出）——保守方向的视图差异（#59 评审 B-4
  统一后的语义：该形态不开启多行块，块开启判定 `opensMathBlockLine`
  为 scanMathRanges 与增量重建共用的单一事实源）。
- 单条超长公式（如数万字符的 tex）无渲染耗时熔断（#59 评审 C11 记录性）：
  KaTeX 解析成本与公式长度正相关，极端长公式进入视口时的一次性渲染耗时
  不设上限；缓存命中后不重算，影响限于首次渲染。
- KaTeX 的 `\begin{align}` 等环境在行内公式中强制 displayMode（与
  @vscode/markdown-it-katex 行为一致）。
