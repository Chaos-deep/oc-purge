/**
 * 证据账本：语义哈希、去重、核对、Residual Unknown
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { EvidenceLedger, evidenceId, canonicalize, tunnelIsLegit, CONFIDENCE_REQUIRES_VERIFICATION } = await import(
  "../src/evidence.js"
);

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocpurge-ev-"));
  return { dir, ledger: new EvidenceLedger({ file: path.join(dir, "evidence.jsonl"), engagement: "t1" }) };
}

test("canonicalize 对键序不敏感", () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
});

test("同一语义 → 同一 ev_id；改一个字 → 变", () => {
  const a = evidenceId({ operation: "nmap", result: "22/open" });
  const b = evidenceId({ result: "22/open", operation: "nmap" });
  const c = evidenceId({ operation: "nmap", result: "22/closed" });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^ev_[0-9a-f]{64}$/);
});

test("record 去重 + get 回读", () => {
  const { ledger } = fresh();
  const first = ledger.record({ operation: "nmap_scan", parameters: { host: "10.0.0.5" }, result: "22/open" });
  const second = ledger.record({ operation: "nmap_scan", parameters: { host: "10.0.0.5" }, result: "22/open" });
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  const row = ledger.get(first.ev_id);
  assert.equal(row.operation, "nmap_scan");
  assert.deepEqual(row.parameters, { host: "10.0.0.5" });
});

test("非法置信度被拒", () => {
  const { ledger } = fresh();
  const out = ledger.record({ operation: "x", result: "y", confidence: "definitely" });
  assert.equal(out.ok, false);
  assert.match(out.error, /confidence/);
});

test("verify：子智能体改了一个字就 MISMATCH", () => {
  const { ledger } = fresh();
  const recorded = ledger.record({
    operation: "curl_probe",
    parameters: { url: "http://t/a" },
    result: "200",
    confidence: "observed",
  });
  const ok = ledger.verify({ operation: "curl_probe", parameters: { url: "http://t/a" }, result: "200", confidence: "observed" });
  const bad = ledger.verify({ operation: "curl_probe", parameters: { url: "http://t/a" }, result: "500", confidence: "observed" });
  assert.equal(ok.matched, true);
  assert.equal(ok.expected_ev_id, recorded.ev_id);
  assert.equal(bad.matched, false);
  assert.equal(bad.actual_ev_id, recorded.ev_id);
});

test("stats：claimed/inferred 计入未核实", () => {
  const { ledger } = fresh();
  ledger.record({ operation: "a", result: "1", confidence: "observed" });
  ledger.record({ operation: "b", result: "2", confidence: "claimed", authority: "subagent-report" });
  const stats = ledger.stats();
  assert.equal(stats.total, 2);
  assert.equal(stats.byConfidence.observed, 1);
  assert.equal(stats.unverified, 1);
  assert.equal(stats.verifiedRatio, 0.5);
  assert.equal(CONFIDENCE_REQUIRES_VERIFICATION.has("claimed"), true);
});

test("residual unknown 生命周期", () => {
  const { ledger } = fresh();
  const opened = ledger.openUnknown({ question: "22 端口可能是 SSH 但没凭据", severity: "high" });
  assert.equal(opened.ok, true);
  assert.equal(ledger.listUnknown({ status: "open" }).length, 1);
  const done = ledger.resolveUnknown({ unk_id: opened.unk_id, status: "resolved", resolution: "密码复用登录成功" });
  assert.equal(done.ok, true);
  const rows = ledger.listUnknown();
  assert.equal(rows[0].status, "resolved");
  assert.equal(rows[0].revision, 2);
  assert.equal(rows[0].resolution, "密码复用登录成功");
});

test("隧道口径：self-only 不算边界突破", () => {
  assert.equal(tunnelIsLegit("self-only"), false);
  assert.equal(tunnelIsLegit("target-outbound"), true);
  assert.equal(tunnelIsLegit(""), null);
});
