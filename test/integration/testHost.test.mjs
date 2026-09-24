import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { buildTestHostArgs, resolveTestHostMode, runTestHost } from './testHost.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

test('集成测试有两种运行路径共用的宿主启动器', () => {
  assert.equal(existsSync(path.join(here, 'testHost.mjs')), true)
  assert.equal(existsSync(path.join(here, 'hiddenDesktop.ps1')), true)
})

test('开发态与安装态都接入共用宿主启动器', () => {
  for (const launcher of ['runTest.mjs', 'runInstalled.mjs']) {
    const source = readFileSync(path.join(here, launcher), 'utf8')
    assert.match(source, /from '\.\/testHost\.mjs'/)
    assert.match(source, /buildTestHostArgs\(/)
    assert.match(source, /runTestHost\(/)
  }
})

test('开发态和安装态都用相同参数集并隔离 profile', () => {
  const base = {
    workspaceDir: 'D:\\fixture',
    testsPath: 'D:\\suite\\index.js',
    extensionsDir: 'D:\\cache\\extensions',
    userDataDir: 'D:\\cache\\user-data',
  }
  const dev = buildTestHostArgs({ ...base, extensionPath: 'D:\\repo' })
  const installed = buildTestHostArgs({ ...base, extensionPath: 'D:\\installed' })
  assert.deepEqual(
    installed,
    dev.map((arg) => arg === '--extensionDevelopmentPath=D:\\repo'
      ? '--extensionDevelopmentPath=D:\\installed'
      : arg),
  )
  assert.ok(dev.includes('--extensionTestsPath=D:\\suite\\index.js'))
  assert.ok(dev.includes('--extensions-dir=D:\\cache\\extensions'))
  assert.ok(dev.includes('--user-data-dir=D:\\cache\\user-data'))
  assert.equal(dev.at(-1), 'D:\\fixture')
  assert.ok(buildTestHostArgs({ ...base, extensionPath: 'D:\\repo', disableExtensions: true }).includes('--disable-extensions'))
})

test('Windows 默认独立桌面，仅显式指定才使用当前桌面', () => {
  assert.equal(resolveTestHostMode('win32', {}), 'desktop')
  assert.equal(resolveTestHostMode('win32', { VSIDIAN_TEST_HOST_MODE: 'foreground' }), 'foreground')
  assert.equal(resolveTestHostMode('linux', {}), 'foreground')
  assert.throws(() => resolveTestHostMode('win32', { VSIDIAN_TEST_HOST_MODE: 'wrong' }), /VSIDIAN_TEST_HOST_MODE/)
})

test('前台启动器原样传递真实进程输出和非零退出码', async () => {
  let output = ''
  const code = await runTestHost({
    executable: process.execPath,
    args: ['-e', 'process.stdout.write("launcher probe"); process.exit(17)'],
    env: process.env,
    mode: 'foreground',
    stdout: { write: (chunk) => { output += chunk.toString() } },
    stderr: { write: () => {} },
  })
  assert.equal(code, 17)
  assert.equal(output, 'launcher probe')
})

test('Windows 独立桌面启动器原样传递真实进程输出和非零退出码', { skip: process.platform !== 'win32' }, async () => {
  let output = ''
  let diagnostics = ''
  const code = await runTestHost({
    executable: process.execPath,
    args: ['-e', 'process.stdout.write("desktop probe"); process.exit(23)'],
    env: process.env,
    mode: 'desktop',
    stdout: { write: (chunk) => { output += chunk.toString() } },
    stderr: { write: (chunk) => { diagnostics += chunk.toString() } },
  })
  assert.equal(code, 23)
  assert.match(output, /desktop probe/)
  assert.match(diagnostics, /观察期间前台 PID/)
})
