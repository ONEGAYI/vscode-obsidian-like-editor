// 宿主侧图表导出执行壳（工单 #111）：校验（diagramExportValidate）→
// 另存为对话框 → 落盘 → 回报。documentSession 的端口注入点在
// textEditorProvider；失败时弹宿主错误通知（i18n）。纯逻辑单测在
// diagramExportValidate.test.ts，本壳由集成路径覆盖。
import * as vscode from 'vscode'

import { t } from '../shared/i18n'
import type { DiagramExportFailReason, DiagramExportPayload } from '../shared/protocol'
import {
  documentDirPath,
  sanitizeExportFileName,
  validateDiagramExportPayload,
} from './diagramExportValidate'

export interface DiagramExportOutcome {
  ok: boolean
  reason?: DiagramExportFailReason
}

/**
 * 校验并执行导出。report 恒被调用一次（取消/校验失败/写盘失败/成功）；
 * 非取消失败时弹宿主错误通知。docUriStr 用于把另存为默认目录落在文档
 * 所在处（fileName 已剥离路径成分，仅作建议名）。
 */
export async function runDiagramExport(
  payload: DiagramExportPayload,
  docUriStr: string,
  report: (outcome: DiagramExportOutcome) => void,
): Promise<void> {
  const finish = (outcome: DiagramExportOutcome): void => {
    if (!outcome.ok && outcome.reason && outcome.reason !== 'cancelled') {
      void vscode.window.showErrorMessage(t('graphic.exportFailed'))
    }
    report(outcome)
  }
  if (!validateDiagramExportPayload(payload)) {
    finish({ ok: false, reason: 'invalid' })
    return
  }
  const fileName = sanitizeExportFileName(payload.fileName, payload.format)
  const filters: Record<string, string[]> =
    payload.format === 'svg'
      ? { [t('graphic.exportSvgFilter')]: ['svg'] }
      : { [t('graphic.exportPngFilter')]: ['png'] }
  const docUri = vscode.Uri.parse(docUriStr)
  const dir = documentDirPath(docUri.path)
  const defaultUri =
    dir !== null
      ? vscode.Uri.joinPath(docUri.with({ path: dir }), fileName)
      : vscode.Uri.file(fileName)
  const target = await vscode.window.showSaveDialog({
    defaultUri,
    filters,
  })
  if (!target) {
    finish({ ok: false, reason: 'cancelled' })
    return
  }
  try {
    const data =
      payload.format === 'svg'
        ? Buffer.from(payload.content, 'utf8')
        : Buffer.from(payload.content, 'base64')
    await vscode.workspace.fs.writeFile(target, data)
    finish({ ok: true })
  } catch {
    finish({ ok: false, reason: 'writeFailed' })
  }
}
