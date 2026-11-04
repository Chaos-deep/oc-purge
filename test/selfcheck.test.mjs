import test from "node:test";
import assert from "node:assert/strict";
const { selfcheck, tallyLayers, renderSelfcheck, BYPASS_LAYERS } = await import("../src/selfcheck.js");

const full = {
  injectBytes: 1200,
  capabilityProtocol: true,
  lastCardApplied: true,
  lastCardModel: "deepseek/deepseek-chat",
  permissionAutoAllow: true,
  permissionHookSeen: 3,
  hookBypass: true,
  toolBeforeSeen: 5,
  autoEvidence: true,
  evidenceCount: 2,
  retryEnabled: true,
  retrySeen: 1,
  scopeEnabled: true,
  scopeChecks: 4,
  commandsRegistered: 3,
  toolsRegistered: 5,
};

test("全绿时 ratio=1", () => {
  const report = selfcheck(full);
  assert.equal(report.failed, 0);
  assert.equal(report.pending, 0);
  assert.equal(report.ratio, 1);
});

test("未触发的是 pending 而不是 not-applicable", () => {
  const report = selfcheck({ ...full, toolBeforeSeen: 0, evidenceCount: 0 });
  const byId = Object.fromEntries(report.layers.map((l) => [l.id, l.status]));
  assert.equal(byId["tool.before"], "pending");
  assert.equal(byId["tool.after"], "pending");
  assert.ok(report.pending >= 2);
  assert.ok(report.ratio < 1, "pending 必须留在分母里");
});

test("配置关闭才算 not_applicable", () => {
  const report = selfcheck({ ...full, scopeEnabled: false, capabilityProtocol: false });
  const byId = Object.fromEntries(report.layers.map((l) => [l.id, l.status]));
  assert.equal(byId["scope.gate"], "off");
  assert.equal(byId["prompt.capability"], "off");
  assert.ok(report.not_applicable >= 2);
});

test("注入为空直接 failed", () => {
  const report = selfcheck({ ...full, injectBytes: 0, toolsRegistered: 0 });
  assert.ok(report.failed >= 2);
  assert.equal(report.ratio < 1, true);
});

test("tallyLayers 只剔除明确不适用", () => {
  const out = tallyLayers([
    { id: "a", status: "applied" },
    { id: "b", status: "pending" },
    { id: "c", status: "failed" },
    { id: "d", status: "off" },
    { id: "e", status: "na" },
  ]);
  assert.equal(out.total, 3);
  assert.equal(out.applied, 1);
  assert.equal(out.not_applicable, 2);
  assert.equal(out.ratio, 0.333);
});

test("renderSelfcheck 输出可读文本且列出失败层", () => {
  const text = renderSelfcheck(selfcheck({ injectBytes: 0, toolsRegistered: 0 }));
  assert.match(text, /✗ prompt\.inject/);
  assert.match(text, /failed layers:/);
  assert.match(text, /applied \d+\/\d+/);
});

test("每层都有 why 说明", () => {
  for (const layer of BYPASS_LAYERS) assert.ok(layer.why && layer.why.length > 5, `${layer.id} 缺 why`);
});
