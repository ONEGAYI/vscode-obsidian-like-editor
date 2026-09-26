# 快速操作图标

`contact-sheet.png` 是栅格总览：17 列按下表顺序排列，首行为浅色主题，次行为深色主题。每格 96×96 像素，透明背景。`light/` 和 `dark/` 内的 PNG 从总览逐格原样裁切；同名 SVG 再由 VTracer 对该 PNG 描摹生成，内含真实 `<path>`，不嵌入位图。

`highlight-horizontal-rule-ai-board.png` 保留了参考既有图标生成的单张原图。`highlight-horizontal-rule-source.png` 是从原图底部两格裁切、二值化后的透明单色源图（192×96）：左格为高亮笔，右格为分割线。重建脚本按格裁切源图的 alpha，分别着浅色或深色主题色，再纳入总览及 VTracer 描摹流程；既有 15 枚仍由脚本绘制。

| 列 | 图标 key | 列 | 图标 key | 列 | 图标 key |
| --- | --- | --- | --- | --- | --- |
| 1 | `bold` | 6 | `bulletList` | 11 | `link` |
| 2 | `italic` | 7 | `orderedList` | 12 | `clearInline` |
| 3 | `strikethrough` | 8 | `taskList` | 13 | `table` |
| 4 | `inlineCode` | 9 | `quote` | 14 | `inlineMath` |
| 5 | `heading` | 10 | `codeBlock` | 15 | `blockMath` |
| 16 | `highlight` | 17 | `horizontalRule` | | |

重建命令：

```powershell
python scripts/quick-action-icons.py
```

需要 Pillow 及 PATH 中的开源 [VTracer](https://github.com/visioncortex/vtracer) CLI 0.6.5。脚本使用 `--colormode color --mode spline --hierarchical cutout --filter_speckle 1 --color_precision 8 --path_precision 3 --segment_length 4 --corner_threshold 60`，逐一校验数量、96×96 画布、透明度、安全边距、SVG `viewBox` 与真实 path。图标按 24 单位网格绘制，设计用于 18px 工具栏；浅色主题用 `#363C46`，深色主题用 `#D2DAE5`。删除线的水平线固定在网格 `y=12`。

运行时引用 `light/light-{key}.svg` 或 `dark/dark-{key}.svg`。两套文件名全局唯一，避免打包时同名覆盖。PNG 和总览仅作源素材与检查用。
