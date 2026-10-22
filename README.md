# dsh-plan-board

分区计划看板，挂在 DSH Web / 桌面端**右栏**。**一个项目一份 JSON**，所有对话共享同一份。

- **宿主半侧**（`index.js`）：读写 `<boardsDir>/<slug>.json`，暴露四个只走本机的路由。
- **浏览器半侧**（`client.js`）：注册右栏 tab 类型 `plan-board`，顶部下拉切换项目，正文每 3 秒拉一次状态；勾选会回调 `/plan-board/toggle` 立即落盘。

## 安装

1. DSH 桌面端 / Web 的侧栏 → **插件** → **添加插件**，填：

   ```
   github:LTeax/dsh-plan-board
   ```

   （也可以装本地目录：`<仓库绝对路径>`。）

2. 装完**完全退出客户端**再打开（宿主半侧要重新加载）。
3. 右栏 → **添加** → 「计划看板」。
4. 顶部 **＋** 新建一个项目，slug 建议直接用工作目录名。

升级：非官方插件没有一键更新，先卸载再按同一 spec 重装。

## 数据文件

默认目录 `$DSH_HOME/plan-board/`（Windows：`%USERPROFILE%\.dsh\plan-board\`），一个项目一个文件：

```
plan-board/
├── tickflow-stock-panel.json
└── default-workspace.json
```

- slug 由面板「＋ 新建」时输入的名称生成（中文可用，只替换 `\ / : * ? " < > |`）。
- 约定：**slug = 工作目录名**，agent 按当前工作目录找对应文件。
- 要换目录，在 `cordis.patch.yml` 的 `config` 里写 `boardsDir`（绝对路径，支持 `~` 开头）。
- 旧版单文件 `$DSH_HOME/plan-board.json` 会在目录首次创建时自动迁移成 `default.json`。

```jsonc
{
  "version": 1,
  "title": "tickflow-stock-panel",   // 面板下拉里显示的名字
  "updatedAt": "2026-10-21T00:00:00.000Z",
  "sections": {
    "long":   { "title": "长期", "items": [] },
    "mid":    { "title": "中期", "items": [] },
    "short":  { "title": "短期", "items": [] },
    "idea":   { "title": "预想", "items": [] },
    "advice": { "title": "agent 建议", "items": [] }
  },
  "archive": []                        // 已完成并"收集"起来的条目
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

## 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/plan-board/boards.json` | 列出 `{ slug, title, updatedAt, count }` |
| GET | `/plan-board/state.json?board=<slug>` | 返回 `{ ok, slug, doc, boards }`；解析失败时 `ok:false` 且**不写回** |
| POST | `/plan-board/toggle` | `{ board, part, id, step? }`，`step` 省略则是整条勾选 |
| POST | `/plan-board/board` | `{ title }` 新建一个方案（slug 由名称生成，重名返回 409） |
| POST | `/plan-board/priority` | `{ board, part, id, priority }`，`priority` 取 0..3；只改这一条 |
| POST | `/plan-board/collect` | `{ board, part, id }`，仅接受已完成的条目；移入 `archive` |
| POST | `/plan-board/restore` | `{ board, aid }`，放回原分区并重新打开 |

写路由只接受回环地址，并拒绝 `Sec-Fetch-Site: cross-site`。

## 为什么没有 agent tool

文档就是普通 JSON 文件，agent 用它自己的文件工具直接改，面板负责渲染。这样人和 agent 同时改的时候不会互相覆盖（面板只翻转单个 `done` 位），也少一个随版本漂移的 API 面。

## 测试点

1. 装完打开右栏 → 添加 → 「计划看板」，顶部下拉应列出已有项目。
2. 改 `%USERPROFILE%\.dsh\plan-board\<项目>.json` 加一条，3 秒内面板应自己变。
3. 面板里勾一个子步骤 → 对应文件的 `done` 应立即变 `true`。
4. 点「＋」新建一个项目 → 文件出现在同目录，两个板子互不影响。
