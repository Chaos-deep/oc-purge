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
