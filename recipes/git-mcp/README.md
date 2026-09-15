# git-mcp —— Git / GitHub 的 MCP 服务

在**沙箱里 `git push` 必然失败**的环境下，仍然拥有完整的 git 与 GitHub 能力。

| | |
|---|---|
| **适用场景** | Agent 沙箱禁止管道 stdio / 不能启动工作区外程序，但你需要提交与推送 |
| **依赖** | Node 18+、`git`。**零第三方依赖** |
| **文件** | `git-mcp.mjs`（单文件） |
| **工具数** | 13 个 |

→ 为什么需要它：`lessons/03-sandbox-stdio-limits.md`

---

## 你要改的地方

| 位置 | 改成什么 |
|---|---|
| `TOKEN_FILE` 默认值 | 现在是 `~/.dsh/github-token`。改成 `~/.<yourapp>/github-token` 或直接用 `GITHUB_TOKEN` 环境变量 |
| `DEFAULT_CWD` | `cwd` 参数省略时用哪个仓库。建议显式设置 `GIT_MCP_DEFAULT_CWD`，**别依赖 `process.cwd()`** |
| `GIT_CANDIDATES` | git 的候选路径。默认已含 PATH 与 Windows 常见安装位置 |

### 环境变量

| 变量 | 作用 |
|---|---|
| `GITHUB_TOKEN` / `GH_TOKEN` | 凭据（优先级高于文件） |
| `GITHUB_TOKEN_FILE` | 凭据文件路径，单行 PAT。默认 `~/.dsh/github-token` |
| `GIT_MCP_DEFAULT_CWD` | 默认仓库目录 |
| `GIT_BIN` | 指定 git 可执行文件 |

---

## 工具清单

**本地 git**：`git_status` · `git_diff` · `git_log` · `git_init` · `git_add` · `git_commit` ·
`git_branch` · `git_remote` · `git_push` · `git_pull` · `git_check_auth`

**GitHub API**：`github_whoami` · `github_create_repo`

`git_check_auth` 是个**体检工具**：一次性告诉你 git 在不在、token 配了没（只显示掩码）、
对应哪个账号、远端可达性。**排查认证问题从它开始，不要一上来就 push。**

---

## 凭据是怎么处理的（这部分值得抄）

1. **优先级**：`GITHUB_TOKEN` 环境变量 → `GITHUB_TOKEN_FILE` 文件
2. **绝不回显**：`git_check_auth` 只打印 `gith…4tf3 (共 93 字符)` 这种掩码形式
3. **绝不写进仓库配置**：token **不**写进 `.git/config`、**不**进 URL
4. **绝不进 `argv`**：传给 git 子进程时用**环境变量注入的 git config**：

```js
env: {
  ...process.env,
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'http.extraheader',
  GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
}
```

> **为什么不用 `https://token@github.com/...`**：那会让 token 出现在**进程命令行**里，
> 同机器上的任何进程都能读到（`Get-CimInstance Win32_Process` 就能看到）。
> 环境变量同样对同用户进程可见，但不会进 `git` 的持久配置、不会被 `git remote -v` 打印出来。

---

## 注册

```jsonc
{
  "serverName": "git",
  "command": "node",
  "args": ["/absolute/path/to/git-mcp.mjs"],
  "env": { "GIT_MCP_DEFAULT_CWD": "/absolute/path/to/your/repo" }
}
```

注册后工具名通常暴露为 `mcp__git__<tool>`。

---

## 验证

- [ ] `git_check_auth` → 显示 git 可用、token 已配置（掩码）、账号正确、远端可达
- [ ] `git_status` 在一个真实仓库上返回正确分支与变更
- [ ] `git_init` + `git_add` + `git_commit` 在一个**临时目录**里跑通（别拿真项目试）
- [ ] `git_remote` 设置一个**临时的本地裸仓库**做 push 测试，确认能推上去
- [ ] 确认 `.git/config` 里**没有** token（`Get-Content .git\config`）

**先拿临时裸仓库验证，再对真远端操作。** 这是本库的通用做法。

---

## 已知限制

- `github_create_repo` 用 GitHub REST API，需要 token 具备相应权限（fine-grained token 要勾选仓库创建）。
- **没有实现** GitHub 的 PR / issue / release 操作 —— 需要的话照 `github_create_repo` 的写法加。
- 大文件：GitHub 单文件硬上限 100 MB。**推送前先检查**，否则会在最后一刻失败：

  ```powershell
  Get-ChildItem -Recurse -File | Where-Object { $_.Length -gt 50MB } |
      Select-Object FullName, @{n='MB';e={[math]::Round($_.Length/1MB,1)}}
  ```

- **第三方成品工具/受版权保护的内容不要往公开仓库推**。`.gitignore` 先写好再第一次提交。
- 强推（`forceWithLease`）是**危险操作**，工具要求显式传参。别在自动化里默认打开它。
