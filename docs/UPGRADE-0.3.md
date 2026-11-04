# oc-purge 0.3.0 —— 从 dsh-purge 移植的六项能力

0.2.x 只做了一件事：**把提示词灌进去**。0.3.0 补上了 dsh-purge 里真正让它"重"的部分。

| # | 新增 | 来源（dsh-purge） | 解决什么 |
| --- | --- | --- | --- |
| 1 | 证据账本 `src/evidence.js` | `lib/redteam/evidence-ledger.mjs` | 子智能体说"我拿到了"，指挥侧无从核对 |
| 2 | 自动落账 `src/observe.js` | 事件流 + 手动 record | 每条证据都要人手记，没人会记 |
| 3 | 重试判定 `src/retry.js` | `lib/continue-retry.js` | 永久错误反复重试烧配额 |
| 4 | 能力选用协议 `src/capability.js` | `lib/capability-protocol.js` | 模型不看 skill/MCP 目录，凭记忆硬写 |
| 5 | 5 个新工具 `purge_evidence` | `lib/redteam/tools.js` | 账本没有操作入口 |
| 6 | 命令 `/purge-*` | 无（OpenCode 独有） | 常用动作不用每次打自然语言 |

---

## 1. 证据账本：内容寻址

每条 evidence 的 id 是**语义哈希**：`ev_<sha256(规范化JSON)>`。

```
record({operation:"nmap_scan", parameters:{host:"10.0.0.5"}, result:"22/open"})
  → ev_4f2a…     同样内容再来一次 → duplicate:true
verify({…改一个字…})
  → MISMATCH expected=ev_4f2a… actual=(none)
```

四档置信度，语义来自 dsh-purge：

| 置信度 | 含义 | 谁能写 |
| --- | --- | --- |
| `observed` | 工具回显 / 库记录 | 自动 |
| `derived` | 从 observed 推理 | 人或模型 |
| `claimed` | 子智能体口头说"我拿到了" | 子智能体 |
| `inferred` | 纯推测 | 人或模型 |

`claimed` / `inferred` 计入 `unverified`，`stats()` 直接给出 `verifiedRatio`。
报告里一眼看出"有多少条其实只是别人说的"。

## 2. 自动落账：不用手记

`tool.execute.after` 一触发就写一条 `observed`：

```
session.tool.success → observed / tool-output
session.tool.failed  → observed，但 limitations 写明「没有确认目标侧效果」
```

参数里 `timeout` / `signal` / `__purge_repeat` 被丢掉，长文本截断到 2000 字符。
隐私上只记操作名与摘要，不枚举环境变量。

## 3. 重试：区分永久错误与瞬时错误

| 错误 | 决定 |
| --- | --- |
| `UNAUTHORIZED` / `QUOTA` / `MODEL_NOT_FOUND` / `CONTEXT_OVERFLOW` | 不重试 |
| `RATE_LIMIT`（429） | 重试，等 20 s |
| `TRANSPORT`（socket hang up） | 重试，等 3 s |
| 其他瞬时 | 指数退避 1.5 s → 3 s → 6 s，封顶 30 s |

`retryMax` 到上限即停。`autoContinue`（自动发"继续"）默认关——dsh-purge 踩过
"idle 后 280 ms 自动续跑与用户提交抢跑"的坑。

## 4. 能力选用协议

注入一段强制流程：**先读 skill/MCP 目录 → 匹配 → 调用 → 都没有才自己写**，
并要求子智能体继承同一条。原来 oc-purge 只有一句"看看有没有 skill"，模型经常忽略。

## 5. 工具与命令

| 工具 | 作用 |
| --- | --- |
| `purge_evidence(action)` | `record` / `verify` / `list` / `stats` / `open_unknown` / `resolve_unknown` / `unknowns` |

Residual Unknown：记"还没打完、证据不足"的问题（如"22 端口像 SSH 但没凭据"），
状态 `open → investigating → blocked → contradicted → resolved`，每次改 revision +1。

| 命令 | 作用 |
| --- | --- |
| `/purge-status` | 规则、卡片、scope、证据统计 |
| `/purge-evidence` | 列出未核实的 claimed/inferred |
| `/purge-release` | 走发布检查清单 |

---

## 移植时的取舍

| dsh-purge 做法 | 这里 | 原因 |
| --- | --- | --- |
| `node:sqlite` + DatabaseSync | JSONL 追加 + 全量扫描 | OpenCode 宿主不保证提供 DatabaseSync；万级再换 |
| 得分点 / 攻击链计分板 | **没搬** | 那是"红队比赛评分"语义，不属于 harness 插件 |
| HTTP 桥 `POST /redteam/api` | 工具 + 命令 | OpenCode 有原生工具面，不需要自建 HTTP |
| 预设中心 UI | 未做 | 需要 `./gui-experimental` 桌面端 bundle |

## 尚未做（下一版候选）

- `experimental.chat.messages.transform`：在派发前改写历史消息（压缩、去噪）
- `shell.hook("create.before")`：给 bash 注入环境变量（代理、别名）
- `skill.source()`：允许从 URL 拉 skill 目录
- 报告导出：把账本渲染成可复现的 Markdown（dsh-purge 的 `report-replay.js`）
