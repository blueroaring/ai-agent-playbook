#!/usr/bin/env node
/**
 * godot-mcp — 最小的 stdio MCP 服务：把本机 Godot 编辑器/运行时暴露成 DSH 原生工具。
 *
 * 定位：CLI 桥。不动用户项目即可：跑项目、查脚本报错、执行任意 GDScript（可用来
 * 程序化生成资源/图片）、重导入、导出、录帧看图。
 * 编辑器内部的实时场景操作由配套 addon（addons/dsh_bridge）提供，见 godot_editor_* 工具。
 *
 * 零依赖：只用 Node 内置模块。
 *
 * 环境变量：
 *   GODOT_BIN         Godot 可执行文件；不给就自动探测（含 Steam 库）
 *   GODOT_PROJECT     默认项目目录（工具参数 project 可覆盖）
 *   GODOT_OUTPUT_DIR  录帧/导出等产物目录，默认 ~/.dsh/godot-output
 */

import { execFile, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ADDON_SRC = join(HERE, 'godot-addon', 'addons', 'dsh_bridge')

const VERSION = '0.1.0'
const OUTPUT_DIR = process.env.GODOT_OUTPUT_DIR || join(homedir(), '.dsh', 'godot-output')
const DEFAULT_PROJECT = process.env.GODOT_PROJECT || null
const BRIDGE_PORT = Number(process.env.DSH_GODOT_BRIDGE_PORT || 9080)

// ---------------------------------------------------------------- Godot 定位

// Extra Steam library roots can be appended with
//   GODOT_STEAM_ROOTS="D:\Games\Steam;E:\SteamLibrary"   (semicolon separated)
const STEAM_ROOTS = [
  ...(process.env.GODOT_STEAM_ROOTS ? process.env.GODOT_STEAM_ROOTS.split(';').map((s) => s.trim()).filter(Boolean) : []),
  'C:\\Program Files (x86)\\Steam',
  'C:\\Program Files\\Steam',
  'D:\\Steam',
  'D:\\SteamLibrary',
  'E:\\SteamLibrary',
]

// Where godot_projects() looks when the caller does not pass `roots`.
// The drive letters below are only guesses; override with
//   GODOT_SCAN_ROOTS="D:\;E:\;C:\dev"                    (semicolon separated)
const DEFAULT_SCAN_ROOTS = process.env.GODOT_SCAN_ROOTS
  ? process.env.GODOT_SCAN_ROOTS.split(';').map((s) => s.trim()).filter(Boolean)
  : [homedir(), 'D:\\', 'E:\\', join(homedir(), 'Desktop'), join(homedir(), 'Documents')]

function steamLibraryRoots() {
  const roots = new Set()
  for (const base of STEAM_ROOTS) {
    if (!existsSync(base)) continue
    roots.add(base)
    const vdf = join(base, 'steamapps', 'libraryfolders.vdf')
    if (!existsSync(vdf)) continue
    try {
      const text = readFileSync(vdf, 'utf8')
      for (const m of text.matchAll(/"path"\s+"([^"]+)"/g)) roots.add(m[1].replace(/\\\\/g, '\\'))
    } catch {}
  }
  return [...roots]
}

function detectGodot() {
  if (process.env.GODOT_BIN && existsSync(process.env.GODOT_BIN)) return process.env.GODOT_BIN
  const candidates = []
  for (const root of steamLibraryRoots()) {
    const dir = join(root, 'steamapps', 'common', 'Godot Engine')
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      // 只认编辑器（tools）构建，排除导出模板目录
      if (/^godot.*tools.*\.exe$/i.test(f)) candidates.push(join(dir, f))
    }
  }
  candidates.push('C:\\Program Files\\Godot\\Godot.exe', 'godot')
  return candidates.find((c) => c === 'godot' || existsSync(c)) ?? 'godot'
}

const GODOT = detectGodot()

// ---------------------------------------------------------------- 执行封装

function runGodot(args, { cwd, timeoutMs = 120000, project } = {}) {
  const finalArgs = project ? ['--path', project, ...args] : args
  return new Promise((resolvePromise) => {
    const child = execFile(
      GODOT,
      finalArgs,
      { cwd: cwd ?? (project || DEFAULT_PROJECT || process.cwd()), timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const killed = err?.killed || err?.signal === 'SIGTERM'
        resolvePromise({
          ok: !err || !killed,
          exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          timedOut: !!killed,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          fatal: err && typeof err.code !== 'number' ? String(err.message || err) : null,
          args: finalArgs,
        })
      },
    )
    child.on('error', () => {})
  })
}

function cleanOutput(r) {
  const out = [r.stdout, r.stderr].map((s) => s.trim()).filter(Boolean).join('\n')
  const lines = out.split('\n').map((l) => l.trimEnd())
  const errors = lines.filter((l) => /(SCRIPT ERROR|ERROR:|Parse Error|Failed to load|Cannot open|Invalid)/i.test(l)).slice(0, 40)
  const warnings = lines.filter((l) => /(WARNING:|WARN:)/i.test(l)).slice(0, 10)
  return {
    exitCode: r.exitCode,
    timedOut: r.timedOut || undefined,
    errors: errors.length ? errors : undefined,
    warnings: warnings.length ? warnings : undefined,
    output: lines.length > 300 ? [...lines.slice(0, 150), `…（省略 ${lines.length - 300} 行）`, ...lines.slice(-150)] : lines,
    fatal: r.fatal || undefined,
  }
}

function requireProject(project) {
  const p = resolve(project || DEFAULT_PROJECT || '')
  if (!p || !existsSync(join(p, 'project.godot'))) {
    throw new Error(`找不到 Godot 项目：${p || '(未指定)'}。请传 project 参数，或设置环境变量 GODOT_PROJECT。`)
  }
  return p
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

// ---------------------------------------------------------------- 编辑器插件桥

function bridgeContext(project) {
  const tokenFile = join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Godot', 'app_userdata')
  return { tokenFile, url: `http://127.0.0.1:${BRIDGE_PORT}` }
}

function readBridgeToken(project) {
  // addon 把随机 token 写在 user:// 下；user:// 在 Windows 映射到 %APPDATA%\Godot\app_userdata\<项目名>\
  const name = readProjectName(project)
  const candidates = [
    join(process.env.APPDATA || '', 'Godot', 'app_userdata', name, 'dsh_bridge_token.txt'),
    join(process.env.APPDATA || '', 'Godot', 'app_userdata', name, 'dsh_bridge_token'),
  ]
  for (const f of candidates) {
    if (existsSync(f)) return readFileSync(f, 'utf8').trim()
  }
  return null
}

function readBridgePort(project) {
  if (!project) return null
  const name = readProjectName(project)
  const f = join(process.env.APPDATA || '', 'Godot', 'app_userdata', name, 'dsh_bridge_port.txt')
  try {
    const p = Number(readFileSync(f, 'utf8').trim())
    if (Number.isInteger(p) && p > 0) return p
  } catch {}
  return null
}

function readProjectName(project) {
  try {
    const text = readFileSync(join(project, 'project.godot'), 'utf8')
    const m = text.match(/config\/name\s*=\s*"([^"]*)"/)
    return m ? m[1] : 'unknown'
  } catch {
    return 'unknown'
  }
}

async function bridge(path, { method = 'GET', body, project } = {}) {
  const token = project ? readBridgeToken(project) : null
  const candidates = [...new Set([readBridgePort(project), BRIDGE_PORT, ...Array.from({ length: 11 }, (_, i) => 9080 + i)].filter(Boolean))]
  let lastError = null
  for (const port of candidates) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-DSH-Token': token } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      })
      const text = await res.text()
      if (!res.ok) throw new Error(`桥接返回 HTTP ${res.status}：${text.slice(0, 300)}`)
      return text ? JSON.parse(text) : null
    } catch (e) {
      lastError = e
      if (/返回 HTTP 4\d\d/.test(String(e.message))) throw e // 端口对了但请求被拒：直接报出来
    }
  }
  throw new Error(`连不上编辑器桥（试过端口 ${candidates.join('/')}）：${String(lastError?.message ?? '无响应')}。请确认：① 项目里装了 addons/dsh_bridge；② 已在 项目设置→插件 或 project.godot 的 [editor_plugins] 里启用；③ Godot 编辑器正打开这个项目。`)
}

// ---------------------------------------------------------------- 工具

const SV_TEMPLATE = (body) => `extends SceneTree

# 由 DSH 生成：在项目上下文里执行 GDScript。用 print() 输出结果，脚本结束会自动退出。
func _initialize() -> void:
${body.split('\n').map((l) => (l.trim() ? `\t${l}` : '')).join('\n')}
	quit()
`

const tools = {
  async godot_status({ project = null } = {}) {
    const binExists = GODOT === 'godot' || existsSync(GODOT)
    const ver = binExists
      ? await runGodot(['--version'], { timeoutMs: 30000 })
      : { stdout: '', stderr: 'not found', exitCode: 1 }
    const proj = project || DEFAULT_PROJECT
    const projOK = proj ? existsSync(join(proj, 'project.godot')) : false
    return {
      godot可执行文件: GODOT,
      存在: binExists,
      版本: (ver.stdout || ver.stderr).trim().split('\n')[0] || '(读取失败)',
      默认项目: proj || '(未设置)',
      默认项目有效: projOK,
      项目名: projOK ? readProjectName(resolve(proj)) : null,
      产物目录: OUTPUT_DIR,
      编辑器桥端口: BRIDGE_PORT,
      桥token: projOK ? (readBridgeToken(resolve(proj)) ? '已存在' : '未生成（插件没跑过）') : null,
      导出模板: (() => {
        const dir = join(dirname(GODOT), 'editor_data', 'export_templates')
        if (!existsSync(dir)) return '(无)'
        return readdirSync(dir)
      })(),
    }
  },

  async godot_projects({ roots = null, depth = 4 } = {}) {
    const searchRoots = roots?.length ? roots : DEFAULT_SCAN_ROOTS
    const skip = /(^|[\\/])(node_modules|\.git|\.godot|AppData|Windows|Program Files|Program Files \(x86\)|SteamLibrary|steamapps|\.dsh|dist|storage)([\\/]|$)/i
    const found = []
    const walk = (dir, left) => {
      if (left < 0 || found.length > 60) return
      let entries
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        const full = join(dir, e.name)
        if (skip.test(full)) continue
        if (e.isFile() && e.name === 'project.godot') {
          found.push({ 路径: dir, 名称: readProjectName(dir), 改动: statSync(full).mtime.toISOString().slice(0, 10) })
          continue
        }
        if (e.isDirectory()) walk(full, left - 1)
      }
    }
    for (const r of searchRoots) if (existsSync(r)) walk(r, depth)
    return { 搜索根: searchRoots, 找到: found.length, 项目: found }
  },

  async godot_new_project({ path, name = null }) {
    const dir = resolve(path)
    if (existsSync(join(dir, 'project.godot'))) return { 结果: '该目录已是 Godot 项目', 路径: dir }
    ensureDir(dir)
    const projectName = name || dir.split(/[\\/]/).filter(Boolean).pop()
    writeFileSync(join(dir, 'project.godot'), `; Engine configuration file.
config_version=5

[application]

config/name="${projectName}"
run/main_scene="res://main.tscn"
config/features=PackedStringArray("4.7", "GL Compatibility")
config/icon="res://icon.svg"

[rendering]

renderer/rendering_method="gl_compatibility"
renderer/rendering_method.mobile="gl_compatibility"
`)
    writeFileSync(join(dir, 'main.gd'), `extends Node2D

func _ready() -> void:
	print("[${projectName}] ready — Godot ", Engine.get_version_info().string)
`)
    writeFileSync(join(dir, 'main.tscn'), `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://main.gd" id="1_main"]

[node name="Main" type="Node2D"]
script = ExtResource("1_main")

[node name="Title" type="Label" parent="."]
offset_left = 40.0
offset_top = 40.0
offset_right = 520.0
offset_bottom = 90.0
text = "${projectName} — created for DSH"
`)
    writeFileSync(join(dir, 'icon.svg'), `<svg width="128" height="128" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
  <rect width="128" height="128" rx="24" fill="#1f2430"/>
  <circle cx="64" cy="64" r="34" fill="none" stroke="#4fd1c5" stroke-width="8"/>
  <circle cx="64" cy="64" r="12" fill="#4fd1c5"/>
</svg>
`)
    return { 结果: '已创建 Godot 项目', 路径: dir, 文件: ['project.godot', 'main.tscn', 'main.gd', 'icon.svg'], 下一步: `用 godot_check / godot_run 验证；或在编辑器里打开：${dir}` }
  },

  async godot_check({ project = null, script = null, timeoutMs = 90000 } = {}) {
    const p = requireProject(project)
    if (script) {
      const res = script.startsWith('res://') ? script : `res://${script.replace(/^[\\/]+/, '')}`
      const r = await runGodot(['--headless', '--check-only', '--script', res], { project: p, timeoutMs })
      return { 检查: res, ...cleanOutput(r) }
    }
    const r = await runGodot(['--headless', '--quit-after', '3'], { project: p, timeoutMs })
    return { 检查: '整个项目（无头运行 3 帧，捕获解析/加载错误）', ...cleanOutput(r) }
  },

  async godot_run({ project = null, headless = true, quitAfterFrames = 120, timeoutMs = 120000, args = [] } = {}) {
    const p = requireProject(project)
    const headArgs = headless ? ['--headless'] : []
    const r = await runGodot([...headArgs, '--quit-after', String(quitAfterFrames), ...args], { project: p, timeoutMs })
    return { 项目: p, 无头: headless, ...cleanOutput(r) }
  },

  async godot_script({ project = null, code, timeoutMs = 120000, keepFile = false } = {}) {
    const p = requireProject(project)
    if (!code) throw new Error('必须提供 code（GDScript 片段，会包进 extends SceneTree 的 _initialize 里）')
    const tmpDir = ensureDir(join(p, '.dsh_tmp'))
    const file = join(tmpDir, `tool_${Date.now()}.gd`)
    writeFileSync(file, SV_TEMPLATE(code))
    try {
      const r = await runGodot(['--headless', '--script', `res://.dsh_tmp/${file.split(/[\\/]/).pop()}`], { project: p, timeoutMs })
      return { 项目: p, 脚本: file, ...cleanOutput(r) }
    } finally {
      if (!keepFile) { try { rmSync(file, { force: true }) } catch {} }
    }
  },

  async godot_import({ project = null, timeoutMs = 180000 } = {}) {
    const p = requireProject(project)
    const r = await runGodot(['--headless', '--import'], { project: p, timeoutMs })
    return { 项目: p, 说明: '重新导入资源（新增/替换素材后运行）', ...cleanOutput(r) }
  },

  async godot_export({ project = null, preset = null, output = null, debug = false, timeoutMs = 600000 } = {}) {
    const p = requireProject(project)
    const presetsFile = join(p, 'export_presets.cfg')
    if (!existsSync(presetsFile)) {
      return { 项目: p, 结果: '项目里没有 export_presets.cfg：请先在编辑器里 项目→导出 添加一个预设' }
    }
    const presets = [...readFileSync(presetsFile, 'utf8').matchAll(/^name="([^"]+)"/gm)].map((m) => m[1])
    if (!preset) return { 项目: p, 可用预设: presets, 提示: '再调用一次并给出 preset 参数' }
    if (!presets.includes(preset)) return { 项目: p, 结果: `找不到预设 ${preset}`, 可用预设: presets }
    const out = output || join(OUTPUT_DIR, `${readProjectName(p)}-${debug ? 'debug' : 'release'}.exe`)
    ensureDir(dirname(out))
    const r = await runGodot(['--headless', `--export-${debug ? 'debug' : 'release'}`, preset, out], { project: p, timeoutMs })
    return { 项目: p, 预设: preset, 产物: out, 产物存在: existsSync(out), ...cleanOutput(r) }
  },

  async godot_frames({ project = null, frames = 60, fps = 10, timeoutMs = 180000, maxKeep = 6 } = {}) {
    const p = requireProject(project)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const dir = ensureDir(join(OUTPUT_DIR, `frames-${stamp}`))
    const base = join(dir, 'frame.png')
    // Movie Maker 模式：逐帧渲染并写成 PNG 序列（真实渲染结果，不依赖窗口截图）
    const r = await runGodot(['--write-movie', base, '--fixed-fps', String(fps), '--quit-after', String(frames)], { project: p, timeoutMs })
    const files = readdirSync(dir).filter((f) => f.endsWith('.png')).sort()
    const picked = files.length > maxKeep
      ? [...files.slice(0, Math.ceil(maxKeep / 2)), ...files.slice(-Math.floor(maxKeep / 2))]
      : files
    return { 项目: p, 帧目录: dir, 生成帧数: files.length, 抽样帧: picked.map((f) => join(dir, f)), ...cleanOutput(r) }
  },

  // ---- 编辑器插件桥（需要 addons/dsh_bridge 已启用、编辑器正打开该项目）----

  async godot_install_addon({ project = null, enable = true } = {}) {
    const p = requireProject(project)
    if (!existsSync(ADDON_SRC)) {
      return {
        结果: '找不到插件源码',
        期望位置: ADDON_SRC,
        说明: '插件目录必须与本脚本同级：' + join(HERE, 'godot-addon', 'addons', 'dsh_bridge'),
      }
    }
    const dest = join(p, 'addons', 'dsh_bridge')
    ensureDir(join(p, 'addons'))
    cpSync(ADDON_SRC, dest, { recursive: true, force: true })
    const files = readdirSync(dest)
    let enabled = null
    if (enable) {
      const projFile = join(p, 'project.godot')
      let text = readFileSync(projFile, 'utf8')
      const entry = 'res://addons/dsh_bridge/plugin.cfg'
      const sectionRe = /\[editor_plugins\][\s\S]*?(?=\n\[|$)/
      if (sectionRe.test(text)) {
        text = text.replace(sectionRe, (section) => {
          const m = section.match(/enabled=PackedStringArray\(([^)]*)\)/)
          if (m) {
            const items = m[1].split(',').map((s) => s.trim()).filter(Boolean)
            if (!items.includes(`"${entry}"`)) items.push(`"${entry}"`)
            return section.replace(m[0], `enabled=PackedStringArray(${items.join(', ')})`)
          }
          return `${section.trimEnd()}\nenabled=PackedStringArray("${entry}")\n`
        })
      } else {
        if (!text.endsWith('\n')) text += '\n'
        text += `\n[editor_plugins]\n\nenabled=PackedStringArray("${entry}")\n`
      }
      writeFileSync(projFile, text)
      enabled = entry
    }
    return {
      结果: '插件已安装到项目',
      目标: dest,
      文件: files,
      '已在project.godot启用': enabled ?? '未改动（enable=false）',
      下一步: `用编辑器打开项目即可自动生效；或让我查 godot_editor_ping。卸载：删掉 ${dest} 并去掉 project.godot 里的 [editor_plugins] 条目。`,
    }
  },

  async godot_editor_ping({ project = null } = {}) {
    return await bridge('/ping', { project: project ? resolve(project) : (DEFAULT_PROJECT ? resolve(DEFAULT_PROJECT) : null) })
  },

  async godot_editor_scene({ project = null, depth = 4 } = {}) {
    return await bridge(`/scene?depth=${Number(depth) || 4}`, { project: project ? resolve(project) : (DEFAULT_PROJECT ? resolve(DEFAULT_PROJECT) : null) })
  },

  async godot_editor_selection({ project = null } = {}) {
    return await bridge('/selection', { project: project ? resolve(project) : (DEFAULT_PROJECT ? resolve(DEFAULT_PROJECT) : null) })
  },

  async godot_editor_node_add({ project = null, parent = '.', type = 'Node2D', name = null } = {}) {
    return await bridge('/node/add', { method: 'POST', body: { parent, type, name }, project: project ? resolve(project) : (DEFAULT_PROJECT ? resolve(DEFAULT_PROJECT) : null) })
  },

  async godot_editor_node_set({ project = null, path, property, value } = {}) {
    return await bridge('/node/set', { method: 'POST', body: { path, property, value }, project: project ? resolve(project) : (DEFAULT_PROJECT ? resolve(DEFAULT_PROJECT) : null) })
  },

  async godot_editor_node_delete({ project = null, path } = {}) {
    return await bridge('/node/delete', { method: 'POST', body: { path }, project: project ? resolve(project) : (DEFAULT_PROJECT ? resolve(DEFAULT_PROJECT) : null) })
  },

  async godot_editor_play({ project = null } = {}) {
    return await bridge('/play', { method: 'POST', body: {}, project: project ? resolve(project) : (DEFAULT_PROJECT ? resolve(DEFAULT_PROJECT) : null) })
  },

  async godot_editor_stop({ project = null } = {}) {
    return await bridge('/stop', { method: 'POST', body: {}, project: project ? resolve(project) : (DEFAULT_PROJECT ? resolve(DEFAULT_PROJECT) : null) })
  },

  async godot_editor_reload({ project = null } = {}) {
    return await bridge('/reload', { method: 'POST', body: {}, project: project ? resolve(project) : (DEFAULT_PROJECT ? resolve(DEFAULT_PROJECT) : null) })
  },

  async godot_editor_save_scene({ project = null } = {}) {
    return await bridge('/scene/save', { method: 'POST', body: {}, project: project ? resolve(project) : (DEFAULT_PROJECT ? resolve(DEFAULT_PROJECT) : null) })
  },
}

const S = (name, description, properties, extra) => ({ name, description, inputSchema: { type: 'object', properties, additionalProperties: false, ...(extra ?? {}) } })
const PROJ = { project: { type: 'string', description: 'Godot 项目目录；省略则用默认项目' } }

const SPECS = [
  S('godot_status', '体检：Godot 可执行文件与版本、导出模板、默认项目、编辑器桥端口/token 状态。', {}),
  S('godot_projects', '扫描磁盘寻找 Godot 项目（project.godot）。', { roots: { type: 'array', items: { type: 'string' } }, depth: { type: 'number' } }),
  S('godot_new_project', '创建一个最小可运行的 Godot 4 项目（project.godot / main.tscn / main.gd / icon.svg）。', { path: { type: 'string' }, name: { type: 'string' } }, { required: ['path'] }),
  S('godot_check', '检查脚本或整个项目：给 script 走 --check-only 单文件检查；不给则无头跑 3 帧，捕获解析/加载错误。', { ...PROJ, script: { type: 'string', description: '如 res://player.gd' }, timeoutMs: { type: 'number' } }),
  S('godot_run', '运行项目（默认无头，跑 N 帧后退出），返回 stdout/stderr 与错误摘要。', { ...PROJ, headless: { type: 'boolean' }, quitAfterFrames: { type: 'number' }, timeoutMs: { type: 'number' }, args: { type: 'array', items: { type: 'string' } } }),
  S('godot_script', '在项目上下文里执行任意 GDScript（自动包成 SceneTree._initialize）。可用它程序化生成资源/图片、改场景、批量处理。', { ...PROJ, code: { type: 'string', description: 'GDScript 片段（不要写 extends/quit，工具会包）' }, timeoutMs: { type: 'number' }, keepFile: { type: 'boolean' } }, { required: ['code'] }),
  S('godot_import', '重新导入资源（新增或替换素材后必须做）。', { ...PROJ, timeoutMs: { type: 'number' } }),
  S('godot_export', '导出项目：不给 preset 时列出 export_presets.cfg 里的预设。', { ...PROJ, preset: { type: 'string' }, output: { type: 'string' }, debug: { type: 'boolean' }, timeoutMs: { type: 'number' } }),
  S('godot_frames', '用 Movie Maker 模式跑到真实渲染帧并保存为 PNG 序列（我看图用，也能验证画面是否正常）。', { ...PROJ, frames: { type: 'number' }, fps: { type: 'number' }, timeoutMs: { type: 'number' }, maxKeep: { type: 'number' } }),
  S('godot_install_addon', '把 DSH 编辑器插件（addons/dsh_bridge）装进项目并在 project.godot 里启用；无需手动拷贝。', { ...PROJ, enable: { type: 'boolean', description: '是否同时写入 project.godot 的 [editor_plugins]（默认 true）' } }),
  S('godot_editor_ping', '编辑器桥心跳：确认 addons/dsh_bridge 已启用且编辑器正打开该项目。', PROJ),
  S('godot_editor_scene', '读取编辑器**当前正在编辑**的场景树（节点路径/类型/可见性）。', { ...PROJ, depth: { type: 'number' } }),
  S('godot_editor_selection', '读取编辑器里当前选中的节点及其常用属性。', PROJ),
  S('godot_editor_node_add', '在当前编辑的场景里新增节点（走 UndoRedo，可在编辑器里 Ctrl+Z 撤销）。', { ...PROJ, parent: { type: 'string' }, type: { type: 'string' }, name: { type: 'string' } }),
  S('godot_editor_node_set', '设置节点的属性（走 UndoRedo）。', { ...PROJ, path: { type: 'string' }, property: { type: 'string' }, value: {} }, { required: ['path', 'property', 'value'] }),
  S('godot_editor_node_delete', '删除节点（走 UndoRedo）。', { ...PROJ, path: { type: 'string' } }, { required: ['path'] }),
  S('godot_editor_play', '在编辑器里运行主场景（等同 F5）。', PROJ),
  S('godot_editor_stop', '停止编辑器里正在运行的游戏。', PROJ),
  S('godot_editor_reload', '让编辑器重新加载当前编辑的场景（会丢弃编辑器内未保存的改动）。', PROJ),
  S('godot_editor_save_scene', '保存当前编辑的场景到磁盘。', PROJ),
]

// ---------------------------------------------------------------- MCP 协议

function send(msg) { process.stdout.write(`${JSON.stringify(msg)}\n`) }

async function handle(msg) {
  const { method, params } = msg
  if (method === 'initialize') {
    return { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'godot-mcp', version: VERSION } }
  }
  if (method === 'tools/list') return { tools: SPECS }
  if (method === 'tools/call') {
    const fn = tools[params?.name]
    if (!fn) throw Object.assign(new Error(`未知工具 ${params?.name}`), { code: -32601 })
    const result = await fn(params?.arguments ?? {})
    return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }], isError: false }
  }
  if (method === 'ping') return {}
  if (method?.startsWith('notifications/')) return undefined
  throw Object.assign(new Error(`不支持的方法 ${method}`), { code: -32601 })
}

if (process.argv.includes('--selftest')) {
  const file = process.argv[process.argv.indexOf('--selftest') + 1]
  if (!file || !existsSync(file)) { console.error('用法: node godot-mcp.mjs --selftest <requests.jsonl>'); process.exit(2) }
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const clean = line.replace(/^\uFEFF/, '').trim()
    if (!clean) continue
    const msg = JSON.parse(clean)
    const label = `${msg.id} ${msg.method ?? msg.params?.name ?? ''}`
    try {
      const result = await handle(msg)
      console.log(`### ${label}\n${JSON.stringify(result, null, 2)}\n`)
    } catch (err) {
      console.log(`### ${label} → 抛错: ${String(err.message || err)}\n`)
    }
  }
  process.exit(0)
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let idx
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (!line) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    handle(msg)
      .then((result) => { if (msg.id !== undefined && result !== undefined) send({ jsonrpc: '2.0', id: msg.id, result }) })
      .catch((err) => { if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: err.code ?? -32000, message: String(err.message || err) } }) })
  }
})
process.stdin.on('end', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
