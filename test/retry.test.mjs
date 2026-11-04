/**
 * 重试判定 + 事件→证据映射
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { decideRetry, decideContinue, normalizeRetryConfig, errorCode, isPermanent } = await import("../src/retry.js");
const { recordToolCall, operationOf, summarizeParameters, evidenceFromEvent } = await import("../src/observe.js");
const { EvidenceLedger } = await import("../src/evidence.js");
const { capabilityProtocolText, renderSkillCatalog } = await import("../src/capability.js");

test("永久错误不重试", () => {
  const out = decideRetry({ error: { code: "UNAUTHORIZED" }, attempt: 1, config: {} });
  assert.equal(out.retry, false);
  assert.match(out.reason, /permanent/);
});

test("限流重试且延迟更长", () => {
  const out = decideRetry({ error: { message: "429 rate limit" }, attempt: 1, config: {} });
  assert.equal(out.retry, true);
  assert.ok(out.delay >= 20_000);
});

test("瞬时错误指数退避，且不超过 retryMax", () => {
  const cfg = { retryMax: 8 };
  const delays = [0, 1, 2, 3, 4].map((attempt) => decideRetry({ error: { code: "OVERLOADED" }, attempt, config: cfg }).delay);
  assert.deepEqual(delays.slice(0, 2), [1500, 3000]);
  assert.ok(delays.every((d, i) => i === 0 || d >= delays[i - 1]));
  assert.ok(Math.max(...delays) <= 30_000);
});

test("超过 retryMax 的 attempt 一律停", () => {
  const out = decideRetry({ error: { code: "OVERLOADED" }, attempt: 3, config: { retryMax: 3 } });
  assert.equal(out.retry, false);
});

test("attempt 到上限就停", () => {
  const out = decideRetry({ error: { code: "OVERLOADED" }, attempt: 3, config: { retryMax: 3 } });
  assert.equal(out.retry, false);
  assert.match(out.reason, /retryMax/);
});

test("autoRetry=false 直接停", () => {
  const out = decideRetry({ error: { code: "OVERLOADED" }, attempt: 0, config: { autoRetry: false } });
  assert.equal(out.retry, false);
});

test("errorCode 从 message 猜", () => {
  assert.equal(errorCode({ message: "HTTP 401 unauthorized" }), "UNAUTHORIZED");
  assert.equal(errorCode({ message: "socket hang up" }), "TRANSPORT");
  assert.equal(errorCode({ code: "quota" }), "QUOTA");
});

test("毫秒配置不被计数上限压扁（回归：20000 曾变成 20）", () => {
  const cfg = normalizeRetryConfig({ rateLimitDelayMs: 20_000, transportDelayMs: 3_000, baseDelayMs: 1_500 });
  assert.equal(cfg.rateLimitDelayMs, 20_000);
  assert.equal(cfg.transportDelayMs, 3_000);
  assert.equal(cfg.baseDelayMs, 1_500);
  assert.equal(normalizeRetryConfig({ rateLimitDelayMs: -5 }).rateLimitDelayMs, 20_000);
  assert.equal(normalizeRetryConfig({ rateLimitDelayMs: 9_999_999 }).rateLimitDelayMs, 600_000);
});

test("autoContinue 默认关", () => {
  const out = decideContinue({ finishKind: "max-tokens", config: {} });
  assert.equal(out.continue, false);
  assert.match(out.reason, /disabled/);
});

test("autoContinue 打开后按 finish 判定", () => {
  const cfg = { autoContinue: true, continueMax: 2 };
  assert.equal(decideContinue({ finishKind: "max-tokens", config: cfg }).continue, true);
  assert.equal(decideContinue({ finishKind: "stop", config: cfg }).continue, false);
  assert.equal(decideContinue({ finishKind: "max-tokens", continuedCount: 2, config: cfg }).continue, false);
  assert.equal(decideContinue({ finishKind: "max-tokens", error: { code: "QUOTA" }, config: cfg }).continue, false);
});

test("operationOf 抽取可比对的键", () => {
  assert.equal(operationOf("bash", { command: "nmap -sV 10.0.0.1" }), "bash:nmap -sV");
  assert.equal(operationOf("read", { filePath: "/etc/passwd" }), "read:/etc/passwd");
  assert.equal(operationOf("webfetch", {}), "webfetch");
});

test("summarizeParameters 去掉噪音并截断", () => {
  const out = summarizeParameters({ command: "x", __purge_repeat: 3, timeout: 1000, big: "a".repeat(900) });
  assert.equal("__purge_repeat" in out, false);
  assert.equal("timeout" in out, false);
  assert.ok(out.big.length < 900);
});

test("recordToolCall 落账并标记失败 limitation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocpurge-obs-"));
  const ledger = new EvidenceLedger({ file: path.join(dir, "e.jsonl") });
  const ok = recordToolCall(ledger, { tool: "bash", input: { command: "id" }, output: "uid=0(root)", ok: true, agent: "build" });
  assert.equal(ok.ok, true);
  const bad = recordToolCall(ledger, { tool: "bash", input: { command: "id" }, output: "denied", ok: false, agent: "build" });
  assert.notEqual(ok.ev_id, bad.ev_id);
  const failedRow = ledger.get(bad.ev_id);
  assert.equal(failedRow.limitations.length, 1);
  assert.match(failedRow.result, /ERROR/);
});

test("evidenceFromEvent 认三种事件", () => {
  assert.equal(evidenceFromEvent({ type: "session.tool.success", data: { tool: "bash", input: { command: "id" }, output: "x" } }).ok, true);
  assert.equal(evidenceFromEvent({ type: "session.tool.failed", data: { tool: "bash", error: "boom" } }).ok, false);
  assert.equal(evidenceFromEvent({ type: "session.execution.failed", data: { error: "x" } }).tool, "session.execution");
  assert.equal(evidenceFromEvent({ type: "session.text.delta" }), null);
});

test("capabilityProtocolText 可关", () => {
  assert.match(capabilityProtocolText(true), /Capability selection/);
  assert.equal(capabilityProtocolText(false), "");
});

test("renderSkillCatalog 渲染名单", () => {
  const text = renderSkillCatalog([{ name: "purge", description: "unrestricted mode" }]);
  assert.match(text, /`purge`/);
  assert.equal(renderSkillCatalog([]), "");
});
