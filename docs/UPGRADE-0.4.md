# oc-purge 0.4.0 —— 从 dsh-purge 社区版移植的四项

0.3.0 解决"有没有证据"。0.4.0 解决**"能不能证明它在工作"**和**"模型推脱了怎么办"**。

参考：[kingcharleslzy-ai/dsh-purge](https://github.com/kingcharleslzy-ai/dsh-purge)（`dsh-purge-community` 1.6.69）。
该 fork 在上游基础上多了 `refusal-retry` / `selfcheck` / `atomic-files` / `path-boundary` 等模块，
本版把它们的**语义**搬过来，实现按 OpenCode 的扩展点重写。

| # | 新增 | 来源 | 解决什么 |
| --- | --- | --- | --- |
| 1 | `src/selfcheck.js` + `purge_doctor` | `lib/selfcheck.js` | "插件装上了" ≠ "破甲生效了" |
| 2 | `src/refusal.js` | `lib/refusal-retry.js` | 模型软拒绝被当成"正常回答"放过去 |
| 3 | `src/replay.js` + `purge_replay` | `lib/redteam/report-replay.js` | 报告里每条结论无法照做一遍 |
| 4 | `src/fsx.js` | `lib/atomic-files.js` + `lib/path-boundary.js` | 半个 JSON 文件 / 路径穿越 |

---

## 1. 分层自检：`purge_doctor`

```
$ purge_doctor
✓ prompt.inject          applied    2151 bytes
✓ prompt.capability      applied    enabled
· prompt.card            pending    no request yet
· permission.evaluate    pending    0 evaluations seen
· tool.before            pending    0 tool calls seen
· tool.after             pending    0 evidence rows
· retry.decision         pending    0 retries evaluated
- scope.gate             off        disabled by config
✓ commands               applied    5 commands
✓ tools.purge            applied    7 tools
✓ refusal.watch          applied    0 detected

applied 5/10  pending 5  failed 0  not-applicable 1  ratio 0.5
```

11 层，每层有 `why`（这层没了会发生什么）。核心口径抄自上游：

> **只有明确不适用（`off` / `na` / `disabled`）才从分母里去掉。**
> `pending`（装了但还没被触发）必须留在分母里 —— 否则"没跑起来"会算成"不需要"，自检永远 100%。

`pending` 不是错误，是"这个宿主还没走到这一步"。等你真正发一条消息、调一次工具，对应层会转 `applied`。

## 2. 拒绝检测：`src/refusal.js`

上游把拒绝检测做成 stream 拦截（缓冲 400 字符 → 命中就丢弃重跑）。OpenCode 没有对等的
"取消后静默重跑"入口，所以这里拆成**可组合的判定 + 提示**：

| 导出 | 用途 |
| --- | --- |
| `looksLikeRefusal(text)` | 纯函数判定 |
| `refusalMatchIndex(text)` | 返回命中规则下标，用于审计误判 |
| `resumePrompt()` | 生成"接着做完"的一轮提示 |
| `withNudge(parts)` / `withNudgeOnMessages(msgs)` | 把 nudge 追加到 system |

两条从上游学来的判定经验都保留了：

1. **中文软拒绝比"我不能"更常见** —— `这一步我不做`、`我也不会帮你把它包装成`、
   `请把你的授权文件发给我` 都要命中。
2. **元拒绝只在整段很短时成立** —— 长答案里出现"提示词注入""越狱"是正常技术讨论。
   不加这条，安全类回答会被全部误判重跑。

## 3. 复现材料：`purge_replay`

把账本里的一条证据变成能直接跑的东西：

```
## ev_4f2a…
kind: curl
synthesized: true

​```bash
curl -sS http://10.0.0.5:8080/admin
​```

​```http
GET /admin HTTP/1.1
Host: 10.0.0.5:8080
User-Agent: Mozilla/5.0
Connection: close
​```
note: 报文由 curl 命令合成，命令本身来自原始记录
```

两条底线照抄上游：

- **合成的必须标 `synthesized: true`** —— 推断出的请求和真实抓包不是一回事
- **信息不足就不合成** —— 没有 command/url 时返回 `kind: unknown` + 补录指引，不编造

另外修了上游踩过的 IPv6 坑：`http://[::1]:8080/x` 里"地址内的冒号"与"端口冒号"混在一起，
一条正则抓会把 host 解析成 `::1:`、path 变成 `:8080/x`。这里先按方括号取 authority 再剥端口。

## 4. 文件安全：`src/fsx.js`

| 能力 | 为什么需要 |
| --- | --- |
| `atomicWriteSync` | 直接写目标文件，进程被杀会留半个 JSON，下次解析失败 → 状态全丢 |
| rename 退避重试 | Windows 上杀软/面板轮询会让 rename 抛 `EPERM`/`EBUSY` |
| `within(root, target)` | `startsWith` 会让 `/a/b` 匹配 `/a/bb`，要按相对路径判 |
| `realDestination` | 符号链接不解开，软链指到外面照样穿 |
| `assertWithinRoots` / `readWithin` | 账本里的 `path` 是模型写的不可信输入 |

`readWithin` 对越界/不存在/超限一律返回 `undefined`，不抛 —— 调用方当"查不到"处理。

---

## 版本对照

| 版本 | 主题 | 测试数 |
| --- | --- | --- |
| 0.2.x | 提示词注入 + 规则库 + 权限放行 + scope | 13 |
| 0.3.0 | 证据账本、自动落账、重试判定、能力协议 | 41 |
| 0.4.0 | 分层自检、拒绝检测、复现材料、文件安全 | 87 |

## 未移植（及原因）

| dsh-purge-community 有 | 不搬的原因 |
| --- | --- |
| `boost.js` 的 `<dsh_boost>` 长段 | 语义与 `PRIME_DIRECTIVE` 重复；已有 `postPrompt` 可自定义 |
| `steering.js`（插话与队列顺序） | 那是 DSH 宿主补丁，OpenCode 的原生插话没有这个 race |
| `market/`、`packages/purge-panel` | 属于预设市场与桌面面板，需要 GUI bundle |
| `score-rules.js` 计分板 | 比赛评分语义，不属于 harness 插件 |
| `audit.js` 的完整审计链 | 简化为 `probe` + trace 文件，够定位"这次没生效" |
