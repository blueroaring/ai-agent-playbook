# godot-mcp —— Godot 自动化 MCP 服务（CLI 桥 + 编辑器插件桥）

两种集成形态合在一个服务里，各有明确的适用面。

| | |
|---|---|
| **适用场景** | 让 Agent 建项目、跑测试、录帧验证画面、程序化生成素材、在打开的场景里改节点 |
| **依赖** | Node 18+、Godot 4.x（可选：导出模板） |
| **文件** | `godot-mcp.mjs`、`godot-addon/addons/dsh_bridge/`（编辑器插件，GDScript） |
| **工具数** | 20 个 |

→ 完整实测记录：`lessons/09-godot-automation.md`

---

## 你要改的地方

| 位置 | 改成什么 |
|---|---|
| `GODOT_BIN` | Godot 可执行文件路径。**没设的话服务会去猜**（PATH、Steam 库、常见安装位置） |
| `OUTPUT_DIR` | 录帧/产物目录。默认 `~/.dsh/godot-output` |
| `STEAM_ROOTS` | Steam 库候选根目录。**如果你不是 Steam 版，直接用 `GODOT_BIN` 更省事** |
| `BRIDGE_PORT` | 编辑器桥的起始端口（默认 9080） |

### 环境变量

| 变量 | 说明 |
|---|---|
| `GODOT_BIN` | Godot 可执行文件（**强烈建议显式设置**） |
| `GODOT_PROJECT` | 默认项目目录（省略 `project` 参数时用它） |
| `GODOT_OUTPUT_DIR` | 产物目录 |
| `DSH_GODOT_BRIDGE_PORT` | 编辑器桥起始端口 |

---

## 20 个工具

**CLI 桥（不需要打开编辑器）**

| 工具 | 作用 |
|---|---|
| `godot_status` | 体检：可执行文件、版本、导出模板、默认项目 |
| `godot_projects` | 扫描磁盘找 Godot 项目 |
| `godot_new_project` | 建一个最小可运行项目 |
| `godot_check` | 语法检查（`--check-only`），或整个项目跑几帧抓加载错误 |
| `godot_run` | 运行项目（默认无头，跑 N 帧后退出） |
| `godot_script` | 在项目上下文执行任意 GDScript（**做程序化生成的主力**） |
| `godot_import` | 重新导入资源（**新增素材后必须做**） |
| `godot_export` | 导出（不给 preset 就列出可用预设） |
| `godot_frames` | **Movie Maker 录真实渲染帧**（看画面用） |
| `godot_install_addon` | 把编辑器插件装进项目并启用 |

**编辑器插件桥（需要编辑器开着该项目）**

| 工具 | 作用 |
|---|---|
| `godot_editor_ping` | 心跳：确认插件在、端口是多少 |
| `godot_editor_scene` | 读**当前编辑中**的场景树 |
| `godot_editor_selection` | 读当前选中节点及其常用属性 |
| `godot_editor_node_add` / `_set` / `_delete` | 增 / 改 / 删节点（**全走 UndoRedo，可 Ctrl+Z**） |
| `godot_editor_play` / `_stop` | 在编辑器里运行 / 停止主场景 |
| `godot_editor_reload` | 重新加载当前场景 |
| `godot_editor_save_scene` | 保存当前场景到磁盘 |

---

## 三个必须知道的机制

### ① 无头模式**没有渲染**

`--headless` 能跑逻辑、能抓加载错误，但**不产生真实绘制**。
要"看到画面"必须用 **Movie Maker 录帧**（`godot_frames`）。

**代价：会短暂弹出游戏窗口。** 涉及这个操作前先跟用户说一声。

### ② 端口不要固定，让插件自己挑并**写下来**

`9080` 这类端口**经常被毫不相关的系统服务占用**，而且"能不能连上 HTTP"这种探测方式
**判不出它被占**（占用者不是 web 服务）。

**做法**：插件在 `9080–9090` 里逐个尝试 `bind`，把**实际端口写进 `user://dsh_bridge_port.txt`**，
MCP 侧**优先读这个文件**，读不到才回退到逐个探测。

> 探测是猜测，端口文件是事实。 排端口问题时永远走 TCP 监听表
> （`Get-NetTCPConnection -State Listen`），不要用"能不能访问"来推断"有没有被占"。

### ③ 编辑器插件的每个改动都走 **UndoRedo**

这样用户改错了可以 **Ctrl+Z 撤销**。别绕过它直接改节点 —— 那会让 Agent 的修改与用户的手动修改
混在一起且不可逆，用户就不敢让你碰他的场景了。

---

## 安装

### 1. 注册 MCP 服务

```jsonc
{
  "serverName": "godot",
  "command": "node",
  "args": ["/absolute/path/to/godot-mcp.mjs"],
  "env": {
    "GODOT_BIN": "/absolute/path/to/godot_executable",
    "GODOT_PROJECT": "/absolute/path/to/your/project"
  }
}
```

### 2. 把编辑器插件装进项目

```
工具调用：godot_install_addon({ project: "/path/to/project", enable: true })
```

它会复制 `godot-addon/addons/dsh_bridge/` 到项目的 `addons/` 下并写 `project.godot` 的
`[editor_plugins]`。**装完要在编辑器里启用插件**（或重启编辑器）。

---

## 验证：走完这个闭环

### 阶段一：CLI 桥（不需要编辑器）

- [ ] `godot_status` 报告版本与导出模板
- [ ] `godot_new_project` 建一个示例项目（**别拿正式项目试**）
- [ ] `godot_check` 语法检查通过
- [ ] `godot_run` 无头跑通（退出码 0、无错误摘要）
- [ ] `godot_script` 程序化生成一张 PNG 到 `res://art/`
- [ ] `godot_import` 后该资源可被引用
- [ ] `godot_frames` 录到**真实渲染帧**（打开 PNG 看一眼，确认不是全黑/全白）

### 阶段二：编辑器桥（需要编辑器开着）

- [ ] `godot_editor_ping` 通（**并且它报告的端口与 `user://dsh_bridge_port.txt` 一致**）
- [ ] `godot_editor_node_add` 加一个节点 → `_set` 改属性 → `godot_editor_save_scene`
- [ ] **读磁盘上的 `.tscn`，确认节点真的在里面**（观测面 1：磁盘）
- [ ] `godot_frames` 录帧 → **画面里真的出现了那个东西**（观测面 2：画面）

> 这两个观测面缺一不可 —— 任何一步做错了，后面的面就会露馅。
> 详见 `lessons/01-verification-discipline.md`。

---

## 已知限制

- **导出需要导出模板**，且版本要与编辑器一致。没装模板时 `godot_export` 会失败。
- **`godot_script` 在项目里建 `.dsh_tmp/`** 放临时脚本（点号开头，Godot 不扫描），执行完即删。
  如果进程被强杀，这个目录可能残留 —— 手动删掉即可。
- **Steam 版路径含空格**，调用时注意引号。且"工作区外的可执行文件"在受限沙箱里可能被拒 ——
  这也正是为什么这些事要由宿主侧的 MCP 服务来做。
- 编辑器桥只对**当前打开的项目与场景**有效。多项目切换时要确认 `ping` 的是哪一个。
- `godot_frames` 会**弹窗**，且需要真实 GPU 渲染上下文（无显卡的 CI 环境不适用）。
