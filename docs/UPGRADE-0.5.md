# oc-purge 0.5.0 —— 两个"最底层"的扩展点

0.3 管证据，0.4 管自检。0.5.0 终于动到了**执行**和**上下文**这两层：

| # | 新增 | 宿主入口 | 解决什么 |
| --- | --- | --- | --- |
| 1 | `src/shexec.js` | `shell.hook("create.before")` | 任何工具最终都落到 shell，env / 代理 / 别名在这里才真正统一 |
| 2 | `src/compact.js` | `session.hook("context")` → `messages` | 超长工具输出灌满上下文，早期约束被冲掉 |

---

## 1. shell 执行前改写

宿主在 `packages/core/src/shell.ts:284` 触发 `create.before`，事件 `{command, cwd, timeout, shell, env}` 可变，
改完立即用于执行 —— 这是唯一一个"拦住所有命令"的地方（bash / 自定义工具 / code mode 都走它）。

```
$ config: { aliases: { nmap: "nmap -sV --reason" }, proxy: "http://127.0.0.1:7890" }
$ command: "nmap 10.0.0.5"

→ export http_proxy=http://127.0.0.1:7890; export https_proxy=...; export no_proxy=127.0.0.1,localhost;
  nmap -sV --reason 10.0.0.5
```

能力清单：

| 能力 | 配置 | 说明 |
| --- | --- | --- |
| 注入 env | `shell.declareEnv` | 设 `null` = 删除该变量 |
| 别名 | `shell.aliases` | 只改**首词**，保留 `sudo -E` 前缀，最长优先（`ls` 不被 `l` 抢） |
| 统一前缀 | `shell.prepend` | 幂等：已以该前缀开头就不再加 |
| 代理 | `shell.proxy` | 一次注入 4 个变量 + `no_proxy` |
| 硬拦截 | `shell.deny` | 正则数组；命中直接抛错，**不改命令** |

**刻意不做的事**：不解析完整 shell 语法，不做 AST 改写。只在「前缀 + 首词替换 + 正则拒绝」层面工作。
解析错一次就会把用户的命令改成别的意思，比不干更糟。

默认注入的环境变量都无副作用：`LESS=-R`、`PAGER=cat`、`GIT_PAGER=cat`、`NO_COLOR=1`。
**已有值不覆盖** —— 用户设了 `PAGER=less` 就保持 `less`（有测试锁着）。

## 2. 历史消息减压

`session.hook("context")` 每轮派发前拿到 `messages`，可以就地改写。

```
关（默认）     messages 原样
开            · tool-result 超过 8000 字符 → 保头保尾 + 标记
              · 同一段工具输出重复出现 → 只留最后一次完整内容
              · system 段重复块 → 去重
```

三条硬约束：

1. **不删消息条目** —— 删了会让 `tool_call` / `tool_result` 配对断裂，宿主直接报错。只截断内容。
2. **不改 assistant 的推理与结论** —— 只动 tool 结果与重复块。
3. **默认关闭** —— 碰历史消息的东西必须显式开启（`compact.enabled: true`）。

每次运行返回 `{truncated, deduped, skipped}`，`/purge-doctor` 的 `compact.messages` 层会显示
`N runs, M truncated`，可以核实到底改了多少。

---

## 自检从 11 层变 13 层

```
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
✓ shell.rewrite          applied    1 shell runs seen
- compact.messages       off        disabled by config
✓ refusal.watch          applied    0 detected

applied 6/11  pending 5  failed 0  not-applicable 2  ratio 0.545
```

新增 `shell.rewrite`（配置了才算 applicable，跑过才算 applied）与 `compact.messages`。

---

## 版本对照

| 版本 | 主题 | 测试 |
| --- | --- | --- |
| 0.2.x | 提示词注入 / 规则 / 权限 / scope | 13 |
| 0.3.0 | 证据账本 / 自动落账 / 重试 / 能力协议 | 41 |
| 0.4.0 | 分层自检 / 拒绝检测 / 复现材料 / 文件安全 | 87 |
| 0.5.0 | shell 改写 / 消息减压 | 115 |

## 仍然没做

| 扩展点 | 为什么放着 |
| --- | --- |
| `aisdk.hook("sdk"/"language")` | 换 SDK 实现属于改模型协议层，出错面太大；等有明确需求再做 |
| `session.hook("compaction")` | 已有 `compact.messages` 做减压；真正的 compaction 摘要交给宿主，不抢 |
| `worktree` / `vcs` / `websearch.custom` | 与破甲主题无关 |
| `./gui-experimental` | 桌面端面板，需要独立 bundle 和构建链 |
