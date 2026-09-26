import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { buildTestHostArgs, cleanupTestDirs, createPortableShardHost, resolveTestHostMode, runTestHost } from './testHost.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

// 用户显式选择前台模式（如 SSH / 服务会话等无交互桌面的 Windows 环境，
// CreateDesktop 无法工作）时跳过独立桌面专项——与集成启动器的模式开关
// （VSIDIAN_TEST_HOST_MODE）同一语义，保证 npm run test:unit 有逃生门。
const skipDesktop = process.platform !== 'win32' || process.env.VSIDIAN_TEST_HOST_MODE === 'foreground'

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

test('开发态、安装态与空窗口激活启动器都接入共用宿主启动器', () => {
  for (const launcher of ['runTest.mjs', 'runInstalled.mjs', 'runSettingsActivation.mjs']) {
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

test('并行宿主共用程序但使用各自的便携数据目录与环境变量', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vsidian-portable-shards-'))
  const inherited = { VSCODE_PORTABLE: 'inherited', MARKER: 'kept' }
  try {
    const first = createPortableShardHost(dir, 1, inherited)
    const second = createPortableShardHost(dir, 2, inherited)
    assert.notEqual(first.portableDir, second.portableDir)
    for (const shard of [first, second]) {
      assert.equal(existsSync(shard.portableDir), true, 'VSCode 启动前必须预建便携目录')
      assert.equal(shard.userDataDir, path.join(shard.portableDir, 'user-data'))
      assert.equal(shard.extensionsDir, path.join(shard.portableDir, 'extensions'))
      assert.equal(shard.env.VSCODE_PORTABLE, shard.portableDir)
      assert.equal(shard.env.MARKER, 'kept')
    }
    assert.equal(inherited.VSCODE_PORTABLE, 'inherited', '不得修改父进程环境')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('临时目录清理遇到占用仍继续清理其余目录，并拒绝越界目标', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'vsidian-cleanup-'))
  const locked = path.join(parent, 'locked')
  const removable = path.join(parent, 'removable')
  mkdirSync(locked)
  mkdirSync(removable)
  const removed = []
  try {
    const failures = cleanupTestDirs([locked, removable, path.join(parent, '..', 'outside')], parent, (dir, options) => {
      removed.push(dir)
      if (dir === locked) throw new Error('locked')
      rmSync(dir, options)
    })
    assert.deepEqual(removed, [locked, removable])
    assert.equal(existsSync(removable), false)
    assert.equal(failures.length, 2)
    assert.match(failures[0], /locked/)
    assert.match(failures[1], /outside/)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
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

test('宿主运行按 reportPath 落盘完整报告：逐例输出与尾部退出码', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vsidian-host-report-'))
  // 嵌套路径：报告目录不存在时应自动创建（真实启动器把报告放进 .vscode-test/）
  const reportPath = path.join(dir, 'nested', 'integration-dev.log')
  try {
    const code = await runTestHost({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("report probe out\\n"); process.stderr.write("report probe err\\n"); process.exit(9)'],
      env: process.env,
      mode: 'foreground',
      reportPath,
    })
    assert.equal(code, 9)
    const report = readFileSync(reportPath, 'utf8')
    assert.match(report, /report probe out/, '报告应包含子进程 stdout')
    assert.match(report, /report probe err/, '报告应包含子进程 stderr')
    assert.match(report, /\[testHost\] 宿主退出码 9/, '报告尾部应有退出码摘要行')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('超时终止的运行同样落盘报告并记录超时退出码', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vsidian-host-report-timeout-'))
  const reportPath = path.join(dir, 'integration-timeout.log')
  try {
    const code = await runTestHost({
      executable: process.execPath,
      args: ['-e', 'setTimeout(() => process.exit(0), 8000)'],
      env: process.env,
      mode: 'foreground',
      timeoutMs: 600,
      reportPath,
    })
    assert.equal(code, 124)
    assert.match(readFileSync(reportPath, 'utf8'), /\[testHost\] 宿主退出码 124/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('开发态分片各有报告，单片及另外两种启动器保留原报告名', () => {
  const expected = {
    'runInstalled.mjs': 'integration-installed.log',
    'runSettingsActivation.mjs': 'settings-activation.log',
  }
  const dev = readFileSync(path.join(here, 'runTest.mjs'), 'utf8')
  assert.match(dev, /integration-dev-s\$\{shard\}\.log/)
  assert.match(dev, /'integration-dev\.log'/)
  for (const [launcher, reportName] of Object.entries(expected)) {
    const source = readFileSync(path.join(here, launcher), 'utf8')
    assert.match(
      source,
      new RegExp(`reportPath:\\s*path\\.join\\(root,\\s*'\\.vscode-test',\\s*'${reportName}'\\)`),
      `${launcher} 应把报告指到 .vscode-test/${reportName}`,
    )
  }
})

test('Windows 独立桌面启动器原样传递真实进程输出和非零退出码', { skip: skipDesktop }, async () => {
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

test('Windows 独立桌面超时后结束本次宿主及其子进程', { skip: skipDesktop }, async () => {
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

test('Windows 父启动器被终止后不遗留独立桌面宿主及其子进程', { skip: skipDesktop }, async () => {
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

test('Windows PowerShell 在 CreateProcess 后被强制终止时清理本次进程树', { skip: skipDesktop }, async () => {
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

test('Windows PowerShell 在 CreateProcess 后抛错时清理本次进程树', { skip: skipDesktop }, async () => {
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

test('Windows 启动器收到 SIGINT 后返回中断码并清理进程树', { skip: skipDesktop }, async () => {
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
