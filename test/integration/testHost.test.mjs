import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { buildTestHostArgs, resolveTestHostMode, runTestHost } from './testHost.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

// 探针及其子进程最长 4.5 秒后自行退出；失败的 RED 阶段也不会留下长驻进程。
const childProbeScript = 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => process.exit(0), 4500)'
const probeScript = [
  'const fs = require("node:fs")',
  'const { spawn } = require("node:child_process")',
  'fs.writeFileSync(process.argv[1], String(process.pid))',
  `spawn(process.execPath, ["-e", ${JSON.stringify(childProbeScript)}, process.argv[2]], { stdio: "ignore" })`,
  'setTimeout(() => process.exit(0), 4500)',
].join('; ')

function running(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function waitUntil(check, timeoutMs = 3000) {
  const until = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > until) throw new Error('探针进程未在限时内启动')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function stopProbePids(files) {
  for (const file of files) {
    if (!existsSync(file)) continue
    const pid = Number(readFileSync(file, 'utf8'))
    if (running(pid)) process.kill(pid)
  }
}

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

test('Windows 独立桌面超时后结束本次宿主及其子进程', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vsidian-host-timeout-'))
  const markers = [path.join(dir, 'host.pid'), path.join(dir, 'child.pid')]
  const unrelated = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 4500)'], { stdio: 'ignore' })
  try {
    let diagnostics = ''
    const started = Date.now()
    const code = await runTestHost({
      executable: process.execPath,
      args: ['-e', probeScript, ...markers],
      env: process.env,
      mode: 'desktop',
      timeoutMs: 1200,
      stdout: { write: () => {} },
      stderr: { write: (chunk) => { diagnostics += chunk.toString() } },
    })
    assert.equal(code, 124)
    assert.match(diagnostics, /超过 1200 ms/)
    assert.ok(Date.now() - started < 3000, '超时应尽快结束')
    await waitUntil(() => markers.every(existsSync), 500)
    await new Promise((resolve) => setTimeout(resolve, 300))
    for (const marker of markers) assert.equal(running(Number(readFileSync(marker, 'utf8'))), false)
    assert.equal(running(unrelated.pid), true, '不应影响本次 Job 之外的进程')
  } finally {
    if (running(unrelated.pid)) unrelated.kill()
    stopProbePids(markers)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Windows 父启动器被终止后不遗留独立桌面宿主及其子进程', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vsidian-host-parent-'))
  const markers = [path.join(dir, 'host.pid'), path.join(dir, 'child.pid')]
  const moduleUrl = pathToFileURL(path.join(here, 'testHost.mjs')).href
  const runnerSource = `import { runTestHost } from ${JSON.stringify(moduleUrl)}; await runTestHost({ executable: process.execPath, args: ${JSON.stringify(['-e', probeScript, ...markers])}, env: process.env, mode: 'desktop' })`
  const runner = spawn(process.execPath, ['--input-type=module', '-e', runnerSource], { stdio: 'ignore' })
  try {
    await waitUntil(() => markers.every(existsSync))
    runner.kill()
    await new Promise((resolve) => runner.once('close', resolve))
    await new Promise((resolve) => setTimeout(resolve, 700))
    for (const marker of markers) assert.equal(running(Number(readFileSync(marker, 'utf8'))), false)
  } finally {
    if (running(runner.pid)) runner.kill()
    stopProbePids(markers)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Windows PowerShell 在 CreateProcess 后被强制终止时清理本次进程树', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vsidian-host-wrapper-'))
  const markers = [path.join(dir, 'host.pid'), path.join(dir, 'child.pid')]
  const crashWrapperScript = `${probeScript}; setTimeout(() => process.kill(process.ppid), 350)`
  try {
    const started = Date.now()
    const code = await runTestHost({
      executable: process.execPath,
      args: ['-e', crashWrapperScript, ...markers],
      env: process.env,
      mode: 'desktop',
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    })
    assert.notEqual(code, 0)
    assert.ok(Date.now() - started < 2500, 'PowerShell 退出应立即结束宿主进程树')
    await waitUntil(() => markers.every(existsSync), 500)
    await new Promise((resolve) => setTimeout(resolve, 700))
    for (const marker of markers) assert.equal(running(Number(readFileSync(marker, 'utf8'))), false)
  } finally {
    stopProbePids(markers)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Windows PowerShell 在 CreateProcess 后抛错时清理本次进程树', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vsidian-host-error-'))
  const markers = [path.join(dir, 'host.pid'), path.join(dir, 'child.pid')]
  try {
    let diagnostics = ''
    const started = Date.now()
    const code = await runTestHost({
      executable: process.execPath,
      args: ['-e', probeScript, ...markers],
      env: { ...process.env, VSIDIAN_TEST_HOST_FAULT_MARKER: markers[1] },
      mode: 'desktop',
      stdout: { write: () => {} },
      stderr: { write: (chunk) => { diagnostics += chunk.toString() } },
    })
    assert.equal(code, 1)
    assert.match(diagnostics, /fault after CreateProcess/)
    assert.ok(Date.now() - started < 3000)
    await waitUntil(() => markers.every(existsSync), 500)
    await new Promise((resolve) => setTimeout(resolve, 300))
    for (const marker of markers) assert.equal(running(Number(readFileSync(marker, 'utf8'))), false)
  } finally {
    stopProbePids(markers)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Windows 启动器收到 SIGINT 后返回中断码并清理进程树', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vsidian-host-sigint-'))
  const markers = [path.join(dir, 'host.pid'), path.join(dir, 'child.pid')]
  const resultFile = path.join(dir, 'result.txt')
  const moduleUrl = pathToFileURL(path.join(here, 'testHost.mjs')).href
  const runnerSource = [
    `import { runTestHost } from ${JSON.stringify(moduleUrl)}`,
    'import { existsSync, writeFileSync } from "node:fs"',
    `const pulse = setInterval(() => { if (existsSync(${JSON.stringify(markers[1])})) { clearInterval(pulse); process.emit('SIGINT') } }, 50)`,
    `const code = await runTestHost({ executable: process.execPath, args: ${JSON.stringify(['-e', probeScript, ...markers])}, env: process.env, mode: 'desktop' })`,
    `writeFileSync(${JSON.stringify(resultFile)}, String(code))`,
  ].join('; ')
  try {
    const runner = spawn(process.execPath, ['--input-type=module', '-e', runnerSource], { stdio: 'ignore' })
    await new Promise((resolve) => runner.once('close', resolve))
    assert.equal(readFileSync(resultFile, 'utf8'), '130')
    for (const marker of markers) assert.equal(running(Number(readFileSync(marker, 'utf8'))), false)
  } finally {
    stopProbePids(markers)
    rmSync(dir, { recursive: true, force: true })
  }
})
