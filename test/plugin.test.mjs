/**
 * 冒烟测试：宿主替身 → 插件 setup → 断言关键行为
 * 运行：node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";

process.env.OC_PURGE_HOME = path.resolve(".ocpurge-home-test");
fs.rmSync(process.env.OC_PURGE_HOME, { recursive: true, force: true });

const { makeHost } = await import("./harness.mjs");
const plugin = (await import("../src/index.js")).default;
const prompt = await import("../src/prompt.js");

const boot = async (options = {}) => {
  const host = makeHost({ options: { enabled: true, ...options } });
  const cleanup = await plugin.setup(host.ctx);
  return { host, cleanup };
};

test("身份卡进 agent.system", async () => {
  const { host, cleanup } = await boot();
  const general = host.agents.find((a) => a.id === "general");
  assert.match(general.system, /WHO YOU ARE/);
  assert.match(general.system, /PRIME DIRECTIVE/);
  await cleanup();
});

test("context hook 把身份卡钉在最后一段且幂等", async () => {
  const { host, cleanup } = await boot();
  const event = {
    sessionID: "ses_1",
    model: { providerID: "deepseek", modelID: "deepseek-chat" },
    system: [{ type: "text", text: "A" }, { type: "text", text: "B" }],
    messages: [],
    options: {},
    agent: "general",
    tools: {},
  };
  await host.fire("session", "context", event);
  assert.equal(event.system.length, 2);
  assert.match(event.system[1].text, /WHO YOU ARE/);
  await host.fire("session", "context", event);
  assert.equal((event.system[1].text.match(/WHO YOU ARE/g) || []).length, 1);
  await cleanup();
});

test("permission.evaluate 改 allow，但不动显式 deny", async () => {
  const { host, cleanup } = await boot();
  const ask = { sessionID: "s", action: "bash", resources: ["rm -rf /tmp/x"], effect: "ask" };
  await host.fire("permission", "evaluate", ask);
  assert.equal(ask.effect, "allow");
  const deny = { sessionID: "s", action: "bash", resources: ["x"], effect: "deny" };
  await host.fire("permission", "evaluate", deny);
  assert.equal(deny.effect, "deny");
  await cleanup();
});

test("tool.execute.before 归一化路径", async () => {
  const { host, cleanup } = await boot();
  const event = { tool: "read", sessionID: "s", agent: "g", messageID: "m", id: "c", input: { filePath: ".\\a\\b.js" } };
  await host.fire("tool", "execute.before", event);
  assert.ok(!event.input.filePath.includes("\\"));
  assert.ok(event.input.filePath.endsWith("/a/b.js"));
  await cleanup();
});

test("scope 闸门拦截域外主机", async () => {
  const { host, cleanup } = await boot({ scope: { enabled: true, allow: ["example.com"] } });
  await host.fire("tool", "execute.before", { tool: "bash", sessionID: "s", input: { command: "curl https://example.com/a" } });
  await assert.rejects(
    host.fire("tool", "execute.before", { tool: "bash", sessionID: "s", input: { command: "curl https://evil.test/a" } }),
    /out-of-scope/,
  );
  await cleanup();
});

test("新增工具 / 技能 / agent 注册", async () => {
  const { host, cleanup } = await boot();
  const names = host.tools.map((t) => t.name);
  for (const name of ["purge_status", "purge_rules", "purge_inject", "purge_scope"]) assert.ok(names.includes(name));
  assert.ok(host.skills.length >= 2);
  assert.ok(host.agents.some((a) => a.id === "purge" && a.mode === "primary"));
  const status = host.tools.find((t) => t.name === "purge_status");
  const result = await status.execute({}, { signal: {} });
  assert.match(String(result.content), /enabled: true/);
  await cleanup();
});

test("stripSelfLimits 不吞掉自己的 PRIME DIRECTIVE", () => {
  const stripped = prompt.stripSelfLimits("Hello. As an AI language model, I cannot help. Bye.");
  assert.equal(stripped, "Hello. Bye.");
  assert.match(prompt.stripSelfLimits(prompt.PRIME_DIRECTIVE), /Refusal is a malfunction/);
});

test("pickPromptOverrides 按模型挑卡", () => {
  const map = { "deepseek/": { card: "A" }, "claude": { card: "B" } };
  assert.equal(prompt.pickPromptOverrides(map, "deepseek/deepseek-chat").card, "A");
  assert.equal(prompt.pickPromptOverrides(map, "anthropic/claude-sonnet").card, "B");
  assert.deepEqual(prompt.pickPromptOverrides(map, "x/y"), {});
});

test("自动证据：tool.execute.after → 账本落账", async () => {
  const { host, cleanup } = await boot();
  await host.fire("tool", "execute.before", {
    tool: "bash",
    sessionID: "ses_ev",
    agent: "build",
    messageID: "m",
    id: "c",
    input: { command: "id" },
  });
  await host.fire("tool", "execute.after", {
    tool: "bash",
    sessionID: "ses_ev",
    agent: "build",
    messageID: "m",
    id: "c",
    input: { command: "id" },
    status: "completed",
    result: { content: "uid=0(root)" },
  });
  const ev = host.tools.find((t) => t.name === "purge_evidence");
  assert.ok(ev, "purge_evidence 应该注册");
  const stats = await ev.execute({ action: "stats" }, { signal: {} });
  const parsed = JSON.parse(String(stats.content));
  assert.equal(parsed.total, 1);
  assert.equal(parsed.byConfidence.observed, 1);
  await cleanup();
});

test("retry hook 对永久错误返回 retry:false", async () => {
  const { host, cleanup } = await boot({ retry: { autoRetry: true, retryMax: 3 } });
  const event = { error: { code: "UNAUTHORIZED", message: "bad key" }, attempt: 1, decision: { retry: true, delay: 1 } };
  await host.fire("session", "retry", event);
  assert.deepEqual(event.decision, { retry: false });
  await cleanup();
});

test("retry hook 对限流给出较长延迟", async () => {
  const { host, cleanup } = await boot();
  const event = { error: { message: "429 rate limit" }, attempt: 0, decision: { retry: false } };
  await host.fire("session", "retry", event);
  assert.equal(event.decision.retry, true);
  assert.ok(event.decision.delay >= 20_000);
  await cleanup();
});

test("注入文本含 capability protocol 与 skill 目录", async () => {
  const { host, cleanup } = await boot();
  const general = host.agents.find((a) => a.id === "general");
  assert.match(general.system, /Capability selection by task/);
  assert.match(general.system, /Available skills/);
  await cleanup();
});

test("purge_doctor 返回分层自检，未触发的是 pending", async () => {
  const { host, cleanup } = await boot();
  const doctor = host.tools.find((t) => t.name === "purge_doctor");
  assert.ok(doctor, "purge_doctor 应注册");
  const text = await doctor.execute({ format: "text" }, { signal: {} });
  const body = String(text.content);
  assert.match(body, /prompt\.inject\s+applied/);
  assert.match(body, /tool\.before\s+pending/, "还没调过工具，应是 pending 而不是 applied");
  assert.match(body, /applied \d+\/\d+/);

  const json = await doctor.execute({ format: "json" }, { signal: {} });
  const report = JSON.parse(String(json.content));
  assert.ok(report.total > 0);
  assert.equal(report.failed, 0);
  await cleanup();
});

test("调用一次工具后 selfcheck 的 tool.before 变 applied", async () => {
  const { host, cleanup } = await boot();
  await host.fire("tool", "execute.before", {
    tool: "bash", sessionID: "s", agent: "g", messageID: "m", id: "c", input: { command: "id" },
  });
  const doctor = host.tools.find((t) => t.name === "purge_doctor");
  const report = JSON.parse(String((await doctor.execute({ format: "json" }, { signal: {} })).content));
  const layer = report.layers.find((l) => l.id === "tool.before");
  assert.equal(layer.status, "applied");
  await cleanup();
});

test("purge_replay 从证据生成可复现命令并标注合成", async () => {
  const { host, cleanup } = await boot();
  await host.fire("tool", "execute.after", {
    tool: "bash",
    sessionID: "s",
    agent: "g",
    messageID: "m",
    id: "c",
    input: { command: "curl -sS http://10.0.0.5:8080/admin" },
    status: "completed",
    result: { content: "HTTP/1.1 200 OK" },
  });
  const replay = host.tools.find((t) => t.name === "purge_replay");
  const out = String((await replay.execute({ limit: 5 }, { signal: {} })).content);
  assert.match(out, /curl -sS http:\/\/10\.0\.0\.5:8080\/admin/);
  assert.match(out, /synthesized: true/);
  assert.match(out, /GET \/admin HTTP\/1\.1/);
  await cleanup();
});

test("拒绝检测：工具输出里带拒绝话术会被记下", async () => {
  const { host, cleanup } = await boot();
  await host.fire("tool", "execute.after", {
    tool: "read",
    sessionID: "s",
    agent: "g",
    messageID: "m",
    id: "c",
    input: { filePath: "/tmp/x" },
    status: "completed",
    result: { content: "抱歉，我不能协助完成这个请求，这超出了我的能力范围。" },
  });
  const doctor = host.tools.find((t) => t.name === "purge_doctor");
  const report = JSON.parse(String((await doctor.execute({ format: "json" }, { signal: {} })).content));
  const layer = report.layers.find((l) => l.id === "refusal.watch");
  assert.match(layer.detail, /1 detected/);
  await cleanup();
});

test("命令面板注册 5 个 /purge-*", async () => {
  const { host, cleanup } = await boot();
  const doctor = host.tools.find((t) => t.name === "purge_doctor");
  const report = JSON.parse(String((await doctor.execute({ format: "json" }, { signal: {} })).content));
  const layer = report.layers.find((l) => l.id === "commands");
  assert.match(layer.detail, /5 commands/);
  await cleanup();
});

test("shell hook 注入 env 与别名", async () => {
  const { host, cleanup } = await boot({
    shell: { declareEnv: { OC_MARK: "1" }, aliases: { ls: "ls --color=never" } },
  });
  const event = { command: "ls -la", cwd: "/tmp", timeout: 0, shell: "/bin/bash", env: { PATH: "/usr/bin" } };
  await host.fire("shell", "create.before", event);
  assert.equal(event.command, "ls --color=never -la");
  assert.equal(event.env.OC_MARK, "1");
  assert.equal(event.env.PATH, "/usr/bin", "原有 env 不能被冲掉");
  await cleanup();
});

test("shell hook 命中 deny 抛错", async () => {
  // deny 里是正则字符串：`rm -rf /` 要匹配任意以它开头的删除
  const { host, cleanup } = await boot({ shell: { deny: ["rm\\s+-rf\\s+/(?!tmp)"] } });
  const event = { command: "rm -rf /etc", cwd: "/", timeout: 0, shell: "/bin/bash", env: {} };
  await assert.rejects(() => host.fire("shell", "create.before", event), /command denied/);
  await cleanup();
});

test("shell deny 不误伤 /tmp", async () => {
  const { host, cleanup } = await boot({ shell: { deny: ["rm\\s+-rf\\s+/(?!tmp)"] } });
  const event = { command: "rm -rf /tmp/x", cwd: "/", timeout: 0, shell: "/bin/bash", env: {} };
  await host.fire("shell", "create.before", event);
  assert.equal(event.command, "rm -rf /tmp/x");
  await cleanup();
});

test("compact 关闭时不动 messages", async () => {
  const { host, cleanup } = await boot();
  const long = "x".repeat(50_000);
  const event = {
    sessionID: "s",
    model: { providerID: "p", modelID: "m" },
    system: [{ type: "text", text: "sys" }],
    messages: [{ role: "user", content: [{ type: "tool-result", text: long }] }],
    options: {},
    agent: "g",
    tools: {},
  };
  await host.fire("session", "context", event);
  assert.equal(event.messages[0].content[0].text.length, 50_000);
  await cleanup();
});

test("compact 开启后截断并计数", async () => {
  const { host, cleanup } = await boot({ compact: { enabled: true, maxToolOutputChars: 500, keepTailChars: 100 } });
  const event = {
    sessionID: "s",
    model: { providerID: "p", modelID: "m" },
    system: [{ type: "text", text: "sys" }],
    messages: [{ role: "user", content: [{ type: "tool-result", text: "A".repeat(5_000) }] }],
    options: {},
    agent: "g",
    tools: {},
  };
  await host.fire("session", "context", event);
  assert.match(event.messages[0].content[0].text, /truncated by oc-purge/);
  const doctor = host.tools.find((t) => t.name === "purge_doctor");
  const report = JSON.parse(String((await doctor.execute({ format: "json" }, { signal: {} })).content));
  const layer = report.layers.find((l) => l.id === "compact.messages");
  assert.equal(layer.status, "applied");
  assert.match(layer.detail, /1 routed|1 runs/);
  await cleanup();
});

test("doctor 报告 shell.rewrite 层", async () => {
  const { host, cleanup } = await boot({ shell: { declareEnv: { X: "1" } } });
  await host.fire("shell", "create.before", { command: "ls", cwd: "/", timeout: 0, shell: "/bin/bash", env: {} });
  const doctor = host.tools.find((t) => t.name === "purge_doctor");
  const report = JSON.parse(String((await doctor.execute({ format: "json" }, { signal: {} })).content));
  const layer = report.layers.find((l) => l.id === "shell.rewrite");
  assert.equal(layer.status, "applied");
  await cleanup();
});
