// 空窗口命令激活实测套件（#33）：验证「打开设置」命令在未打开任何文档、
// 扩展尚未激活的窗口下可用——依赖 VSCode 1.74+ 对 contributes.commands
// 自动派生 onCommand 激活（1.86 适用与否的真宿主实测；若派生失效，命令
// 将以 command not found 失败，结论是需补显式 activationEvents）。
//
// 关键约束：本套件**不得**显式调用 ext.activate()——主集成套件的首例会
// 激活扩展，激活后的命令执行测不出自动派生行为，故单独成套。
import * as vscode from 'vscode'

const EXT_ID = 'onegayi.vsidian'

async function poll(label: string, fn: () => Promise<boolean>, timeoutMs = 20000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (await fn()) {
      return
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`等待超时：${label}`)
    }
    await new Promise((r) => setTimeout(r, 150))
  }
}

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension(EXT_ID)
  if (!ext) {
    throw new Error(`扩展 ${EXT_ID} 未找到（extensionDevelopmentPath 未加载）`)
  }
  const activeBefore = ext.isActive
  console.log(`[settingsActivation] 命令执行前扩展激活状态：${activeBefore}`)

  // 无 Markdown 文档的窗口直接执行设置命令：若自动派生激活生效，VSCode
  // 会先激活扩展再执行命令；否则此调用 reject（command not found）
  await vscode.commands.executeCommand('onegayi.vsidian.openSettings')
  console.log(`[settingsActivation] 命令执行后扩展激活状态：${ext.isActive}`)
  if (!ext.isActive) {
    throw new Error('命令已执行但扩展未激活：无法访问测试钩子观测设置页状态')
  }

  await poll('设置页打开', async () => {
    const info = (await vscode.commands.executeCommand(
      'onegayi.vsidian._test.settingsPageInfo',
    )) as { open: boolean } | undefined
    return info?.open === true
  })
  console.log(
    `[settingsActivation] 空窗口命令激活结论：执行前 isActive=${activeBefore}，` +
      '命令触发 contributes.commands 自动派生激活=生效，设置页已打开',
  )

  await vscode.commands.executeCommand('onegayi.vsidian._test.closeSettingsPage')
}
