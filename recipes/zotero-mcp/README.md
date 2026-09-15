# zotero-mcp —— Zotero 文献库读写 MCP 服务

**读走 SQLite 快照，写走官方 Web API。** 这是在四条可能的通道都实测过之后选出来的组合。

| | |
|---|---|
| **适用场景** | 要让 Agent 检索 / 录入 / 整理 Zotero 文献库 |
| **依赖** | **Node 22+**（用到内置 `node:sqlite`）。**零第三方依赖** |
| **文件** | `zotero-mcp.mjs`（单文件，663 行） |
| **工具数** | 14 个 |

→ 完整推理过程：`lessons/10-zotero-automation.md`

---

## 你要改的地方

**① 源码常量** —— 在 `zotero-mcp.mjs` 顶部

| 常量 | 默认值 | 说明 |
|---|---|---|
| `DATA_DIR` | `~/Zotero` | Zotero 数据目录 |
| `KEY_FILE` | `~/.dsh/zotero-key` | Web API key 文件 |
| `LIBRARY_SCOPE` | `'user'` | `user`（个人库）或 `groups/<groupID>` |
| `LOCAL_BASE` | `http://127.0.0.1:23119` | Zotero 连接器端口。**改 Zotero 设置时这里要跟着改** |

**② 环境变量** —— 覆盖上面的常量，**不用改源码**

| 变量 | 覆盖谁 | 默认 | 说明 |
|---|---|---|---|
| `ZOTERO_DATA_DIR` | `DATA_DIR` | `~/Zotero` | 数据目录（含 `zotero.sqlite` 与 `storage/`） |
| `ZOTERO_API_KEY_FILE` | `KEY_FILE` | `~/.dsh/zotero-key` | key 文件，单行 |
| `ZOTERO_API_KEY` | — | — | key 字面量（**优先于文件**，适合临时调试，别写进脚本） |
| `ZOTERO_LIBRARY` | `LIBRARY_SCOPE` | `user` | 库范围 |

> ⚠️ 源码常量名（`LIBRARY_SCOPE`）与你能设的环境变量名（`ZOTERO_LIBRARY`）**不是同一个字符串**。
> 前者是 JS 变量，后者是它的覆盖入口。

**key 至少需要 `write` / `files` / `notes` 权限**，只读 key 无法执行写工具。

---

## 工具清单

**读（走 SQLite 快照）**：`zotero_status` · `zotero_search` · `zotero_recent` · `zotero_item` ·
`zotero_collections` · `zotero_tags` · `zotero_fulltext` · `zotero_pdf`

**写（走官方 Web API）**：`zotero_create_item` · `zotero_update_item` · `zotero_create_collection` ·
`zotero_add_note` · `zotero_delete_item`

**账号**：`zotero_whoami`

---

## 三条关键设计（都在 lesson 里有详述）

### ① 读：复制快照，不碰原库

Zotero 运行时**独占锁住** `zotero.sqlite` → 直接读会 `database is locked`，
而且 `busyTimeout` **救不了**（对端根本不释放）。

**做法**：把 `zotero.sqlite`（**以及 WAL 模式下的 `-wal` / `-shm`**）复制到临时目录再打开副本。
好处是 **Zotero 开着关着都能用**。

### ② 写：走 `api.zotero.org`

本地 API 即便打开也**只读**（`PUT`/`DELETE`/`PATCH` 全 501）；连接器接口只能**新增**。
所以修改现有条目只能走官方 Web API。

注意它有**版本号语义**：冲突返回 **412**，正确处理是**重新取最新版本再改**，而不是盲目重试。

### ③ `dryRun` 预览

`zotero_create_item` 支持 `dryRun=true`：**只返回"我准备写入什么"，不真写**。
新增文献前先 dry-run 一遍，是零成本的防呆。

---

## 注册

```jsonc
{
  "serverName": "zotero",
  "command": "node",
  "args": ["/absolute/path/to/zotero-mcp.mjs"],
  "env": {
    "ZOTERO_DATA_DIR": "/absolute/path/to/Zotero",
    "ZOTERO_API_KEY_FILE": "/absolute/path/to/zotero-key"
  }
}
```

---

## 验证

- [ ] `zotero_status` 报告库文件存在、条目数合理
- [ ] **Zotero 正开着**的时候 `zotero_search` 能返回结果（不是 0 条、不报错）
- [ ] 拿一个**你确定库里有的关键词**搜索，**断言结果非空**
      ← 这一步专门用来抓"索引建错导致永远返回空"的静默 bug（见 lesson 第 7 节）
- [ ] `zotero_fulltext` 命中医已知文本
- [ ] `zotero_create_item` 先 `dryRun=true` 看预览，再真写**一条测试条目**
- [ ] 写完之后**回到 Zotero 客户端界面确认它真的出现了**（不要只看 API 返回 200）
- [ ] 凭据文件权限仅当前用户可读

---

## 已知限制

- **附件上传没实现**。要挂 PDF 得在客户端操作，或者自己补 Web API 的文件上传流程。
- 需要 Node 22+ 的 `node:sqlite`（实验性 API）。老 Node 需要换 `better-sqlite3`。
- 本地 API 通道**没有启用**（评估后认为收益不抵成本，见 lesson 第 3 节）。
- 批量写操作会受官方 API 速率限制。**建议一次别改太多**，并做节流。
- ⚠️ **文献库属于个人资料**：不要把库内容、分类结构、研究主题复制到任何公开仓库或 issue。
  `zotero_status` 的输出在贴给别人之前请先脱敏。
