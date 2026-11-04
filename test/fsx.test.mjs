import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { atomicWriteSync, appendSync, within, realDestination, assertWithinRoots, readWithin } = await import("../src/fsx.js");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ocpurge-fsx-"));
}

test("atomicWriteSync 写入并保留权限", () => {
  const dir = tmp();
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, "old");
  fs.chmodSync(file, 0o640);
  atomicWriteSync(file, '{"a":1}');
  assert.equal(fs.readFileSync(file, "utf8"), '{"a":1}');
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp")).length, 0, "不留临时文件");
});

test("atomicWriteSync 创建父目录", () => {
  const dir = tmp();
  const file = path.join(dir, "deep", "nested", "x.json");
  atomicWriteSync(file, "{}");
  assert.equal(fs.readFileSync(file, "utf8"), "{}");
});

test("appendSync 追加而非覆盖", () => {
  const dir = tmp();
  const file = path.join(dir, "ev.jsonl");
  appendSync(file, "a");
  appendSync(file, "b\n");
  assert.equal(fs.readFileSync(file, "utf8"), "a\nb\n");
});

test("within 不让 /a/b 匹配 /a/bb", () => {
  assert.equal(within("/a/b", "/a/b/c"), true);
  assert.equal(within("/a/b", "/a/b"), true);
  assert.equal(within("/a/b", "/a/bb"), false);
  assert.equal(within("/a/b", "/a/b/../c"), false);
});

test("within 不做前缀误判", () => {
  assert.equal(within("/srv/app", "/srv/application/x"), false);
});

test("realDestination 解开符号链接", () => {
  const dir = tmp();
  const outside = path.join(dir, "outside");
  fs.mkdirSync(outside);
  const link = path.join(dir, "link");
  fs.symlinkSync(outside, link);
  assert.equal(realDestination(path.join(link, "x")), path.join(fs.realpathSync(outside), "x"));
});

test("realDestination 处理尚不存在的子目录", () => {
  const dir = tmp();
  assert.equal(realDestination(path.join(dir, "a", "b", "c")), path.join(fs.realpathSync(dir), "a", "b", "c"));
});

test("assertWithinRoots 允许根内、拒绝根外", () => {
  const dir = tmp();
  const root = path.join(dir, "root");
  fs.mkdirSync(root);
  const ok = path.join(root, "a.txt");
  fs.writeFileSync(ok, "x");
  assert.equal(assertWithinRoots(ok, [root]), fs.realpathSync(ok));
  assert.throws(() => assertWithinRoots("/etc/passwd", [root]), /escapes allowed roots/);
});

test("assertWithinRoots 拦住符号链接穿越", () => {
  const dir = tmp();
  const root = path.join(dir, "root");
  const secret = path.join(dir, "secret.txt");
  fs.mkdirSync(root);
  fs.writeFileSync(secret, "TOP SECRET");
  fs.symlinkSync(secret, path.join(root, "link.txt"));
  assert.throws(() => assertWithinRoots(path.join(root, "link.txt"), [root]), /escapes allowed roots/);
});

test("readWithin 越界返回 undefined 而不抛", () => {
  const dir = tmp();
  const root = path.join(dir, "root");
  fs.mkdirSync(root);
  assert.equal(readWithin("/etc/passwd", [root]), undefined);
  assert.equal(readWithin(path.join(root, "missing.txt"), [root]), undefined);
});

test("readWithin 超过 maxBytes 拒绝", () => {
  const dir = tmp();
  const root = path.join(dir, "root");
  fs.mkdirSync(root);
  const file = path.join(root, "big.txt");
  fs.writeFileSync(file, "x".repeat(1000));
  assert.equal(readWithin(file, [root], { maxBytes: 10 }), undefined);
  assert.equal(readWithin(file, [root], { maxBytes: 2000 }), "x".repeat(1000));
});
