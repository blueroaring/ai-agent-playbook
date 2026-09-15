#!/usr/bin/env node
/**
 * zotero-mcp — 最小的 stdio MCP 服务：把本机 Zotero 文献库暴露成 DSH 原生工具。
 *
 * 为什么自建：
 *   - Zotero 本地 API 默认关闭，而且**只读**（PUT/DELETE/PATCH 全 501）；改现有条目必须走 Web API。
 *   - Zotero 运行时 SQLite 被独占锁住，直接读会 `database is locked` →
 *     读操作改为“复制快照再读副本”，Zotero 开着关着都能用。
 *   - 零依赖：只用 Node 内置模块（node:sqlite / fetch），不引第三方包，API key 不经过外部代码。
 *
 * 凭据：Zotero Web API key（单行）放 $ZOTERO_API_KEY_FILE，默认 ~/.dsh/zotero-key；
 *       也可用环境变量 ZOTERO_API_KEY。缺失时读功能照常，写功能会给出明确提示。
 *
 * 环境变量：
 *   ZOTERO_DATA_DIR      默认 C:\Users\<user>\Zotero
 *   ZOTERO_LIBRARY       默认 user；可写 groups/<groupID>
 *   ZOTERO_API_KEY_FILE  默认 ~/.dsh/zotero-key
 */

import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const VERSION = '0.1.0'
const DATA_DIR = process.env.ZOTERO_DATA_DIR || join(homedir(), 'Zotero')
const DB_PATH = join(DATA_DIR, 'zotero.sqlite')
const STORAGE_DIR = join(DATA_DIR, 'storage')
const KEY_FILE = process.env.ZOTERO_API_KEY_FILE || join(homedir(), '.dsh', 'zotero-key')
const LOCAL_BASE = 'http://127.0.0.1:23119'
const API_BASE = 'https://api.zotero.org'
const LIBRARY_SCOPE = process.env.ZOTERO_LIBRARY || 'user'
const EXCLUDE_TYPES = "('attachment','note','annotation')"

// ---------------------------------------------------------------- 基础工具

const readKey = () => {
  const env = (process.env.ZOTERO_API_KEY || '').trim()
  if (env) return env
  try {
    const t = readFileSync(KEY_FILE, 'utf8').trim()
    if (t) return t
  } catch {}
  return null
}

const maskKey = (k) => (k ? `${k.slice(0, 4)}…${k.slice(-4)} (共 ${k.length} 字符)` : '(未配置)')

function snapshotDb() {
  // Zotero 运行时主库被独占；复制副本（含 journal/wal 若有）后读副本。
  const dir = mkdtempSync(join(tmpdir(), 'zotero-snap-'))
  const target = join(dir, 'zotero.sqlite')
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const src = DB_PATH + suffix
    if (existsSync(src)) copyFileSync(src, target + suffix)
  }
  return { dir, file: target }
}

/** 优先直连（Zotero 关闭时可用，零拷贝）；被锁则退回复制快照。 */
function withDb(fn) {
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true, timeout: 1500 })
    db.prepare('SELECT COUNT(*) c FROM items').get()
    try {
      return fn(db)
    } finally {
      db.close()
    }
  } catch {
    const snap = snapshotDb()
    try {
      const db = new DatabaseSync(snap.file, { readOnly: true })
      try {
        return fn(db)
      } finally {
        db.close()
      }
    } finally {
      try { rmSync(snap.dir, { recursive: true, force: true }) } catch {}
    }
  }
}

const SQL_ITEM_IDS = `SELECT i.itemID FROM items i JOIN itemTypes it ON it.itemTypeID=i.itemTypeID
  WHERE it.typeName NOT IN ${EXCLUDE_TYPES} AND i.itemID NOT IN (SELECT itemID FROM deletedItems)`

const SQL_TITLE = `(SELECT idv.value FROM itemData d JOIN itemDataValues idv ON idv.valueID=d.valueID
  JOIN fields f ON f.fieldID=d.fieldID WHERE d.itemID=i.itemID AND f.fieldName='title')`
const SQL_FIELD = (name) => `(SELECT idv.value FROM itemData d JOIN itemDataValues idv ON idv.valueID=d.valueID
  JOIN fields f ON f.fieldID=d.fieldID WHERE d.itemID=i.itemID AND f.fieldName='${name}')`
const SQL_DATE = `(SELECT idv.value FROM itemData d JOIN itemDataValues idv ON idv.valueID=d.valueID
  JOIN fields f ON f.fieldID=d.fieldID WHERE d.itemID=i.itemID AND f.fieldName='date')`
const SQL_CREATORS = `(SELECT GROUP_CONCAT(
    CASE WHEN c.fieldMode=1 THEN c.lastName
         ELSE TRIM(COALESCE(c.firstName,'') || ' ' || COALESCE(c.lastName,'')) END, '; ')
  FROM itemCreators ic JOIN creators c ON c.creatorID=ic.creatorID
  WHERE ic.itemID=i.itemID)`

function rowsOf(db, sql, ...params) {
  try { return db.prepare(sql).all(...params) } catch (e) { throw new Error(`SQL 失败: ${String(e.message).slice(0, 200)}`) }
}

function compactItems(db, ids) {
  if (!ids.length) return []
  const placeholders = ids.map(() => '?').join(',')
  const rows = rowsOf(db, `
    SELECT i.itemID, i.key, it.typeName AS itemType, ${SQL_TITLE} AS title, ${SQL_CREATORS} AS creators,
           ${SQL_FIELD('date')} AS date, ${SQL_FIELD('publicationTitle')} AS venue,
           ${SQL_FIELD('proceedingsTitle')} AS proceedings, ${SQL_FIELD('DOI')} AS doi,
           ${SQL_FIELD('abstractNote')} AS abstract, i.dateModified
      FROM items i JOIN itemTypes it ON it.itemTypeID=i.itemTypeID
     WHERE i.itemID IN (${placeholders})`, ...ids)
  const byId = new Map(rows.map((r) => [r.itemID, r]))
  const tagStmt = db.prepare(`SELECT t.name FROM itemTags it JOIN tags t ON t.tagID=it.tagID WHERE it.itemID=?`)
  const colStmt = db.prepare(`SELECT c.collectionName FROM collectionItems ci JOIN collections c ON c.collectionID=ci.collectionID WHERE ci.itemID=?`)
  const attStmt = db.prepare(`SELECT COUNT(*) n FROM itemAttachments ia JOIN items a ON a.itemID=ia.itemID
      WHERE ia.parentItemID=? AND ia.contentType='application/pdf' AND a.itemID NOT IN (SELECT itemID FROM deletedItems)`)
  const noteStmt = db.prepare(`SELECT COUNT(*) n FROM itemNotes WHERE parentItemID=?`)
  return ids.map((id) => byId.get(id)).filter(Boolean).map((r) => ({
    key: r.key,
    itemType: r.itemType,
    title: r.title ?? '(无标题)',
    creators: (r.creators || '').slice(0, 120),
    year: (r.date || '').slice(0, 4) || null,
    venue: r.venue || r.proceedings || null,
    doi: r.doi || null,
    tags: tagStmt.all(r.itemID).map((t) => t.name),
    collections: colStmt.all(r.itemID).map((c) => c.collectionName),
    pdfs: attStmt.get(r.itemID).n,
    notes: noteStmt.get(r.itemID).n,
    modified: (r.dateModified || '').slice(0, 10),
    _itemID: r.itemID,
    _abstract: r.abstract || '',
  }))
}

function stripInternal(items) {
  return items.map(({ _itemID, _abstract, ...rest }) => rest)
}

function resolveCollectionIds(db, nameOrKey, includeChildren = true) {
  const found = rowsOf(db, 'SELECT collectionID, collectionName, key FROM collections WHERE collectionName=? OR key=?', nameOrKey, nameOrKey)
  if (!found.length) return []
  if (!includeChildren) return found.map((f) => f.collectionID)
  const all = rowsOf(db, 'SELECT collectionID, parentCollectionID FROM collections')
  const result = new Set(found.map((f) => f.collectionID))
  let added = true
  while (added) {
    added = false
    for (const c of all) {
      if (c.parentCollectionID && result.has(c.parentCollectionID) && !result.has(c.collectionID)) {
        result.add(c.collectionID)
        added = true
      }
    }
  }
  return [...result]
}

// ---------------------------------------------------------------- Web API

async function api(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const key = readKey()
  if (!key) throw new Error(`未配置 Zotero API key。请把 key 写入 ${KEY_FILE}（单行），或设置环境变量 ZOTERO_API_KEY。申请：https://www.zotero.org/settings/keys/new`)
  const res = await fetch(API_BASE + path, {
    method,
    headers: {
      'Zotero-API-Key': key,
      'Zotero-API-Version': '3',
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Zotero API HTTP ${res.status}：${text.slice(0, 400)}`)
  return raw ? { text, res } : text ? JSON.parse(text) : null
}

let cachedLibrary = null
async function libraryPath() {
  if (LIBRARY_SCOPE !== 'user') return `/${LIBRARY_SCOPE}`
  if (cachedLibrary) return `/users/${cachedLibrary}`
  const info = await api('/keys/current')
  cachedLibrary = info.userID
  return `/users/${cachedLibrary}`
}

// ---------------------------------------------------------------- 元数据抓取

function crossrefToZotero(m) {
  const typeMap = {
    'journal-article': 'journalArticle',
    'proceedings-article': 'conferencePaper',
    'posted-content': 'preprint',
    'book-chapter': 'bookSection',
    book: 'book',
    monograph: 'book',
    report: 'report',
    dissertation: 'thesis',
    dataset: 'dataset',
    component: 'journalArticle',
  }
  const itemType = typeMap[m.type] || 'journalArticle'
  const creators = (m.author || m.editor || []).map((a) => ({
    creatorType: 'author',
    firstName: a.given || '',
    lastName: a.family || a.name || '',
  })).filter((c) => c.lastName || c.firstName)
  const dp = m.issued?.['date-parts']?.[0] || m.published?.['date-parts']?.[0]
  const date = dp ? dp.filter((x) => x != null).join('-') : ''
  const item = {
    itemType,
    title: (m.title || [''])[0],
    creators,
    abstractNote: m.abstract ? String(m.abstract).replace(/<[^>]+>/g, '').slice(0, 4000) : '',
    date,
    DOI: m.DOI || '',
    url: m.URL || (m.DOI ? `https://doi.org/${m.DOI}` : ''),
    tags: [],
    collections: [],
    extra: `Crossref type: ${m.type || 'unknown'}${m.publisher ? ` | publisher: ${m.publisher}` : ''}`,
  }
  const container = (m['container-title'] || [])[0] || ''
  const shortContainer = (m['short-container-title'] || [])[0] || ''
  if (itemType === 'conferencePaper') {
    item.proceedingsTitle = container
    item.conferenceName = m.event?.name || ''
    item.place = m.event?.location || ''
    item.publisher = m.publisher || ''
  } else if (itemType === 'preprint') {
    item.repository = m.institution?.[0]?.name || 'Other'
    item.archiveID = m.DOI || ''
  } else if (itemType === 'bookSection') {
    item.bookTitle = container
    item.publisher = m.publisher || ''
  } else {
    item.publicationTitle = container
    item.journalAbbreviation = shortContainer
    item.volume = m.volume || ''
    item.issue = m.issue || ''
    item.pages = m.page || ''
    item.publisher = m.publisher || ''
    item.ISSN = (m.ISSN || []).join(', ')
  }
  return item
}

async function fetchDoi(doi) {
  const clean = String(doi).trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
  const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(clean)}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'dsh-zotero-mcp/0.1 (mailto:noreply@example.com)' },
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`Crossref HTTP ${res.status}：找不到 DOI ${clean}`)
  const json = await res.json()
  const item = crossrefToZotero(json.message)
  item.extra = `${item.extra} | Crossref score: ${json.message.score ?? ''}`.trim()
  return item
}

function parseArxivXml(xml) {
  const pick = (tag) => {
    const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))
    return m ? m[1].replace(/\s+/g, ' ').trim() : ''
  }
  const authors = [...xml.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((m) => ({
    creatorType: 'author',
    firstName: m[1].trim().split(' ').slice(0, -1).join(' '),
    lastName: m[1].trim().split(' ').slice(-1)[0],
  }))
  const id = pick('id')
  const arxivId = (id.match(/abs\/([^v\s]+)/) || [])[1] || ''
  const published = pick('published').slice(0, 10)
  const journalRef = pick('journal_ref')
  const doi = pick('doi')
  const item = {
    itemType: 'preprint',
    title: pick('title'),
    creators: authors,
    abstractNote: pick('summary'),
    date: published,
    repository: 'arXiv',
    archiveID: `arXiv:${arxivId}`,
    url: id,
    DOI: doi,
    extra: journalRef ? `arXiv journal_ref: ${journalRef}` : '',
    tags: [],
    collections: [],
  }
  if (journalRef) {
    // 已正式发表：按期刊论文录入更合适
    item.itemType = 'journalArticle'
    item.publicationTitle = journalRef
    item.extra = `arXiv: ${arxivId}`
  }
  return item
}

async function fetchArxiv(idOrUrl) {
  const id = String(idOrUrl).trim().replace(/^https?:\/\/arxiv\.org\/(abs|pdf)\//i, '').replace(/\.pdf$/i, '')
  const res = await fetch(`http://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error(`arXiv HTTP ${res.status}`)
  const xml = await res.text()
  const entry = (xml.match(/<entry>([\s\S]*?)<\/entry>/) || [])[1]
  if (!entry) throw new Error(`arXiv 未找到条目：${id}`)
  return parseArxivXml(entry)
}

// ---------------------------------------------------------------- 工具实现

const tools = {
  async zotero_status() {
    const key = readKey()
    const out = {
      数据目录: DATA_DIR,
      库文件: existsSync(DB_PATH) ? `${(statSync(DB_PATH).size / 1048576).toFixed(1)} MB，修改于 ${statSync(DB_PATH).mtime.toISOString().slice(0, 19)}` : '不存在',
      Zotero是否运行: await (async () => {
        try {
          const r = await fetch(`${LOCAL_BASE}/connector/ping`, { signal: AbortSignal.timeout(3000) })
          return r.ok ? '是（连接器可用）' : `否（HTTP ${r.status}）`
        } catch { return '否' }
      })(),
      API密钥: maskKey(key),
      库范围: LIBRARY_SCOPE,
    }
    try {
      out.统计 = withDb((db) => {
        const one = (sql) => Object.values(db.prepare(sql).get() ?? {})[0]
        return {
          文献条目: one(`SELECT COUNT(*) FROM (${SQL_ITEM_IDS})`),
          附件: one('SELECT COUNT(*) FROM itemAttachments'),
          笔记: one(`SELECT COUNT(*) FROM items i JOIN itemTypes it ON it.itemTypeID=i.itemTypeID WHERE it.typeName='note'`),
          分类: one('SELECT COUNT(*) FROM collections'),
          标签: one('SELECT COUNT(*) FROM tags'),
          已索引PDF全文: one('SELECT COUNT(*) FROM fulltextItems'),
        }
      })
    } catch (e) {
      out.统计 = `读取失败：${e.message}`
    }
    return out
  },

  async zotero_search({ query = null, tag = null, collection = null, itemType = null, yearFrom = null, yearTo = null, limit = 20 }) {
    return withDb((db) => {
      const where = [`i.itemID IN (${SQL_ITEM_IDS})`]
      const params = []
      if (query) {
        const like = `%${query}%`
        where.push(`(i.itemID IN (
            SELECT d.itemID FROM itemData d JOIN itemDataValues idv ON idv.valueID=d.valueID
              JOIN fields f ON f.fieldID=d.fieldID
             WHERE f.fieldName IN ('title','abstractNote','publicationTitle','proceedingsTitle','extra','DOI') AND idv.value LIKE ?)
          OR i.itemID IN (
            SELECT ic.itemID FROM itemCreators ic JOIN creators c ON c.creatorID=ic.creatorID
             WHERE (COALESCE(c.lastName,'') || ' ' || COALESCE(c.firstName,'')) LIKE ?))`)
        params.push(like, like)
      }
      if (tag) {
        where.push(`i.itemID IN (SELECT it.itemID FROM itemTags it JOIN tags t ON t.tagID=it.tagID WHERE t.name LIKE ?)`)
        params.push(`%${tag}%`)
      }
      if (collection) {
        const ids = resolveCollectionIds(db, collection)
        if (!ids.length) return { 结果: '没有找到该分类', 查询: collection }
        where.push(`i.itemID IN (SELECT itemID FROM collectionItems WHERE collectionID IN (${ids.map(() => '?').join(',')}))`)
        params.push(...ids)
      }
      if (itemType) {
        where.push('it.typeName = ?')
        params.push(itemType)
      }
      if (yearFrom || yearTo) {
        const yearExpr = `CAST(substr(${SQL_FIELD('date')},1,4) AS INTEGER)`
        if (yearFrom) { where.push(`${yearExpr} >= ?`); params.push(Number(yearFrom)) }
        if (yearTo) { where.push(`${yearExpr} <= ?`); params.push(Number(yearTo)) }
      }
      const sql = `SELECT i.itemID FROM items i JOIN itemTypes it ON it.itemTypeID=i.itemTypeID
                    WHERE ${where.join(' AND ')} ORDER BY i.dateModified DESC LIMIT ?`
      const ids = rowsOf(db, sql, ...params, Math.max(1, Math.min(200, limit))).map((r) => r.itemID)
      return stripInternal(compactItems(db, ids))
    })
  },

  async zotero_recent({ days = 30, mode = 'modified', limit = 20 }) {
    return withDb((db) => {
      const col = mode === 'added' ? 'dateAdded' : 'dateModified'
      const ids = rowsOf(db, `SELECT i.itemID FROM items i JOIN itemTypes it ON it.itemTypeID=i.itemTypeID
          WHERE i.itemID IN (${SQL_ITEM_IDS}) AND ${col} >= datetime('now', ?)
          ORDER BY ${col} DESC LIMIT ?`, `-${Math.max(1, days)} days`, Math.max(1, Math.min(200, limit))).map((r) => r.itemID)
      return stripInternal(compactItems(db, ids))
    })
  },

  async zotero_item({ key }) {
    return withDb((db) => {
      const row = rowsOf(db, `SELECT i.itemID, i.key FROM items i WHERE i.key = ? OR i.itemID = ?`, key, Number(key) || -1)[0]
      if (!row) return { 结果: '没有找到该条目', key }
      const fields = rowsOf(db, `SELECT f.fieldName, idv.value FROM itemData d
          JOIN itemDataValues idv ON idv.valueID=d.valueID JOIN fields f ON f.fieldID=d.fieldID
         WHERE d.itemID=?`, row.itemID)
      const item = stripInternal(compactItems(db, [row.itemID]))[0]
      const creators = rowsOf(db, `SELECT c.firstName, c.lastName, ct.creatorType FROM itemCreators ic
          JOIN creators c ON c.creatorID=ic.creatorID JOIN creatorTypes ct ON ct.creatorTypeID=ic.creatorTypeID
         WHERE ic.itemID=? ORDER BY ic.orderIndex`, row.itemID)
      const attachments = rowsOf(db, `SELECT a.key, ia.contentType, ia.path, ia.linkMode FROM itemAttachments ia
          JOIN items a ON a.itemID=ia.itemID WHERE ia.parentItemID=?`, row.itemID)
      const notes = rowsOf(db, `SELECT n.note, n.title FROM itemNotes n WHERE n.parentItemID=?`, row.itemID)
      const resolvePath = (att) => {
        if (!att.path) return null
        return att.path.startsWith('storage:') ? join(STORAGE_DIR, att.key, att.path.slice(8)) : att.path
      }
      return {
        ...item,
        字段: Object.fromEntries(fields.map((f) => [f.fieldName, f.value])),
        作者: creators.map((c) => `${c.creatorType}: ${[c.firstName, c.lastName].filter(Boolean).join(' ')}`),
        附件: attachments.map((a) => ({
          类型: a.contentType,
          文件: resolvePath(a),
          存在: resolvePath(a) ? existsSync(resolvePath(a)) : false,
        })),
        笔记: notes.map((n) => ({ 标题: n.title || null, 内容: String(n.note || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 800) })),
      }
    })
  },

  async zotero_collections() {
    return withDb((db) => {
      const all = rowsOf(db, `SELECT c.collectionID, c.key, c.collectionName, c.parentCollectionID,
          (SELECT COUNT(*) FROM collectionItems ci WHERE ci.collectionID=c.collectionID) n FROM collections c`)
      const byParent = new Map()
      for (const c of all) {
        const p = c.parentCollectionID ?? 0
        if (!byParent.has(p)) byParent.set(p, [])
        byParent.get(p).push(c)
      }
      const render = (parentId, depth) => {
        const out = []
        for (const c of (byParent.get(parentId) || []).sort((a, b) => b.n - a.n)) {
          out.push({ 名称: `${'  '.repeat(depth)}${c.collectionName}`, key: c.key, 条目数: c.n })
          out.push(...render(c.collectionID, depth + 1))
        }
        return out
      }
      return { 分类数: all.length, 分类: render(0, 0) }
    })
  },

  async zotero_tags({ limit = 60 }) {
    return withDb((db) => rowsOf(db, `SELECT t.name, COUNT(it.itemID) n FROM tags t
        LEFT JOIN itemTags it ON it.tagID=t.tagID
       GROUP BY t.tagID ORDER BY n DESC LIMIT ?`, Math.max(1, Math.min(500, limit))))
  },

  async zotero_fulltext({ query, limit = 15 }) {
    const words = String(query).toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || []
    if (!words.length) throw new Error('query 必须包含至少一个长度 ≥3 的英文词（Zotero 全文索引按词存储）')
    return withDb((db) => {
      const ph = words.map(() => '?').join(',')
      const hits = rowsOf(db, `SELECT fiw.itemID AS attItemID, COUNT(*) AS hits
          FROM fulltextItemWords fiw JOIN fulltextWords fw ON fw.wordID=fiw.wordID
         WHERE fw.word IN (${ph})
         GROUP BY fiw.itemID HAVING COUNT(DISTINCT fw.word) = ? ORDER BY hits DESC LIMIT ?`, ...words, words.length, Math.max(1, Math.min(50, limit)))
      if (!hits.length) return { 查询: words, 命中: 0 }
      const attToParent = new Map(rowsOf(db, `SELECT itemID, parentItemID FROM itemAttachments WHERE itemID IN (${hits.map(() => '?').join(',')})`, ...hits.map((h) => h.attItemID)).map((r) => [r.itemID, r.parentItemID]))
      const parentIds = [...new Set(hits.map((h) => attToParent.get(h.attItemID) ?? h.attItemID))]
      // 注意：先建映射（compactItems 保留 _itemID），再剥离内部字段，否则查不到条目。
      const byParent = new Map(compactItems(db, parentIds).map((i) => [i._itemID, i]))
      const hitMap = new Map()
      for (const h of hits) {
        const pid = attToParent.get(h.attItemID) ?? h.attItemID
        hitMap.set(pid, (hitMap.get(pid) || 0) + h.hits)
      }
      return {
        查询: words,
        命中: byParent.size,
        结果: parentIds
          .filter((pid) => byParent.has(pid))
          .map((pid) => {
            const { _itemID, _abstract, ...rest } = byParent.get(pid)
            return { ...rest, 词频: hitMap.get(pid) }
          }),
      }
    })
  },

  async zotero_pdf({ key }) {
    return withDb((db) => {
      const row = rowsOf(db, 'SELECT itemID, key FROM items WHERE key=? OR itemID=?', key, Number(key) || -1)[0]
      if (!row) return { 结果: '没有找到该条目', key }
      const atts = rowsOf(db, `SELECT a.key, ia.path, ia.contentType FROM itemAttachments ia JOIN items a ON a.itemID=ia.itemID
         WHERE ia.parentItemID=? AND ia.contentType='application/pdf'`, row.itemID)
      return atts.map((a) => {
        const file = a.path?.startsWith('storage:') ? join(STORAGE_DIR, a.key, a.path.slice(8)) : a.path
        return { 附件key: a.key, 路径: file, 存在: file ? existsSync(file) : false, 大小MB: file && existsSync(file) ? +(statSync(file).size / 1048576).toFixed(2) : null }
      })
    })
  },

  // ---- 写入：Web API ----

  async zotero_whoami() {
    const info = await api('/keys/current')
    return {
      用户名: info.username,
      userID: info.userID,
      密钥: maskKey(readKey()),
      权限: info.access,
      库范围: LIBRARY_SCOPE,
    }
  },

  async zotero_create_item({ doi = null, arxiv = null, metadata = null, collections = [], tags = [], dryRun = false }) {
    let item = null
    let source = null
    if (doi) { item = await fetchDoi(doi); source = `Crossref DOI ${doi}` }
    else if (arxiv) { item = await fetchArxiv(arxiv); source = `arXiv ${arxiv}` }
    else if (metadata) { item = { itemType: 'journalArticle', creators: [], tags: [], collections: [], ...metadata }; source = '手工元数据' }
    else throw new Error('必须提供 doi、arxiv 或 metadata 之一')
    if (collections.length) item.collections = collections
    if (tags.length) item.tags = tags.map((t) => ({ tag: String(t) }))
    for (const k of Object.keys(item)) if (item[k] === '' || item[k] === null) delete item[k]
    if (dryRun) return { 预览: true, 来源: source, 将创建: item }
    const lib = await libraryPath()
    const res = await api(`${lib}/items`, { method: 'POST', body: [item] })
    const ok = res.successful?.['0']
    const bad = res.failed?.['0']
    if (!ok) return { 结果: '创建失败', 失败原因: bad, 提交内容: item }
    return { 结果: '已创建', key: ok.key, 版本: ok.version, 标题: item.title, 来源: source, 类型: item.itemType, 后续: `如需归入分类/加标签，可用 zotero_update_item {key:"${ok.key}", addToCollections:[...], addTags:[...]}` }
  },

  async zotero_update_item({ key, fields = null, addTags = [], removeTags = [], addToCollections = [], removeFromCollections = [] }) {
    const lib = await libraryPath()
    const current = await api(`${lib}/items/${key}`)
    const patch = {}
    if (fields) Object.assign(patch, fields)
    const wanted = new Set((current.data.tags || []).map((t) => t.tag))
    for (const t of addTags) wanted.add(String(t))
    for (const t of removeTags) wanted.delete(String(t))
    if (addTags.length || removeTags.length) patch.tags = [...wanted].map((t) => ({ tag: t }))
    const cols = new Set(current.data.collections || [])
    for (const c of addToCollections) cols.add(c)
    for (const c of removeFromCollections) cols.delete(c)
    if (addToCollections.length || removeFromCollections.length) patch.collections = [...cols]
    if (!Object.keys(patch).length) return { 结果: '没有需要修改的内容' }
    const res = await api(`${lib}/items/${key}`, {
      method: 'PATCH',
      body: patch,
      headers: { 'If-Unmodified-Since-Version': String(current.version) },
    })
    return { 结果: '已更新', key, 版本: res?.version ?? res, 改动: Object.keys(patch) }
  },

  async zotero_create_collection({ name, parentCollection = null }) {
    const lib = await libraryPath()
    const body = { name }
    if (parentCollection) body.parentCollection = parentCollection
    const res = await api(`${lib}/collections`, { method: 'POST', body: [body] })
    const ok = res.successful?.['0']
    return ok ? { 结果: '已创建分类', key: ok.key, 名称: name } : { 结果: '创建失败', 失败原因: res.failed?.['0'] }
  },

  async zotero_add_note({ parentKey, note, tags = [] }) {
    const lib = await libraryPath()
    const html = /<[a-z][\s\S]*>/i.test(note) ? note : `<p>${String(note).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br/>')}</p>`
    const res = await api(`${lib}/items`, { method: 'POST', body: [{ itemType: 'note', parentItem: parentKey, note: html, tags: tags.map((t) => ({ tag: t })) }] })
    const ok = res.successful?.['0']
    return ok ? { 结果: '笔记已添加', key: ok.key, 父条目: parentKey } : { 结果: '添加失败', 失败原因: res.failed?.['0'] }
  },

  async zotero_delete_item({ key, confirm = false }) {
    if (!confirm) throw new Error('删除需显式确认：请传 confirm=true。条目会进入 Zotero 回收站（可恢复），不是永久删除。')
    const lib = await libraryPath()
    const current = await api(`${lib}/items/${key}`)
    await api(`${lib}/items/${key}`, {
      method: 'DELETE',
      headers: { 'If-Unmodified-Since-Version': String(current.version) },
      raw: true,
    })
    return { 结果: '已移入回收站', key, 标题: current.data.title }
  },
}

const SPECS = [
  ['zotero_status', '体检：Zotero 是否运行、库文件与统计、API key 是否配置（掩码）、库范围。', {}],
  ['zotero_search', '检索文献库（标题/摘要/期刊/DOI/作者模糊匹配），可按标签、分类、类型、年份过滤。', { query: { type: 'string' }, tag: { type: 'string' }, collection: { type: 'string', description: '分类名或分类 key（含子分类）' }, itemType: { type: 'string', description: '如 journalArticle / conferencePaper / preprint' }, yearFrom: { type: 'number' }, yearTo: { type: 'number' }, limit: { type: 'number', description: '默认 20，上限 200' } }],
  ['zotero_recent', '最近新增或修改的条目。', { days: { type: 'number', description: '默认 30' }, mode: { type: 'string', enum: ['added', 'modified'] }, limit: { type: 'number' } }],
  ['zotero_item', '读单个条目的完整信息：全部字段、作者、标签、分类、附件路径（含 PDF 是否存在）、子笔记。', { key: { type: 'string', description: '条目 key 或 itemID' } }, { required: ['key'] }],
  ['zotero_collections', '列出分类树（含各自的条目数）。', {}],
  ['zotero_tags', '列出标签及使用次数。', { limit: { type: 'number' } }],
  ['zotero_fulltext', '在 PDF 全文索引里搜索（Zotero 已抽取的文本，按词匹配，支持多词 AND）。', { query: { type: 'string' }, limit: { type: 'number' } }, { required: ['query'] }],
  ['zotero_pdf', '定位某条目的 PDF 附件在磁盘上的真实路径。', { key: { type: 'string' } }, { required: ['key'] }],
  ['zotero_whoami', '用本机 API key 查询 Zotero 账号与写权限。', {}],
  ['zotero_create_item', '新建条目：给 DOI 走 Crossref、给 arXiv 走 arXiv，或直接给 metadata。可同时归入分类、加标签；dryRun=true 只预览不写入。', { doi: { type: 'string' }, arxiv: { type: 'string' }, metadata: { type: 'object', description: 'Zotero 条目字段对象，至少含 itemType 与 title' }, collections: { type: 'array', items: { type: 'string' }, description: '分类 key 列表' }, tags: { type: 'array', items: { type: 'string' } }, dryRun: { type: 'boolean' } }],
  ['zotero_update_item', '修改现有条目：改字段、加/删标签、加/移分类（自动处理版本号冲突）。', { key: { type: 'string' }, fields: { type: 'object', description: '要改的字段，如 {"title":"新标题"}' }, addTags: { type: 'array', items: { type: 'string' } }, removeTags: { type: 'array', items: { type: 'string' } }, addToCollections: { type: 'array', items: { type: 'string' }, description: '分类 key' }, removeFromCollections: { type: 'array', items: { type: 'string' } } }, { required: ['key'] }],
  ['zotero_create_collection', '新建分类，可指定父分类 key。', { name: { type: 'string' }, parentCollection: { type: 'string' } }, { required: ['name'] }],
  ['zotero_add_note', '给条目加子笔记（纯文本会自动包 HTML）。', { parentKey: { type: 'string' }, note: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, { required: ['parentKey', 'note'] }],
  ['zotero_delete_item', '把条目移入回收站（可恢复）。必须显式 confirm=true。', { key: { type: 'string' }, confirm: { type: 'boolean' } }, { required: ['key'] }],
].map(([name, description, properties, extra]) => ({
  name,
  description,
  inputSchema: { type: 'object', properties, additionalProperties: false, ...(extra ?? {}) },
}))

// ---------------------------------------------------------------- MCP 协议

function send(msg) { process.stdout.write(`${JSON.stringify(msg)}\n`) }

async function handle(msg) {
  const { method, params } = msg
  if (method === 'initialize') {
    return { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'zotero-mcp', version: VERSION } }
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
  if (!file || !existsSync(file)) { console.error('用法: node zotero-mcp.mjs --selftest <requests.jsonl>'); process.exit(2) }
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const clean = line.replace(/^\uFEFF/, '').trim()
    if (!clean) continue
    const msg = JSON.parse(clean)
    try {
      const result = await handle(msg)
      console.log(`### ${msg.id} ${msg.method ?? msg.params?.name}\n${JSON.stringify(result, null, 2)}\n`)
    } catch (err) {
      console.log(`### ${msg.id} ${msg.method ?? msg.params?.name} → 抛错: ${String(err.message || err)}\n`)
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
