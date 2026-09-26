// VS Code 1.86.2 独立桌面 + 回环 CDP：真实 Electron/webview 到工作台键位路径。
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { downloadAndUnzipVSCode } from '@vscode/test-electron'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { buildTestHostArgs, runTestHost } from '../integration/testHost.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dir = mkdtempSync(path.join(tmpdir(), 'vsidian-keyboard-host-'))
writeFileSync(path.join(dir, 'keyboard.md'), 'word')
await build({ entryPoints: [path.join(root, 'test/integration/keybindingsHostSuite.ts')],
  outfile: path.join(root, 'out/test/integration/keybindingsHost.js'), bundle: true,
  platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'] })
const server = createServer()
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
await new Promise((resolve) => server.close(resolve))
const executable = await downloadAndUnzipVSCode({ version: '1.86.2' })
const args = buildTestHostArgs({ workspaceDir: dir,
  testsPath: path.join(root, 'out/test/integration/keybindingsHost.js'),
  extensionPath: root, extensionsDir: path.join(root, '.vscode-test/extensions'),
  userDataDir: path.join(dir, 'user-data'), disableExtensions: true })
args.push(`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1')
console.log(`[键盘宿主] 独立桌面，回环 CDP 端口 ${port}，fixture ${dir}`)
const host = runTestHost({ executable, args, env: { ...process.env, WORKSPACE_DIR: dir,
  VSIDIAN_TEST_HOOKS: '1' }, mode: 'desktop', timeoutMs: 90000,
  reportPath: path.join(root, '.vscode-test/keybindings-host.log') })
let socket
try {
  const deadline = Date.now() + 60000
  while ((!existsSync(path.join(dir, 'ready')) || !(await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok).catch(() => false))) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  assert(existsSync(path.join(dir, 'ready')), '宿主未打开 fixture')
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
  console.log(`[键盘宿主] CDP 目标：${targets.map((target) => target.type).join(', ')}`)
  const pending = new Map()
  let nextId = 0
  async function connect(target) {
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    })
    ws.addEventListener('message', (event) => {
      const response = JSON.parse(event.data)
      if (!pending.has(response.id)) return
      const { resolve, reject } = pending.get(response.id)
      pending.delete(response.id)
      response.error ? reject(new Error(response.error.message)) : resolve(response.result)
    })
    socket = ws
  }
  function call(method, params = {}) {
    const id = ++nextId
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }
  let found = false
  let contextId
  for (const target of targets.filter((item) => item.webSocketDebuggerUrl)) {
    await connect(target)
    const tree = await call('Page.getFrameTree').catch(() => null)
    const frames = []
    function collect(node) {
      if (!node) return
      frames.push(node.frame)
      for (const child of node.childFrames ?? []) collect(child)
    }
    collect(tree?.frameTree)
    for (const frame of frames) {
      const world = await call('Page.createIsolatedWorld', { frameId: frame.id }).catch(() => null)
      if (!world) continue
      const probe = await call('Runtime.evaluate', {
        contextId: world.executionContextId,
        expression: "Boolean(document.querySelector('.cm-content'))", returnByValue: true,
      }).catch(() => null)
      if (probe?.result?.value === true) {
        found = true; contextId = world.executionContextId; break
      }
    }
    if (found) break
    socket.close()
  }
  assert(found, 'CDP 未找到 Vsidian webview 的 .cm-content')
  let requestId = 0
  async function command(action, details = {}) {
    const id = ++requestId
    writeFileSync(path.join(dir, 'request.json'), JSON.stringify({ id, action, ...details }))
    const response = path.join(dir, `response-${id}.json`)
    const until = Date.now() + 10000
    while (!existsSync(response) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100))
    assert(existsSync(response), `宿主请求 ${action} 超时`)
    return JSON.parse(readFileSync(response, 'utf8'))
  }
  async function waitText(expected) {
    const until = Date.now() + 5000
    do {
      if (await command('text') === expected) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    } while (Date.now() < until)
    assert.equal(await command('text'), expected)
  }
  async function press(key, shift = false, focusSelector = '.cm-content') {
    await call('Runtime.evaluate', { contextId,
      expression: `document.querySelector(${JSON.stringify(focusSelector)}).focus()` })
    await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Control', code: 'ControlLeft',
      windowsVirtualKeyCode: 17, modifiers: 2 })
    if (shift) await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft',
      windowsVirtualKeyCode: 16, modifiers: 10 })
    const digit = /^[0-9]$/.test(key)
    const code = key.toUpperCase().charCodeAt(0)
    const modifiers = shift ? 10 : 2
    await call('Input.dispatchKeyEvent', { type: 'keyDown', key: shift ? key.toUpperCase() : key,
      code: `${digit ? 'Digit' : 'Key'}${key.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers })
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: shift ? key.toUpperCase() : key,
      code: `${digit ? 'Digit' : 'Key'}${key.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers })
    if (shift) await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 2 })
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 })
  }
  await press('b')
  await waitText('**word**')
  assert.equal(await command('mode', { text: 'reading' }), true)
  await new Promise((resolve) => setTimeout(resolve, 250))
  await press('b', false, '[data-vsidian-mode="reading"]')
  assert.equal(await command('text'), '**word**', '阅读模式不得触发粗体写入')
  assert.equal(await command('mode', { text: 'live' }), true)
  await new Promise((resolve) => setTimeout(resolve, 250))
  for (let level = 1; level <= 6; level++) {
    assert.equal(await command('replaceText', { text: 'word' }), true)
    await waitText('word')
    await press(String(level))
    await waitText(`${'#'.repeat(level)} word`)
  }
  assert.equal(await command('replaceText', { text: '# word' }), true)
  await waitText('# word')
  await press('0')
  await waitText('word')
  await press('b')
  await waitText('**word**')
  assert.equal((await command('set', { operationId: 'bold', bindings: ['ctrl+shift+b'] })).ok, true)
  assert.equal(await command('replaceText', { text: 'word' }), true)
  await waitText('word')
  await new Promise((resolve) => setTimeout(resolve, 300))
  await press('b')
  assert.equal(await command('text'), 'word', '改绑后旧 Ctrl+B 应释放')
  await press('b', true)
  await waitText('**word**')
  assert.equal((await command('set', { operationId: 'bold', bindings: ['ctrl+k ctrl+b'] })).ok, true)
  assert.equal(await command('replaceText', { text: 'word' }), true)
  await waitText('word')
  await new Promise((resolve) => setTimeout(resolve, 300))
  await press('k')
  assert.equal(await command('text'), 'word', '首段只能等待')
  await press('b')
  await waitText('**word**')
  assert.equal((await command('set', { operationId: 'bold', bindings: [] })).ok, true)
  assert.equal(await command('replaceText', { text: 'word' }), true)
  await waitText('word')
  await new Promise((resolve) => setTimeout(resolve, 300))
  await press('b')
  assert.equal(await command('text'), 'word', '显式清空后 Ctrl+B 不应复活')
  assert.equal((await command('resetAll')).ok, true)
  await new Promise((resolve) => setTimeout(resolve, 300))
  await press('b')
  await waitText('**word**')
  // 真宿主 TextDocument 经 edit.request 写回；最终由伴随套件在 done 后回报。
  writeFileSync(path.join(dir, 'done'), '')
  const code = await host
  assert.equal(code, 0)
  assert.equal(readFileSync(path.join(dir, 'result'), 'utf8'), '**word**',
    'Ctrl+B 应由 Vsidian 加粗而非切换工作台侧栏')
  console.log('[键盘宿主][PASS] 1.86.2 独立桌面 CDP Ctrl+B、Ctrl+0–6、改绑旧键释放、两段键、清空及重置')
} finally {
  if (socket) socket.close()
  writeFileSync(path.join(dir, 'done'), '')
  await host
}
