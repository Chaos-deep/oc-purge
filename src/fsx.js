/**
 * oc-purge / fsx — 原子写 + 路径围栏
 *
 * 移植自 kingcharleslzy-ai/dsh-purge 的 `lib/atomic-files.js` 与 `lib/path-boundary.js`。
 * 这两个在原项目里修的是**线上问题**，不是洁癖：
 *
 *   · 原子写：直接 `writeFileSync` 到目标文件，进程被杀/断电会留下半个 JSON，
 *     下次启动解析失败 → 状态全丢。这里写临时文件再 rename。
 *     Windows 上杀软/面板轮询会让 rename 抛 EPERM/EBUSY，所以要退避重试。
 *   · 路径围栏：账本里的 `path` 列是模型自己写的（不可信）。读的时候必须确认
 *     目标在允许根内，否则 `/etc/passwd` 会被当成"证据文件"读出来。
 *     只是 `startsWith` 不够：`/a/b` 会误匹配 `/a/bb`，所以要按相对路径判断；
 *     还要处理符号链接（先 realpath），否则软链指到外面照样穿。
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const RENAME_BUSY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* 某些环境不允许 SharedArrayBuffer，退化为忙等 */
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* spin */
    }
  }
}

function renameSyncRetry(from, to, tries = 5) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return fs.renameSync(from, to);
    } catch (error) {
      if (!error || !RENAME_BUSY_CODES.has(error.code) || attempt >= tries - 1) throw error;
      sleepSync(50 * (attempt + 1));
    }
  }
}

function modeOf(file, allowMissing = false) {
  try {
    return fs.statSync(file).mode & 0o777;
  } catch (error) {
    if (allowMissing && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** 原子写：同目录临时文件 → rename。保留原文件权限位。 */
export function atomicWriteSync(file, content, encoding = "utf8", options = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const mode = modeOf(file, true) ?? options.mode ?? 0o600;
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { encoding, mode });
    renameSyncRetry(temporary, file);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* 清理失败不重要 */
    }
    throw error;
  }
  return file;
}

/** 原子追加：不重写整个文件，用于 JSONL 账本 */
export function appendSync(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, String(line).endsWith("\n") ? String(line) : `${line}\n`, "utf8");
  return file;
}

/** target 是否在 root 之内（按相对路径判断，避免 `/a/b` 匹配 `/a/bb`） */
export function within(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`));
}

/**
 * 解析真实落点：逐级向上找第一个存在的祖先，realpath 之后再把不存在的段接回去。
 * 这样符号链接（真实存在）会被解开，而"还没创建的子目录"也能算对。
 */
export function realDestination(target, io = fs) {
  let cursor = path.resolve(target);
  const missing = [];
  for (;;) {
    let stat;
    try {
      stat = io.lstatSync(cursor);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missing.unshift(path.basename(cursor));
      cursor = parent;
      continue;
    }
    if (missing.length && !stat.isDirectory() && !stat.isSymbolicLink()) {
      const error = new Error(`Not a directory: ${cursor}`);
      error.code = "ENOTDIR";
      throw error;
    }
    return path.resolve(io.realpathSync(cursor), ...missing);
  }
}

/**
 * 断言 target 落在某个允许根内；返回规范化绝对路径，越界抛错。
 * 调用方对越界应当"当作查不到"，不要静默返回内容。
 */
export function assertWithinRoots(target, allowedRoots, io = fs) {
  if (!target || typeof target !== "string") throw new Error("path is required");
  const roots = (Array.isArray(allowedRoots) ? allowedRoots : [allowedRoots]).filter(Boolean).map(String);
  if (roots.length === 0) throw new Error("no allowed roots configured");

  let resolved;
  try {
    resolved = realDestination(target, io);
  } catch (error) {
    if (error.code === "ENOTDIR") throw new Error(`not a directory in path: ${target}`);
    // 目标完全不存在时不 realpath，退回纯 resolve
    resolved = path.resolve(target);
  }

  for (const root of roots) {
    let realRoot;
    try {
      realRoot = realDestination(root, io);
    } catch {
      realRoot = path.resolve(root);
    }
    if (within(realRoot, resolved)) return resolved;
  }
  const error = new Error(`path escapes allowed roots: ${target}`);
  error.code = "OUTSIDE_ROOTS";
  throw error;
}

/** 安全读：越界 / 不存在 / 非普通文件一律返回 undefined，不抛 */
export function readWithin(target, allowedRoots, { maxBytes = 256 * 1024 } = {}, io = fs) {
  let resolved;
  try {
    resolved = assertWithinRoots(target, allowedRoots, io);
  } catch {
    return undefined;
  }
  try {
    const stat = io.statSync(resolved);
    if (!stat.isFile()) return undefined;
    if (stat.size > maxBytes) return undefined;
    return io.readFileSync(resolved, "utf8");
  } catch {
    return undefined;
  }
}
