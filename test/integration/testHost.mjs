// 开发态与安装态共用的 VSCode 测试宿主启动策略。
// reportPath：把本次宿主运行的完整 stdout/stderr 与退出码落盘为报告文件
// （跑一次 = 留一份证据，复核与统计读文件、不重跑）；打开失败仅告警降级。
import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const hiddenDesktopScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hiddenDesktop.ps1')

function writeReportAll(fd, data) {
  // writeSync 对普通文件也可能部分写入，循环写满
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
  let offset = 0
  while (offset < buf.length) offset += writeSync(fd, buf, offset)
}

function openReport(reportPath, stderr) {
  try {
    mkdirSync(path.dirname(reportPath), { recursive: true })
    const fd = openSync(reportPath, 'w')
    writeReportAll(fd, `[testHost] 运行报告 ${new Date().toISOString()}\n`)
    return fd
  } catch (error) {
    stderr.write(`[testHost] 报告文件不可写（${reportPath}）：${error.message}；继续运行但不留报告\n`)
    return -1
  }
}

export function buildTestHostArgs({ workspaceDir, testsPath, extensionPath, extensionsDir, userDataDir, disableExtensions = false }) {
  return [
    ...(disableExtensions ? ['--disable-extensions'] : []),
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-updates',
    '--skip-welcome',
    '--skip-release-notes',
    '--no-cached-data',
    '--disable-workspace-trust',
    `--extensionTestsPath=${testsPath}`,
    `--extensionDevelopmentPath=${extensionPath}`,
    `--extensions-dir=${extensionsDir}`,
    `--user-data-dir=${userDataDir}`,
    workspaceDir,
  ]
}

export function resolveTestHostMode(platform = process.platform, env = process.env) {
  const requested = env.VSIDIAN_TEST_HOST_MODE
  if (requested && requested !== 'desktop' && requested !== 'foreground') {
    throw new Error(`VSIDIAN_TEST_HOST_MODE 只能为 desktop 或 foreground，收到 ${requested}`)
  }
  if (requested === 'desktop' && platform !== 'win32') {
    throw new Error('VSIDIAN_TEST_HOST_MODE=desktop 仅支持 Windows')
  }
  return requested ?? (platform === 'win32' ? 'desktop' : 'foreground')
}

export function runTestHost({ executable, args, env, mode = resolveTestHostMode(), timeoutMs = 15 * 60_000, stdout = process.stdout, stderr = process.stderr, reportPath }) {
  if (mode === 'desktop' && process.platform !== 'win32') {
    throw new Error('独立桌面仅支持 Windows')
  }
  if (mode !== 'desktop' && mode !== 'foreground') {
    throw new Error(`未知测试宿主模式：${mode}`)
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`测试宿主超时必须为正数：${timeoutMs}`)
  }
  const reportFd = reportPath ? openReport(reportPath, stderr) : -1
  const report = (data) => { if (reportFd >= 0) writeReportAll(reportFd, data) }
  const windowsWrapper = process.platform === 'win32'
  const command = windowsWrapper ? 'powershell.exe' : executable
  const commandArgs = windowsWrapper
    ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', hiddenDesktopScript,
      Buffer.from(JSON.stringify({ executable, args, cwd: process.cwd(), mode, parentPid: process.pid }), 'utf8').toString('base64')]
    : args
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { env, windowsHide: windowsWrapper })
    let stopCode = 0
    const stop = (code, reason) => {
      if (stopCode) return
      stopCode = code
      report(`[testHost] ${reason}，结束本次测试宿主进程树\n`)
      stderr.write(`[testHost] ${reason}，结束本次测试宿主进程树\n`)
      child.kill()
    }
    const onSigint = () => stop(130, '收到 SIGINT')
    const onSigterm = () => stop(143, '收到 SIGTERM')
    const timeout = setTimeout(() => stop(124, `超过 ${timeoutMs} ms`), timeoutMs)
    process.on('SIGINT', onSigint)
    process.on('SIGTERM', onSigterm)
    const cleanup = () => {
      clearTimeout(timeout)
      process.off('SIGINT', onSigint)
      process.off('SIGTERM', onSigterm)
    }
    child.stdout.on('data', (chunk) => { report(chunk); stdout.write(chunk) })
    child.stderr.on('data', (chunk) => { report(chunk); stderr.write(chunk) })
    child.on('error', (error) => {
      report(`[testHost] 启动失败 ${error.message}\n`)
      if (reportFd >= 0) closeSync(reportFd)
      cleanup(); reject(error)
    })
    child.on('close', (code) => {
      const finalCode = stopCode || (code ?? 1)
      report(`[testHost] 宿主退出码 ${finalCode}\n`)
      if (reportFd >= 0) closeSync(reportFd)
      cleanup(); resolve(finalCode)
    })
  })
}
