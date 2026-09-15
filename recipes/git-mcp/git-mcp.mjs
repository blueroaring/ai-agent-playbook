#!/usr/bin/env node
/**
 * git-mcp — 最小的 stdio MCP 服务：把本机 git 与 GitHub API 暴露成 DSH 原生工具。
 *
 * 为什么需要它：DSH 的命令沙箱禁止外部程序使用管道 stdio，而 `git push` 必须 fork
 * 传输子进程（git-receive-pack / git-remote-https）→ 沙箱内永远推不上去。
 * 本服务由 DSH 宿主进程直接拉起，不在沙箱内，因此完整的 git 能力可用。
 *
 * 零依赖：只用 Node 内置模块。凭据只从本机文件/环境变量读取，绝不写进仓库配置，也绝不回显。
 *
 * 凭据来源（按优先级）：
 *   1. 环境变量 GITHUB_TOKEN / GH_TOKEN
 *   2. 文件 $GITHUB_TOKEN_FILE，默认 ~/.dsh/github-token（单行 PAT）
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const VERSION = '0.1.0'
const DEFAULT_CWD = process.env.GIT_MCP_DEFAULT_CWD || process.cwd()
const TOKEN_FILE = process.env.GITHUB_TOKEN_FILE || join(homedir(), '.dsh', 'github-token')
const GIT_CANDIDATES = [
  process.env.GIT_BIN,
  'git',
  'C:\\Program Files\\Git\\cmd\\git.exe',
  'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
].filter(Boolean)
const GIT_BIN = GIT_CANDIDATES.find((c) => c === 'git' || existsSync(c)) ?? 'git'
const API = 'https://api.github.com'

// ---------------------------------------------------------------- utilities

function readToken() {
  const env = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim()
  if (env) return env
  try {
    const t = readFileSync(TOKEN_FILE, 'utf8').trim()
    if (t) return t
  } catch {}
  return null
}

function maskToken(t) {
  if (!t) return '(未配置)'
  return `${t.slice(0, 4)}…${t.slice(-4)} (共 ${t.length} 字符)`
}

function scrub(text, token) {
  if (!text) return ''
  let out = String(text)
  if (token) out = out.split(token).join('***TOKEN***')
  out = out.replace(/https:\/\/[^@\s/]*:[^@\s/]*@/g, 'https://***:***@')
  return out
}

function run(args, { cwd = DEFAULT_CWD, timeoutMs = 180000, env = {} } = {}) {
  return new Promise((resolve) => {
    execFile(
      GIT_BIN,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
        resolve({
          ok: !err,
          code,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          fatal: err && typeof err.code !== 'number' ? String(err.message || err) : null,
        })
      },
    )
  })
}

async function git(args, opts) {
  const r = await run(args, opts)
  const token = readToken()
  const body = [r.stdout, r.stderr].filter(Boolean).join('\n').trim()
  return {
    ok: r.ok,
    exitCode: r.code,
    output: scrub(body, token) || '(无输出)',
    hint: r.fatal ? `无法启动 git：${r.fatal}` : null,
  }
}

function repoHint(cwd) {
  return existsSync(join(cwd, '.git')) ? null : `注意：${cwd} 目前不是 git 仓库（没有 .git），可先用 git_init。`
}

function text(s) {
  return [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }]
}

// ---------------------------------------------------------------- tools

const tools = {
  async git_status({ cwd = DEFAULT_CWD }) {
    const r = await git(['status', '--porcelain=v1', '-b'], { cwd })
    const lines = r.output.split('\n').filter(Boolean)
    const branch = lines.find((l) => l.startsWith('##')) ?? '## (未知分支)'
    const dirty = lines.filter((l) => !l.startsWith('##'))
    const res = {
      目录: cwd,
      分支: branch.replace(/^##\s*/, ''),
      变更数: dirty.length,
      变更: dirty.slice(0, 80),
      ...(dirty.length > 80 ? { 说明: `仅显示前 80 条，共 ${dirty.length} 条` } : {}),
      ...(repoHint(cwd) ? { 提示: repoHint(cwd) } : {}),
    }
    if (!r.ok) res.错误 = r.output
    return res
  },

  async git_diff({ cwd = DEFAULT_CWD, staged = false, path = null, statOnly = false }) {
    const args = ['diff', '--no-color']
    if (staged) args.push('--cached')
    if (statOnly) args.push('--stat')
    if (path) args.push('--', path)
    const r = await git(args, { cwd })
    const capped = r.output.length > 40000 ? `${r.output.slice(0, 40000)}\n…（截断，共 ${r.output.length} 字符）` : r.output
    return capped
  },

  async git_log({ cwd = DEFAULT_CWD, n = 15 }) {
    const r = await git(['log', `-n${Math.max(1, Math.min(200, n))}`, '--date=short', '--pretty=format:%h  %ad  %an  %s'], { cwd })
    return r.output
  },

  async git_init({ cwd = DEFAULT_CWD, branch = 'main' }) {
    const args = ['init', '-b', branch]
    const r = await git(args, { cwd })
    return { 结果: r.ok ? `已在 ${cwd} 初始化仓库（分支 ${branch}）` : r.output, ...(r.ok ? {} : { 错误: r.output }) }
  },

  async git_add({ cwd = DEFAULT_CWD, paths }) {
    const list = Array.isArray(paths) ? paths : [paths]
    const r = await git(['add', '--', ...list], { cwd })
    return r.ok ? `已暂存：${list.join(', ')}` : r.output
  },

  async git_commit({ cwd = DEFAULT_CWD, message, all = false, authorName = null, authorEmail = null, allowEmpty = false }) {
    if (!message) throw new Error('message 必填')
    const args = []
    if (authorName) args.push('-c', `user.name=${authorName}`)
    if (authorEmail) args.push('-c', `user.email=${authorEmail}`)
    args.push('commit', '-m', message)
    if (all) args.push('-a')
    if (allowEmpty) args.push('--allow-empty')
    const r = await git(args, { cwd })
    if (r.ok) return { 结果: '已提交', 详情: r.output.split('\n')[0] }
    if (/Author identity unknown|empty ident name|unable to auto-detect email/i.test(r.output)) {
      return {
        结果: '提交失败：缺少 git 身份',
        修复: '再次调用时带上 authorName / authorEmail，或先设置全局 user.name / user.email',
        原始输出: r.output,
      }
    }
    return { 结果: '提交失败', 原始输出: r.output }
  },

  async git_branch({ cwd = DEFAULT_CWD, action = 'list', name = null }) {
    if (action === 'list') return (await git(['branch', '-vv'], { cwd })).output
    if (!name) throw new Error('action=create/checkout 时 name 必填')
    const args = action === 'create' ? ['checkout', '-b', name] : ['checkout', name]
    const r = await git(args, { cwd })
    return r.ok ? `已切换/创建分支 ${name}` : r.output
  },

  async git_remote({ cwd = DEFAULT_CWD, action = 'list', name = 'origin', url = null }) {
    if (action === 'list') return (await git(['remote', '-v'], { cwd })).output
    if (action === 'set') {
      if (!url) throw new Error('action=set 时 url 必填')
      const del = await git(['remote', 'remove', name], { cwd })
      const add = await git(['remote', 'add', name, url], { cwd })
      return { 结果: add.ok ? `已设置 ${name} → ${url}` : add.output, 覆盖前删除: del.ok ? '有旧 remote，已替换' : '无旧 remote' }
    }
    throw new Error(`未知 action: ${action}`)
  },

  async git_push({ cwd = DEFAULT_CWD, remote = 'origin', branch = null, setUpstream = true, forceWithLease = false }) {
    const token = readToken()
    const urlRes = await git(['remote', 'get-url', remote], { cwd })
    if (!urlRes.ok) return { 结果: `找不到远程 ${remote}`, 输出: urlRes.output }

    const url = urlRes.output.trim()
    // -c 是 git 的全局选项，必须排在子命令之前：写成 `git push -c ...` 会报
    // "unknown switch `c`"。所以先收集全局选项，最后才放 'push'。
    const args = []
    let cleanup = null
    if (/^https:\/\/(www\.)?github\.com\//i.test(url) && token) {
      // 凭据经临时 credential store 文件传入：不进 argv、不写 .git/config，用完即删。
      const dir = mkdtempSync(join(tmpdir(), 'dsh-git-cred-'))
      const file = join(dir, 'credentials')
      writeFileSync(file, `https://x-access-token:${token}@github.com\n`, { mode: 0o600 })
      args.push('-c', `credential.helper=store --file=${file.replace(/\\/g, '/')}`)
      cleanup = () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} }
    }
    args.push('push')
    if (forceWithLease) args.push('--force-with-lease')
    if (setUpstream) args.push('-u')
    args.push(remote)
    if (branch) args.push(branch)

    const r = await run(args, { cwd, timeoutMs: 300000 })
    cleanup?.()
    const out = scrub([r.stdout, r.stderr].filter(Boolean).join('\n').trim(), token)
    if (r.ok) return { 结果: '推送成功', 远程: remote, 地址: scrub(url, token), 输出: out || '(无输出)' }
    const hints = []
    if (/Authentication failed|could not read Username|terminal prompts disabled|403/i.test(out)) {
      hints.push(token ? '认证被拒：token 可能无 repo 权限、已过期，或没有该仓库的写权限。' : `未找到 token。请把 PAT 写入 ${TOKEN_FILE}（单行），或设置 GITHUB_TOKEN。`)
    }
    if (/non-fast-forward|fetch first|rejected/i.test(out)) hints.push('远程有新提交：先 git_pull，或确认后使用 forceWithLease。')
    return { 结果: '推送失败', 退出码: r.code, 输出: out, ...(hints.length ? { 诊断: hints } : {}) }
  },

  async git_pull({ cwd = DEFAULT_CWD, remote = 'origin', branch = null }) {
    const args = ['pull', '--ff-only', remote]
    if (branch) args.push(branch)
    const r = await git(args, { cwd })
    return r.ok ? { 结果: '已更新', 输出: r.output } : { 结果: '拉取失败', 输出: r.output }
  },

  async git_check_auth({ cwd = DEFAULT_CWD, remote = 'origin' }) {
    const token = readToken()
    const res = {
      git: GIT_BIN,
      token来源: process.env.GITHUB_TOKEN || process.env.GH_TOKEN ? '环境变量' : existsSync(TOKEN_FILE) ? TOKEN_FILE : '未找到',
      token: maskToken(token),
      默认目录: DEFAULT_CWD,
      当前目录是否仓库: existsSync(join(cwd, '.git')),
    }
    if (token) {
      try {
        const r = await fetch(`${API}/user`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-git-mcp', 'X-GitHub-Api-Version': '2022-11-28' },
        })
        if (r.ok) {
          const u = await r.json()
          res.GitHub账号 = u.login
          res.令牌权限 = r.headers.get('x-oauth-scopes') || '（fine-grained token，权限见 GitHub 设置）'
        } else {
          res.GitHub认证 = `失败 HTTP ${r.status}：${(await r.text()).slice(0, 200)}`
        }
      } catch (e) {
        res.GitHub认证 = `请求失败：${String(e.message || e)}`
      }
    }
    const urlRes = await git(['remote', 'get-url', remote], { cwd })
    if (urlRes.ok) {
      const url = urlRes.output.trim()
      res.远程 = scrub(url, token)
      const probe = await run(['ls-remote', '--heads', remote], { cwd, timeoutMs: 60000 })
      res.远程可达 = probe.ok ? `是（${probe.stdout.split('\n').filter(Boolean).length} 个分支）` : `否：${scrub(probe.stderr || probe.fatal || '', token).slice(0, 300)}`
    }
    return res
  },

  async github_whoami() {
    const token = readToken()
    if (!token) throw new Error(`未配置 token。把 PAT 写入 ${TOKEN_FILE}（单行），或设置环境变量 GITHUB_TOKEN。`)
    const r = await fetch(`${API}/user`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-git-mcp', 'X-GitHub-Api-Version': '2022-11-28' },
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}：${(await r.text()).slice(0, 300)}`)
    const u = await r.json()
    return { login: u.login, name: u.name, 私有仓库数: u.total_private_repos, 公开仓库数: u.public_repos, scopes: r.headers.get('x-oauth-scopes') || '(fine-grained)' }
  },

  async github_create_repo({ name, private: isPrivate = true, description = '', owner = null }) {
    const token = readToken()
    if (!token) throw new Error(`未配置 token。把 PAT 写入 ${TOKEN_FILE}（单行），或设置环境变量 GITHUB_TOKEN。`)
    if (!name) throw new Error('name 必填')
    const url = owner ? `${API}/orgs/${owner}/repos` : `${API}/user/repos`
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-git-mcp', 'X-GitHub-Api-Version': '2022-11-28' },
      body: JSON.stringify({ name, private: !!isPrivate, description, auto_init: false }),
    })
    const body = await r.text()
    if (!r.ok) throw new Error(`创建失败 HTTP ${r.status}：${body.slice(0, 400)}`)
    const repo = JSON.parse(body)
    return { 结果: '已创建', 全名: repo.full_name, 私有: repo.private, 克隆地址: repo.clone_url, 网页: repo.html_url, 下一步: `git_remote {action:"set", url:"${repo.clone_url}"} 然后 git_push` }
  },
}

const SPECS = [
  ['git_status', '查看仓库状态：当前分支、领先/落后、暂存与未暂存的变更清单。默认目录为本项目工作区。', { cwd: { type: 'string', description: '仓库目录，默认项目工作区' } }],
  ['git_diff', '查看代码差异（默认未暂存；staged=true 看已暂存；statOnly=true 只看统计）。', { cwd: { type: 'string' }, staged: { type: 'boolean' }, path: { type: 'string' }, statOnly: { type: 'boolean' } }],
  ['git_log', '查看最近提交历史。', { cwd: { type: 'string' }, n: { type: 'number', description: '条数，默认 15' } }],
  ['git_init', '在当前目录初始化 git 仓库（默认分支 main）。', { cwd: { type: 'string' }, branch: { type: 'string' } }],
  ['git_add', '把文件加入暂存区。', { cwd: { type: 'string' }, paths: { type: 'array', items: { type: 'string' }, description: '文件/目录列表，例如 ["."]' } }, { required: ['paths'] }],
  ['git_commit', '提交。缺 git 身份时用 authorName/authorEmail 临时提供（不写全局配置）。', { cwd: { type: 'string' }, message: { type: 'string' }, all: { type: 'boolean', description: '提交前自动包含已跟踪文件的改动 (-a)' }, authorName: { type: 'string' }, authorEmail: { type: 'string' }, allowEmpty: { type: 'boolean' } }, { required: ['message'] }],
  ['git_branch', '列出 / 创建 / 切换分支。', { cwd: { type: 'string' }, action: { type: 'string', enum: ['list', 'create', 'checkout'] }, name: { type: 'string' } }],
  ['git_remote', '查看或设置远程仓库地址。', { cwd: { type: 'string' }, action: { type: 'string', enum: ['list', 'set'] }, name: { type: 'string', description: '默认 origin' }, url: { type: 'string' } }],
  ['git_push', '推送到远程。GitHub HTTPS 地址会自动用本机 token 认证（凭据不进 argv、不写入仓库配置）。', { cwd: { type: 'string' }, remote: { type: 'string' }, branch: { type: 'string' }, setUpstream: { type: 'boolean' }, forceWithLease: { type: 'boolean', description: '危险：仅在你明确要求时使用' } }],
  ['git_pull', '拉取远程更新（仅快进，避免意外合并）。', { cwd: { type: 'string' }, remote: { type: 'string' }, branch: { type: 'string' } }],
  ['git_check_auth', '体检：git 是否可用、token 是否已配置（只显示掩码）、对应 GitHub 账号、远程是否可达。', { cwd: { type: 'string' }, remote: { type: 'string' } }],
  ['github_whoami', '用本机 token 查询当前 GitHub 账号信息，验证 token 有效。', {}],
  ['github_create_repo', '在 GitHub 上创建仓库（默认私有），返回克隆地址。', { name: { type: 'string' }, private: { type: 'boolean' }, description: { type: 'string' }, owner: { type: 'string', description: '组织名，留空为个人账号' } }, { required: ['name'] }],
].map(([name, description, properties, extra]) => ({
  name,
  description,
  inputSchema: { type: 'object', properties, additionalProperties: false, ...(extra ?? {}) },
}))

// ---------------------------------------------------------------- self test
// 沙箱内没有管道 stdio，无法用管道喂 JSON-RPC；`--selftest <file.jsonl>` 从文件读请求、
// 顺序执行并打印结果，用于在没有 DSH 宿主的情况下验证本服务。
if (process.argv.includes('--selftest')) {
  const file = process.argv[process.argv.indexOf('--selftest') + 1]
  if (!file || !existsSync(file)) {
    console.error('用法: node git-mcp.mjs --selftest <requests.jsonl>')
    process.exit(2)
  }
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const msg = JSON.parse(line)
    const label = `${msg.id} ${msg.method ?? msg.params?.name ?? ''}`
    try {
      const result = await handle(msg)
      console.log(`### ${label}\n${JSON.stringify(result, null, 2)}\n`)
    } catch (err) {
      console.log(`### ${label}  →  抛错: ${String(err.message || err)}\n`)
    }
  }
  process.exit(0)
}

// ---------------------------------------------------------------- MCP loop

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    return { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'git-mcp', version: VERSION } }
  }
  if (method === 'tools/list') return { tools: SPECS }
  if (method === 'tools/call') {
    const name = params?.name
    const fn = tools[name]
    if (!fn) throw Object.assign(new Error(`未知工具 ${name}`), { code: -32601 })
    const result = await fn(params?.arguments ?? {})
    return { content: text(result), isError: false }
  }
  if (method === 'ping') return {}
  if (method?.startsWith('notifications/')) return undefined
  throw Object.assign(new Error(`不支持的方法 ${method}`), { code: -32601 })
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
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    handle(msg)
      .then((result) => {
        if (msg.id !== undefined && result !== undefined) send({ jsonrpc: '2.0', id: msg.id, result })
      })
      .catch((err) => {
        if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: err.code ?? -32000, message: String(err.message || err) } })
      })
  }
})
process.stdin.on('end', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
