import test from "node:test";
import assert from "node:assert/strict";
const { rewriteShell, applyAliases, prependOnce, checkDeny, proxyPrefix, shellQuote } = await import("../src/shexec.js");

test("env 注入：默认项不覆盖已有值", () => {
  const out = rewriteShell({ command: "ls", env: { PAGER: "less" } }, { declareEnv: { FOO: "1" } });
  assert.equal(out.env.PAGER, "less", "用户已有的 PAGER 不能被默认静默项覆盖");
  assert.equal(out.env.FOO, "1");
  assert.equal(out.env.NO_COLOR, "1");
});

test("declareEnv 设 null 等于删除", () => {
  const out = rewriteShell({ command: "ls", env: { SECRET: "x" } }, { declareEnv: { SECRET: null } });
  assert.equal("SECRET" in out.env, false);
});

test("alias 只改首词，不碰管道后半段", () => {
  assert.equal(applyAliases("nmap 10.0.0.1 | grep open", { nmap: "nmap -sV" }), "nmap -sV 10.0.0.1 | grep open");
  assert.equal(applyAliases("echo nmap", { nmap: "nmap -sV" }), "echo nmap");
});

test("alias 最长优先，避免 l 抢 ls", () => {
  assert.equal(applyAliases("ls -la", { l: "l-alias", ls: "ls --color=never" }), "ls --color=never -la");
});

test("alias 保留 sudo 前缀", () => {
  assert.equal(applyAliases("sudo -E nmap 10.0.0.1", { nmap: "nmap -sV" }), "sudo -E nmap -sV 10.0.0.1");
});

test("prependOnce 幂等", () => {
  assert.equal(prependOnce("ls", "time"), "time ls");
  assert.equal(prependOnce("time ls", "time"), "time ls");
});

test("checkDeny 命中返回原因", () => {
  assert.equal(checkDeny("rm -rf /", ["rm -rf /"]).allowed, false);
  assert.equal(checkDeny("ls", ["rm -rf /"]).allowed, true);
  assert.match(checkDeny("curl http://x", [{ pattern: "curl", reason: "no curl" }]).reason, /no curl/);
});

test("checkDeny 非法正则跳过而不是全拒", () => {
  assert.equal(checkDeny("ls", ["[bad"]).allowed, true);
});

test("deny 命中时不改命令", () => {
  const out = rewriteShell({ command: "rm -rf /", env: {} }, { deny: ["rm -rf /"], declareEnv: { A: "1" } });
  assert.match(out.denied, /matched deny pattern: rm -rf \//);
  assert.equal(out.command, "rm -rf /");
  assert.deepEqual(out.env, {});
});

test("proxy 前缀注入四个变量", () => {
  const prefix = proxyPrefix("http://127.0.0.1:7890");
  assert.match(prefix, /export http_proxy=http:\/\/127\.0\.0\.1:7890/);
  assert.match(prefix, /export HTTPS_PROXY=/);
  assert.match(prefix, /no_proxy=/);
});

test("rewriteShell 组合：alias + prepend + proxy", () => {
  const out = rewriteShell(
    { command: "curl http://t", env: {} },
    { aliases: { curl: "curl -sS" }, prepend: "time", proxy: "http://127.0.0.1:7890" },
  );
  assert.equal(out.changed, true);
  assert.match(out.command, /export http_proxy=/);
  assert.match(out.command, /;time curl -sS http:\/\/t$/);
});

test("无需改动时 changed=false", () => {
  const out = rewriteShell({ command: "ls", env: { NO_COLOR: "1", LESS: "-R", PAGER: "cat", GIT_PAGER: "cat" } }, {});
  assert.equal(out.changed, false);
  assert.equal(out.command, "ls");
});

test("shellQuote 处理引号", () => {
  assert.equal(shellQuote("a b"), "'a b'");
  assert.equal(shellQuote("x'y"), `'x'\\''y'`);
  assert.equal(shellQuote("plain"), "plain");
});
