import test from "node:test";
import assert from "node:assert/strict";
const { compactMessages, truncateMiddle, DEFAULT_COMPACT } = await import("../src/compact.js");

const toolResult = (text) => ({ role: "user", content: [{ type: "tool-result", text }] });

test("默认关闭时原样返回", () => {
  const messages = [toolResult("x".repeat(50_000))];
  const out = compactMessages(messages);
  assert.equal(out.stats.skipped, "disabled");
  assert.equal(out.messages[0].content[0].text.length, 50_000);
});

test("开启后截断超长 tool 结果，保头保尾", () => {
  const long = "A".repeat(4_000) + "MIDDLE" + "Z".repeat(400);
  const out = compactMessages([toolResult(long)], { enabled: true, maxToolOutputChars: 1_000, keepTailChars: 200 });
  const text = out.messages[0].content[0].text;
  assert.ok(text.length < long.length);
  assert.match(text, /truncated by oc-purge/);
  assert.ok(text.startsWith("A".repeat(800)));
  assert.ok(text.endsWith("Z".repeat(200)));
  assert.equal(out.stats.truncated, 1);
});

test("短结果不动", () => {
  const out = compactMessages([toolResult("short")], { enabled: true });
  assert.equal(out.messages[0].content[0].text, "short");
  assert.equal(out.stats.truncated, 0);
});

test("重复 tool 输出只保留最后一次完整内容", () => {
  const body = "r".repeat(100);
  const messages = [toolResult(body), { role: "assistant", content: "ok" }, toolResult(body)];
  const out = compactMessages(messages, { enabled: true });
  assert.equal(out.stats.deduped, 1);
  assert.match(out.messages[0].content[0].text, /duplicate tool output elided/);
  assert.equal(out.messages[2].content[0].text, body);
});

test("不删消息条目（避免 tool_call 配对断裂）", () => {
  const messages = [toolResult("a".repeat(100)), toolResult("a".repeat(100))];
  const out = compactMessages(messages, { enabled: true });
  assert.equal(out.messages.length, messages.length);
});

test("system 段去重", () => {
  const block = "B".repeat(120);
  const system = { role: "system", content: `${block}\n\n---\n\n${block}\n\n---\n\nunique tail` };
  const out = compactMessages([system], { enabled: true });
  const text = out.messages[0].content;
  assert.equal(text.split(block).length - 1, 1, "重复块只留一份");
  assert.match(text, /unique tail/);
});

test("原数组不被就地修改", () => {
  const original = [toolResult("x".repeat(20_000))];
  const before = original[0].content[0].text;
  compactMessages(original, { enabled: true, maxToolOutputChars: 100 });
  assert.equal(original[0].content[0].text, before);
});

test("truncateMiddle 边界", () => {
  assert.equal(truncateMiddle("abc", { maxChars: 10 }), "abc");
  const t = truncateMiddle("abcdefghij", { maxChars: 6, keepTail: 2 });
  assert.match(t, /truncated/);
  assert.ok(t.endsWith("ij"));
});

test("空数组安全", () => {
  const out = compactMessages([], { enabled: true });
  assert.deepEqual(out.messages, []);
  assert.equal(out.stats.skipped, "empty");
});
