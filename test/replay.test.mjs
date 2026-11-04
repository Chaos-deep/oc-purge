import test from "node:test";
import assert from "node:assert/strict";
const { parseTarget, commandKind, parseCurl, buildHttpRequest, buildCurlCommand, replayFromEvidence } = await import("../src/replay.js");

test("parseTarget 解析 IPv6（上游踩过的坑）", () => {
  const t = parseTarget("http://[2001:db8::1]:8080/x");
  assert.equal(t.host, "2001:db8::1");
  assert.equal(t.port, 8080);
  assert.equal(t.path, "/x");
  assert.equal(t.ipv6, true);
});

test("parseTarget 裸 host:port 与 https", () => {
  assert.deepEqual(
    (({ host, port, scheme }) => ({ host, port, scheme }))(parseTarget("10.0.0.5:6379")),
    { host: "10.0.0.5", port: 6379, scheme: null },
  );
  const s = parseTarget("https://api.example.com/v1/users?id=1");
  assert.equal(s.scheme, "https");
  assert.equal(s.host, "api.example.com");
  assert.equal(s.path, "/v1/users");
});

test("parseTarget 对垃圾返回 null", () => {
  assert.equal(parseTarget(""), null);
  assert.equal(parseTarget(null), null);
});

test("commandKind 分类", () => {
  assert.equal(commandKind("curl -sS http://a"), "curl");
  assert.equal(commandKind("nmap -sV 10.0.0.1"), "scanner");
  assert.equal(commandKind("python3 x.py"), "script");
  assert.equal(commandKind(""), null);
});

test("parseCurl 抽方法/头/cookie", () => {
  const parsed = parseCurl("curl -X POST -H 'Content-Type: application/json' -d '{\"a\":1}' http://t/api");
  assert.equal(parsed.method, "POST");
  assert.equal(parsed.data, '{"a":1}');
  assert.deepEqual(parsed.headers, ["Content-Type: application/json"]);
  assert.equal(parseCurl("wget http://x"), null);
});

test("buildHttpRequest 带方括号 Host（RFC 3986）", () => {
  const req = buildHttpRequest({ url: "http://[::1]:8080/a" });
  assert.match(req, /^GET \/a HTTP\/1\.1\r\n/);
  assert.match(req, /Host: \[::1\]:8080/);
  assert.match(req, /Connection: close/);
});

test("buildHttpRequest 自动补 Content-Type/Length", () => {
  const req = buildHttpRequest({ url: "http://t/x", method: "POST", data: '{"a":1}' });
  assert.match(req, /Content-Type: application\/json/);
  assert.match(req, /Content-Length: 7/);
});

test("buildHttpRequest 对无 URL 返回 null", () => {
  assert.equal(buildHttpRequest({ url: "" }), null);
});

test("buildCurlCommand 正确转义", () => {
  const cmd = buildCurlCommand({ url: "http://t/a b", method: "POST", data: "x'y" });
  assert.match(cmd, /curl -sS/);
  assert.match(cmd, /'http:\/\/t\/a b'/);
  assert.match(cmd, /--data-raw 'x'\\''y'/);
});

test("replayFromEvidence：真实 curl 保留命令 + 标注合成报文", () => {
  const out = replayFromEvidence({
    operation: "bash:curl",
    parameters: { command: "curl -sS http://10.0.0.5:8080/admin" },
  });
  assert.equal(out.kind, "curl");
  assert.equal(out.command, "curl -sS http://10.0.0.5:8080/admin");
  assert.equal(out.synthesized, true);
  assert.match(out.http, /GET \/admin/);
});

test("replayFromEvidence：非 curl 命令不合成报文", () => {
  const out = replayFromEvidence({ parameters: { command: "nmap -sV 10.0.0.5" } });
  assert.equal(out.kind, "scanner");
  assert.equal(out.http, undefined);
  assert.equal(out.synthesized, false);
});

test("replayFromEvidence：只有 URL 时合成并标注", () => {
  const out = replayFromEvidence({ parameters: { url: "https://t/api" } });
  assert.equal(out.kind, "http");
  assert.equal(out.synthesized, true);
  assert.match(out.note, /补录/);
});

test("replayFromEvidence：什么都没有就留空，不编造", () => {
  const out = replayFromEvidence({ parameters: {} });
  assert.equal(out.kind, "unknown");
  assert.equal(out.command, undefined);
  assert.equal(out.http, undefined);
  assert.match(out.note, /无法复现/);
});
