# dsh-plan-board

分区计划看板，挂在 DSH Web / 桌面端**右栏**。**一个项目一份 JSON**，所有对话共享同一份。

- **宿主半侧**（`index.js`）：读写 `<boardsDir>/<项目>/<计划>.json`，给每条待办发 `L3` / `S11` 这种短编号，暴露八个只走本机的路由，并注册 agent 工具 `plan_board`。
- **浏览器半侧**（`client.js`）：注册右栏 tab 类型 `plan-board`，顶部下拉切换项目，正文每 3 秒拉一次状态；勾选会回调 `/plan-board/toggle` 立即落盘。
- **agent 半侧**（工具 `plan_board`）：`list` / `read` / `add` / `update` / `toggle`，由宿主进程直接写盘，不受工作区沙箱限制。

## 安装

1. DSH 桌面端 / Web 的侧栏 → **插件** → **添加插件**，填：

   ```
   github:LTeax/dsh-plan-board
   ```

   （也可以装本地目录：`<仓库绝对路径>`。）

2. 装完**完全退出客户端**再打开（宿主半侧要重新加载）。
3. 右栏 → **添加** → 「计划看板」。
4. 顶部 **＋** 新建：填「项目（建议用工作目录名）」+「计划名（默认 main）」。

升级：非官方插件没有一键更新，先卸载再按同一 spec 重装。

## 数据文件

默认目录 `$DSH_HOME/plan-board/`（Windows：`%USERPROFILE%\.dsh\plan-board\`）。**一个项目一个目录，项目下可以有多份计划书**：

```
plan-board/
├── tickflow-stock-panel/
│   ├── main.json              ← 主计划
│   └── refactor-q4.json       ← 同一项目的第二份
└── default-workspace/
    └── main.json
```

- 计划标识（`slug`）= `<项目>/<计划名>`，例如 `tickflow-stock-panel/main`。
- **项目名**约定 = 工作目录名（agent 按这个找）；**计划名**是给人看的，可以随时改，只要同一个项目内不重名。
- 不同项目可以用同名计划（`A/main` 与 `B/main` 互不干扰）。
- 要换目录，在 `cordis.patch.yml` 的 `config` 里写 `boardsDir`（绝对路径，支持 `~` 开头）。
- **删除计划书** = 删掉 `plan-board/<项目>/<计划>.json`（面板没有删除按钮）。删除后，正打开着它的面板会自动退到其它计划书，**不会**再把空板写回来——读接口（`state.json`）不再因为文件不存在而创建文件，只有 `add` / 新建 / `POST /plan-board/item` 这类显式写入才会建。
- 迁移是自动的：老的扁平 `<名称>.json` 会被搬进 `<名称>/main.json`，pre-boards 的单文件 `$DSH_HOME/plan-board.json` 会变成 `default/main.json`。

```jsonc
{
  "version": 1,
  "title": "main",                   // 计划名（可改）
  "updatedAt": "2026-10-21T00:00:00.000Z",
  "sections": {
    "long":   { "title": "长期", "items": [] },
    "mid":    { "title": "中期", "items": [] },
    "short":  { "title": "短期", "items": [] },
    "idea":   { "title": "预想", "items": [] },
    "advice": { "title": "agent 建议", "items": [] }
  },
  "archive": [],                       // 已完成并"收集"起来的条目
  "codeSeq": { "L": 4, "M": 6, "S": 11, "I": 6, "A": 4 }   // 各字母的编号高水位，见「编号」
}
```

归档条目（`archive[]`）是在原条目基础上多三个字段：

```jsonc
{
  "aid": "a-1792670000000-ab12cd",     // 归档 id，提出时用它定位
  "part": "short",                     // 原分区，提出时放回这里
  "text": "…", "note": "", "priority": 2, "steps": [],
  "completedAt": "2026-10-22T12:00:00.000Z",   // 完成时间（勾选完成那一刻的 updatedAt）
  "archivedAt": "2026-10-22T13:00:00.000Z"
}
```

- **收集**：只有 `done: true` 的条目能收集；它从主列表移入 `archive`，抽屉按 `completedAt` 的日期倒序分组，组内按原分区（长期/中期/短期）、再按重要度排序。
- **提出**：从 `archive` 放回 `part` 指定的分区，**`done` 归 false、子步骤全部重置**——从归档里拿出来的东西按定义是还没做完的。

条目：

```jsonc
{
  "id": "short-1",            // 稳定 id，勾选回调靠它定位
  "code": "S5",               // 短编号：分区字母 + 序号，人和 agent 都用它称呼条目
  "text": "把安装流程跑通",
  "done": false,
  "priority": 2,              // 1 高 / 2 中 / 3 低 / 0 未设；缺省按 0
  "note": "可选的一行备注",
  "updatedAt": "…",
  "steps": [                   // 子步骤；没有就用 done 当整体进度
    { "text": "写 manifest", "done": true },
    { "text": "验证右栏渲染", "done": false }
  ]
}
```

- **进度**：有条目按 `子步骤完成数 / 总数`，没有就按 `done` 记 0 或 1；分区进度是条目均值；总进度只对**有条目**的长期/中期/短期取平均。
- **空分区没有完成度**：`0/0` 显示 `—`、不画进度条，也不进总进度的分母；全部为空时总进度也显示 `—`。
- **预想 / agent 建议**分区不显示进度——它们是想法池与提案区，不参与任何统计。
- **重要度排序只在渲染时发生**：分区内未完成的在前，同组按 `priority`（1 最高），未设（0）排在已设之后，其余保持文件原序；**文件里的顺序不会被改写**。
- **颜色**：条目左侧 3px 色条，P1 红 / P2 琥珀 / P3 蓝，未设不显示。点条目左侧的小徽章可循环切换 `P1 → P2 → P3 → 未设`。

## 编号（code）

每条待办都有一个人能直接念出来的短编号：**分区字母 + 序号**，面板里显示在条目最左边，文件里就是 `code` 字段。

| 分区 | 字母 | 例子 |
|---|---|---|
| 长期 | `L` | `L1`、`L2` |
| 中期 | `M` | `M3` |
| 短期 | `S` | `S11` |
| 预想 | `I` | `I2` |
| agent 建议 | `A` | `A4` |

- **只增不复用**：编号由宿主发号，文档里存一个 `codeSeq: { "L": 4, "M": 6, "S": 11, … }` 高水位。删掉 `S11` 后下一条新条目是 `S12`，不会有人继承 `S11`。
- **引用过的编号不搬家**：已有合法编号原地保留，新增条目只会拿新号。
- **归档保留编号**：收集进 `archive` 的条目还带着原 `code`；提出（restore）时尽量回到原号，只有原号已被占用才换新号。
- **缺号自动补**：手写或老文档里没有 `code` 的条目，宿主读到时会补号并**立即写回文件**，所以 agent 直接在 JSON 里就能按 `code` 检索。
- **对 agent**：加条目时可以省掉 `code`（3 秒内自动补），要立刻引用就按该分区下一个号写；改状态、改备注时不要动别人的 `code`。
- **对人**：在对话里直接说编号即可，比如「把 S5 勾掉」「S11 拆成两步」。

## 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/plan-board/boards.json` | 列出 `{ slug, project, plan, title, updatedAt, count }` |
| GET | `/plan-board/state.json?board=<slug>` | 返回 `{ ok, slug, doc, boards }`；解析失败时 `ok:false` 且**不写回** |
| POST | `/plan-board/toggle` | `{ board, part, id, step? }`，`step` 省略则是整条勾选 |
| POST | `/plan-board/board` | `{ project, plan }` 新建计划（同一项目内重名返回 409，跨项目允许同名） |
| POST | `/plan-board/item` | `{ board, part, text, note?, priority?, steps? }` 追加条目，返回自动发出的 `code` |
| POST | `/plan-board/priority` | `{ board, part, id, priority }`，`priority` 取 0..3；只改这一条 |
| POST | `/plan-board/collect` | `{ board, part, id }`，仅接受已完成的条目；移入 `archive` |
| POST | `/plan-board/restore` | `{ board, aid }`，放回原分区并重新打开 |

写路由只接受回环地址，并拒绝 `Sec-Fetch-Site: cross-site`。

## agent 怎么用

**工具 `plan_board`**（v0.3.0 起）：

| action | 作用 |
|---|---|
| `list` | 列出所有计划书（`<项目>/<计划>`） |
| `read` | 读一份，带编号、进度、备注 |
| `add` | 追加条目：`part` + `text`，可选 `note` / `priority` / `steps` |
| `update` | 按 `code` 改 `text` / `note` / `priority` / `steps` / `done` |
| `toggle` | 按 `code` 翻转完成状态 |

条目用编号称呼（`S11`），所以对话里说「S11 拆成两步」agent 能直接定位，不用靠「短期第 5 条」这种会随排序漂移的说法。

**为什么不走文件**：计划书默认在 `%USERPROFILE%\.dsh\plan-board\`，在工作区之外。DSH 默认的 `workspace-write` 沙箱只允许 agent 写工作区，文件工具碰这里会直接报 `file access denied`（实测）。所以由宿主进程提供工具和 `POST /plan-board/item` 路由，agent 走它们写盘；人仍然可以手改 JSON，改完面板 3 秒内刷新。

**怎么让它在该写计划的时候想起来**：工具描述里已经写明——用户要计划 / 路线图 / 阶段拆分 / TODO 时，把条目写进看板，而不是新建一份 markdown 计划文件。要针对某个工作区再加固一层，就在该工作区的 `AGENTS.md` 里加一句「计划写进 plan-board」。

**已知取舍**：面板和 agent 都是「读整份 → 改一处 → 写整份」（`tmp` + `rename`），没有锁；两边同时改同一份计划书时仍可能丢一笔修改。只有人和 agent 同时动手才需要担心，正常节奏下 3 秒轮询够用。

## 测试点

1. 装完打开右栏 → 添加 → 「计划看板」，顶部下拉应列出已有项目。
2. 改 `%USERPROFILE%\.dsh\plan-board\<项目>\<计划>.json` 加一条，3 秒内面板应自己变。
3. 面板里勾一个子步骤 → 对应文件的 `done` 应立即变 `true`。
4. 点「＋」新建一个项目 → 文件出现在同目录，两个板子互不影响。
5. 新会话里说「把这件事记到计划看板」→ 应出现 `plan_board` 工具调用（`add`），3 秒内条目出现在面板，编号由宿主发出。
