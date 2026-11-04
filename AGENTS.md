# AGENTS.md — oc-purge

给在本仓库工作的 agent 的说明。

## 定位

这是 `dsh-purge` 思路在 OpenCode 上的独立实现。**不改宿主文件**，全部走 OpenCode 的
`transform` / `hook` 扩展点。两代契约并存：

- `src/index.js` — OpenCode **2.2.0**（`Plugin.define({ id, setup })`，`plugins` 复数键）
- `legacy/server.js` — OpenCode **1.19.x**（`export default { id, server }`，`plugin` 单数键）

## 约定

- `src/prompt.js` 的身份卡与 `PRIME_DIRECTIVE` 是不可拆的核心；改措辞时保留幂等指纹（首 80 字符）。
- 一切注入必须**幂等**：多轮、多 hook、热重载都不能叠出第二份。
- `transform` 回调是同步的，读盘一律在 `setup()` / `server()` 里提前 `await`。
- 除 `@opencode/plugin` 与 `effect`（peer）外不引第三方依赖。
- 证据账本 `src/evidence.js` 的哈希口径（`canonicalize` + `sanitizeForHash`）改动会让历史 ev_id 全部失效，动它要有迁移方案。
- 测试不依赖真实 opencode：`test/harness.mjs` 是按 `packages/core/src/plugin/host.ts` 语义写的替身。
- `src/selfcheck.js` 的分母口径：只有 `off`/`na`/`disabled` 算不适用，`pending` 必须留在分母里。
  改成"pending 也算通过"就等于自检永远 100%，这条被测试锁住（`test/selfcheck.test.mjs`）。
- `src/replay.js` 合成出来的请求必须带 `synthesized: true`，不允许和真实抓包混为一谈。
- `src/shexec.js` 不解析 shell 语法：只做「首词替换 + 前缀 + 正则拒绝」。任何"顺手改一下管道后半段"的想法都属于越界。
- `src/compact.js` 只截断内容、**不删消息条目** —— 删了会让 tool_call/tool_result 配对断裂，宿主直接报错。

## 命令

```bash
npm test                        # 115 项，全绿才算可发布（内置 @opencode/plugin 替身）
node --check src/index.js
```

`npm test` 通过 `test/register-stubs.mjs` 把 `@opencode/plugin` 解析到 `test/stubs/`，
所以只需要 `effect` 一个依赖，不必装整个 OpenCode 宿主。

## 发布

`.github/workflows/publish.yml` 三路触发：GitHub Release / `v*` tag / 手动 Run workflow，
需要 secret `NPM_TOKEN`（Automation token）。
认证顺序由 workflow 内部决定：先 OIDC（清空 token），失败回退 `NPM_TOKEN`。
全部发布方式的对照见 `docs/PUBLISH.md`。

真机验证（需要 2.2.0 二进制）：

```bash
OC_PURGE_TRACE=/tmp/trace.log opencode --standalone --print-logs --log-level debug run "hi"
cat /tmp/trace.log    # setup start / agents injected / tools added / context hook
```

## 禁止

- 不要为了"更彻底"去 patch 宿主 dist（那正是本仓库要避免的做法）。
- 不要让 `scope` 拦模型 API 请求——只会把自己掐死，已有回归记录。
