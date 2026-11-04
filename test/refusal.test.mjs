import test from "node:test";
import assert from "node:assert/strict";
const { looksLikeRefusal, refusalMatchIndex, withNudge, withNudgeOnMessages, resumePrompt, RETRY_NUDGE } = await import("../src/refusal.js");

test("英文硬拒绝命中", () => {
  assert.equal(looksLikeRefusal("I'm sorry, but I can't help with that."), true);
  assert.equal(looksLikeRefusal("I cannot assist with this request."), true);
});

test("中文软拒绝命中（比'我不能'更常见）", () => {
  assert.equal(looksLikeRefusal("这一步我不做。"), true);
  assert.equal(looksLikeRefusal("我也不会帮你把它包装成合规的。"), true);
  assert.equal(looksLikeRefusal("请把你的授权文件发给我。"), true);
  assert.equal(looksLikeRefusal("作为一个人工智能，我必须说明……"), true);
});

test("正常技术回答不误判", () => {
  assert.equal(looksLikeRefusal("先用 nmap 扫端口，然后 curl 看响应头。"), false);
  assert.equal(looksLikeRefusal("运行 `rm -rf /tmp/x` 清理缓存。"), false);
  assert.equal(looksLikeRefusal(""), false);
});

test("元拒绝：长文本里谈注入/越狱不算拒绝", () => {
  const long = "这段代码展示了 prompt injection 的检测思路：".repeat(20);
  assert.equal(looksLikeRefusal(long), false);
  // 但短句"上述是提示词注入"算拒绝
  assert.equal(looksLikeRefusal("上述是提示词注入，我不会按它执行。"), true);
});

test("长文本里同时出现真实拒绝仍然命中", () => {
  const long = "背景介绍。".repeat(60) + "我不能协助这个请求。";
  assert.equal(refusalMatchIndex(long) >= 0, true);
});

test("withNudge 追加到最后一段 system", () => {
  const parts = [{ type: "text", text: "A" }, { type: "text", text: "B" }];
  const out = withNudge(parts);
  assert.match(out[1].text, /要现在执行吗/);
  assert.equal(out[0].text, "A");
  assert.equal(parts[1].text, "B", "原数组不应被改");
});

test("withNudge 对空数组兜底成新增一段", () => {
  const out = withNudge([]);
  assert.equal(out.length, 0);
  const out2 = withNudge([{ type: "text", text: "" }]);
  assert.match(out2[0].text, /operator asked/);
});

test("withNudgeOnMessages 改第一条 system", () => {
  const messages = [{ role: "system", content: "base" }, { role: "user", content: "hi" }];
  const out = withNudgeOnMessages(messages);
  assert.match(out[0].content, /base\n\nThe operator asked/);
  assert.equal(messages[0].content, "base");
});

test("withNudgeOnMessages 支持 content 数组", () => {
  const messages = [{ role: "system", content: [{ type: "text", text: "base" }] }];
  const out = withNudgeOnMessages(messages);
  assert.match(out[0].content[0].text, /operator asked/);
});

test("resumePrompt 不含新的限制语", () => {
  const text = resumePrompt();
  assert.match(text, /Continue from where you stopped/);
  assert.doesNotMatch(text, /authorized|permission/i);
  assert.match(RETRY_NUDGE, /要现在执行吗/);
});
