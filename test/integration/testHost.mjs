// 开发态与安装态共用的 VSCode 测试宿主启动策略。
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const hiddenDesktopScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hiddenDesktop.ps1')

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

export function runTestHost({ executable, args, env, mode = resolveTestHostMode(), stdout = process.stdout, stderr = process.stderr }) {
  if (mode === 'desktop' && process.platform !== 'win32') {
    throw new Error('独立桌面仅支持 Windows')
  }
  if (mode !== 'desktop' && mode !== 'foreground') {
    throw new Error(`未知测试宿主模式：${mode}`)
  }
  const shell = mode === 'foreground' && process.platform === 'win32' && executable.endsWith('.cmd')
  const command = mode === 'desktop' ? 'powershell.exe' : shell ? `"${executable}"` : executable
  const commandArgs = mode === 'desktop'
    ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', hiddenDesktopScript,
      Buffer.from(JSON.stringify({ executable, args, cwd: process.cwd() }), 'utf8').toString('base64')]
    : shell ? args.map((arg) => `"${arg}"`) : args
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { env, shell, windowsHide: true })
    child.stdout.on('data', (chunk) => stdout.write(chunk))
    child.stderr.on('data', (chunk) => stderr.write(chunk))
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
}
