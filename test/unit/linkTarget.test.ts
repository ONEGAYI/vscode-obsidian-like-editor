// 宿主侧链接/图片目标分类契约（工单 #10）：
// webview 只上报原始 href/src，宿主负责 URI 解析与路径拼接——分类器是
// 该职责的纯逻辑核心，必须先于执行层被钉死：
// - scheme 白名单：仅 http/https 外开，其余带 scheme 的一律拦截（file://、
//   javascript:、vscode-asset:、mailto:、协议相对 //）
// - 工作区路径：基于当前文档所在目录解析，不得越过资源根（工作区文件夹
//   根；无工作区时为文档目录）；Windows 盘符路径只在 Windows 宿主生效，
//   远程（POSIX 宿主）不得把 Windows 路径当工作区路径（两类 URI 不混用）
// - 相对路径、空格、中文与 %编码（%20/%E5…）都有明确期望
// - 无扩展名的文档链接按「精确优先，其次补 .md」给候选（#11 双链同语义
//   的便捷形态；本票不做标题/锚点定位）
import { describe, it, expect } from 'vitest'
import {
  classifyImageTarget,
  classifyLinkTarget,
  type LinkContext,
} from '../../src/host/linkTarget'

const WIN: LinkContext = {
  docDir: 'd:\\notes\\子目录',
  rootDir: 'd:\\notes',
  isWindowsHost: true,
}

const POSIX: LinkContext = {
  docDir: '/home/u/notes/sub',
  rootDir: '/home/u/notes',
  isWindowsHost: false,
}

describe('scheme 白名单：外部链接', () => {
  it('http/https（大小写不敏感）归类为 external，保留原 URL', () => {
    expect(classifyLinkTarget('https://example.com/a?b=1#frag', WIN)).toEqual({
      kind: 'external',
      url: 'https://example.com/a?b=1#frag',
    })
    expect(classifyLinkTarget('http://example.com', WIN)).toEqual({
      kind: 'external',
      url: 'http://example.com',
    })
    expect(classifyLinkTarget('HTTPS://EXAMPLE.COM/X', POSIX)).toEqual({
      kind: 'external',
      url: 'HTTPS://EXAMPLE.COM/X',
    })
  })

  it('file:// 与危险/怪异 scheme 一律拦截并给出 scheme 名', () => {
    for (const href of [
      'file:///d:/notes/a.md',
      'file://HOST/share/a.md',
      'javascript:alert(1)',
      'vscode-asset://x/y',
      'vscode-webview-resource://x',
      'mailto:a@b.c',
      'ftp://files.example.com/a',
      'data:text/html,<script>',
    ]) {
      const r = classifyLinkTarget(href, WIN)
      expect(r.kind).toBe('blocked')
      expect(r.kind === 'blocked' && r.reason).toBe('scheme')
    }
    const file = classifyLinkTarget('file:///d:/notes/a.md', WIN)
    expect(file.kind === 'blocked' && file.scheme).toBe('file')
    const js = classifyLinkTarget('javascript:alert(1)', WIN)
    expect(js.kind === 'blocked' && js.scheme).toBe('javascript')
  })

  it('协议相对 //example.com 与空白 href 拦截', () => {
    const proto = classifyLinkTarget('//example.com/x', WIN)
    expect(proto.kind === 'blocked' && proto.reason).toBe('scheme')
    expect(classifyLinkTarget('', WIN).kind).toBe('blocked')
    expect(classifyLinkTarget('   ', WIN).kind).toBe('blocked')
  })

  it('仅锚点（#frag）拦截为不可跳转目标', () => {
    const r = classifyLinkTarget('#标题锚点', WIN)
    expect(r.kind).toBe('blocked')
    expect(r.kind === 'blocked' && r.reason).toBe('empty')
  })
})

describe('工作区相对路径解析（基于当前文档所在目录）', () => {
  it('相对路径 + 中文 + 空格：原样与 %编码两种写法解析到同一目标', () => {
    const raw = classifyLinkTarget('./目标 二.md', WIN)
    expect(raw).toEqual({ kind: 'doc', candidates: ['d:\\notes\\子目录\\目标 二.md'] })
    const encoded = classifyLinkTarget('.%2F%E7%9B%AE%E6%A0%87%20%E4%BA%8C.md', WIN)
    expect(encoded).toEqual(raw)
  })

  it('../ 上行仍在资源根内则允许，越出资源根则拦截（不静默越界）', () => {
    const up = classifyLinkTarget('../上层文档.md', WIN)
    expect(up).toEqual({ kind: 'doc', candidates: ['d:\\notes\\上层文档.md'] })
    const escape = classifyLinkTarget('../../越界文档.md', WIN)
    expect(escape.kind).toBe('blocked')
    expect(escape.kind === 'blocked' && escape.reason).toBe('escape')
  })

  it('剥掉 #fragment 与 ?query 后解析路径', () => {
    const r = classifyLinkTarget('./a.md#section', WIN)
    expect(r).toEqual({ kind: 'doc', candidates: ['d:\\notes\\子目录\\a.md'] })
    const q = classifyLinkTarget('./a.md?x=1', WIN)
    expect(q).toEqual({ kind: 'doc', candidates: ['d:\\notes\\子目录\\a.md'] })
  })

  it('无扩展名：候选为「精确路径，其次补 .md」', () => {
    const r = classifyLinkTarget('./隔壁笔记', WIN)
    expect(r).toEqual({
      kind: 'doc',
      candidates: ['d:\\notes\\子目录\\隔壁笔记', 'd:\\notes\\子目录\\隔壁笔记.md'],
    })
    // 已有扩展名不追加
    const png = classifyLinkTarget('./图.png', WIN)
    expect(png).toEqual({ kind: 'doc', candidates: ['d:\\notes\\子目录\\图.png'] })
  })

  it('POSIX 宿主：相对路径与 UTF-8 命名解析正确', () => {
    const r = classifyLinkTarget('./assets/图 片说明.md', POSIX)
    expect(r).toEqual({ kind: 'doc', candidates: ['/home/u/notes/sub/assets/图 片说明.md'] })
    const enc = classifyLinkTarget('./assets/%E5%9B%BE%20%E7%89%87%E8%AF%B4%E6%98%8E.md', POSIX)
    expect(enc).toEqual(r)
  })

  it('POSIX 宿主：绝对路径限资源根内', () => {
    const inside = classifyLinkTarget('/home/u/notes/a.md', POSIX)
    expect(inside).toEqual({ kind: 'doc', candidates: ['/home/u/notes/a.md'] })
    const outside = classifyLinkTarget('/etc/passwd', POSIX)
    expect(outside.kind === 'blocked' && outside.reason).toBe('escape')
  })
})

describe('Windows 与远程（POSIX 宿主）不混用', () => {
  it('Windows 宿主：反斜杠分隔符与盘符绝对路径按 Windows 语义解析', () => {
    const bs = classifyLinkTarget('嵌套\\深层.md', WIN)
    expect(bs).toEqual({ kind: 'doc', candidates: ['d:\\notes\\子目录\\嵌套\\深层.md'] })
    const drive = classifyLinkTarget('d:\\notes\\绝对.md', WIN)
    expect(drive).toEqual({ kind: 'doc', candidates: ['d:\\notes\\绝对.md'] })
    const driveEsc = classifyLinkTarget('e:\\别的盘\\x.md', WIN)
    expect(driveEsc.kind === 'blocked' && driveEsc.reason).toBe('escape')
    // UNC 路径不在资源根内
    const unc = classifyLinkTarget('\\\\server\\share\\a.md', WIN)
    expect(unc.kind === 'blocked' && unc.reason).toBe('escape')
  })

  it('Windows 宿主：POSIX 风格根路径按资源根所在盘解析（盘内根相对）', () => {
    const r = classifyLinkTarget('/notes/根相对.md', WIN)
    expect(r).toEqual({ kind: 'doc', candidates: ['d:\\notes\\根相对.md'] })
  })

  it('POSIX 宿主（远程）：Windows 盘符路径拦截，不当作工作区路径', () => {
    const r = classifyLinkTarget('d:\\notes\\a.md', POSIX)
    expect(r.kind).toBe('blocked')
    expect(r.kind === 'blocked' && r.reason).toBe('windows-drive-on-posix')
    // 大写盘符同样拦截
    const up = classifyLinkTarget('C:/x.md', POSIX)
    expect(up.kind === 'blocked' && up.reason).toBe('windows-drive-on-posix')
  })

  it('单字母 scheme 不误判：Windows 宿主上 c:\\x.md 是盘符而非 scheme', () => {
    // 盘符在资源根内 → 文档目标（而非被当 scheme 拦截）
    const inside = classifyLinkTarget('d:\\notes\\盘符.md', WIN)
    expect(inside.kind).toBe('doc')
    // 资源根外的盘符路径：拦截原因是越界（escape），不是 scheme 误判
    const other = classifyLinkTarget('c:\\notes\\a.md', WIN)
    expect(other.kind === 'blocked' && other.reason).toBe('escape')
  })
})

describe('Windows 宿主的 Win32 规范化怪异形态（NTFS ADS 等）', () => {
  // basename 含 ':'（如 note.md::$DATA）会被当作 NTFS 备用数据流读取，
  // 尾随 '.'/空格 会被 Win32 规范化剥除——两者都不指向用户可见文件，
  // 一律拦截（POSIX 宿主上 ':' 是合法文件名字符，不适用该过滤）
  it('ADS 形态（basename 含冒号）拦截：链接与图片通道同口径', () => {
    for (const href of ['note.md::$DATA', 'note.md:stream', '子目录/记:怪']) {
      const t = classifyLinkTarget(href, WIN)
      expect(t).toMatchObject({ kind: 'blocked', reason: 'escape' })
      const img = classifyImageTarget(href, WIN)
      expect(img).toMatchObject({ kind: 'blocked' })
    }
  })

  it('basename 尾随点或空格拦截（Win32 规范化会剥除）', () => {
    expect(classifyLinkTarget('note.md.', WIN)).toMatchObject({ kind: 'blocked', reason: 'escape' })
    expect(classifyLinkTarget('note.md ', WIN)).toMatchObject({ kind: 'blocked', reason: 'escape' })
  })

  it('POSIX 宿主不适用该过滤（冒号/尾随点是合法文件名）', () => {
    expect(classifyLinkTarget('a:b.md', POSIX)).toMatchObject({ kind: 'doc' })
    expect(classifyLinkTarget('weird.', POSIX)).toMatchObject({ kind: 'doc' })
  })
})

describe('图片目标分类（classifyImageTarget）', () => {
  it('工作区内相对图片解析为待读文件路径（空格/中文/%编码）', () => {
    const raw = classifyImageTarget('./assets/图 片.png', WIN)
    expect(raw).toEqual({ kind: 'workspace', fsPath: 'd:\\notes\\子目录\\assets\\图 片.png' })
    const enc = classifyImageTarget('./assets/%E5%9B%BE%20%E7%89%87.png', WIN)
    expect(enc).toEqual(raw)
  })

  it('危险 scheme 与远程 URI 不在此通道放行（webview 只应上报工作区相对 src）', () => {
    for (const src of [
      'file:///d:/x.png',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      'https://cdn.example.com/x.png',
    ]) {
      const r = classifyImageTarget(src, WIN)
      expect(r.kind).toBe('blocked')
      expect(r.kind === 'blocked' && r.reason).toBe('scheme')
    }
  })

  it('越出资源根拦截；POSIX 宿主上 Windows 盘符拦截', () => {
    const esc = classifyImageTarget('../../outside.png', WIN)
    expect(esc.kind === 'blocked' && esc.reason).toBe('escape')
    const winOnPosix = classifyImageTarget('d:\\x.png', POSIX)
    expect(winOnPosix.kind === 'blocked' && winOnPosix.reason).toBe('windows-drive-on-posix')
  })
})
