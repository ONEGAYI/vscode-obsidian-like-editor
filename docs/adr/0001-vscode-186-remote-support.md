# 首版兼容 VSCode 1.86 与 Remote SSH

## 状态

已接受，2026-09-23，由用户在最小产品设计访谈中明确。

## 背景与决定

用户除 Windows 本地使用外，也在旧版本 VSCode 的 Remote SSH 环境编辑文档。因此首版必须向下兼容 VSCode 1.86，并将 Remote SSH 纳入验收，不能推迟为后续功能。

## 影响与取舍

- 扩展 API、依赖运行要求及 Webview 前端产物必须满足旧版宿主，不能仅以最新 VSCode 测试通过作为完成依据。
- 文档、双链与图片资源必须正确指向所在工作区，远程资源不能误解析为客户端本地路径。
- 用户实际组合为另一台 Windows 的 VSCode 1.86 连接 CentOS 7。按用户偏好，以本机 Windows 便携版 VSCode 1.86 为主要兼容验收环境，不要求为插件升级远端。
- 本地测试通过不等于远程资源路径已验证。建议追加打开、编辑、保存、图片及双链跳转的 Remote SSH 最小烟测；不可用时如实标记未验证，不假称远端通过。
- 此决定不等于声称已通过旧系统上的安装或运行测试。

## 技术核对

VSCode 1.86.0 官方类型定义已包含 `CustomTextEditorProvider`、`Webview.asWebviewUri` 与 `workspace.fs`，因此此前建议架构的这些基础接口不要求升级到新版。依赖、运行时及实际输入行为仍需原型验证。[1.86.0 API 源码](https://github.com/microsoft/vscode/blob/1.86.0/src/vscode-dts/vscode.d.ts#L8991)、[远程扩展指南](https://code.visualstudio.com/api/advanced-topics/remote-extensions)
