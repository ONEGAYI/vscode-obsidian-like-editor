import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    // 单元测试默认 node 环境；需要 DOM 的用例在文件头用 `// @vitest-environment jsdom` 声明
    environment: 'node',
  },
})
