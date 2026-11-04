/**
 * oc-purge / shexec — 在 shell 真正执行前改写命令与环境
 *
 * 对应 `shell.hook("create.before")`。宿主在 `packages/core/src/shell.ts:284` 触发它，
 * 事件对象 `{ command, cwd, timeout, shell, env }` 是**可变**的，改完立即用于执行。
 *
 * 能做的事（按风险从低到高）：
 *   · 注入 env：代理、时区、工具路径、`LC_ALL`
 *   · 命令前缀：`export FOO=1 &&`、`time`、`nohup`
 *   · 别名改写：把 `nmap` 换成带默认参数的版本
 *   · 硬拦截：命中 scope 之外的命令直接抛错（在 tool.execute.before 之外的第二道闸）
 *
 * 刻意**不做**的事：
 *   · 不解析完整 shell 语法。只在命令层做「前缀 + 首词替换 + 正则拒绝」，
 *     不做 AST 改写 —— 一旦解析错就会把用户命令改成别的意思，比不干更糟。
 */

/** 默认会被注入的环境变量（安全、无副作用） */
export const SAFE_ENV_DEFAULTS = Object.freeze({
  LESS: "-R",
  PAGER: "cat",
  GIT_PAGER: "cat",
  NO_COLOR: "1",
});

/**
 * 是否需要在命令前包一层代理变量。
 * 返回空串表示不包。
 */
export function proxyPrefix(proxy) {
  const url = String(proxy ?? "").trim();
  if (!url) return "";
  const quoted = shellQuote(url);
  return [
    `export http_proxy=${quoted}`,
    `export https_proxy=${quoted}`,
    `export HTTP_PROXY=${quoted}`,
    `export HTTPS_PROXY=${quoted}`,
    `export no_proxy=${shellQuote(process.env.NO_PROXY || "127.0.0.1,localhost")}`,
  ].join("; ");
}

export function shellQuote(value) {
  const text = String(value ?? "");
  if (text === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * 按 aliases 改写命令首词。
 * aliases 形如 `{ "nmap": "nmap -sV --reason", "ls": "ls --color=never" }`。
 * 只在**命令开头**命中（允许前导空白与 `sudo ` 前缀），不替换管道后面的段。
 */
export function applyAliases(command, aliases = {}) {
  const text = String(command ?? "");
  if (!text) return text;
  const entries = Object.entries(aliases).filter(([key, value]) => key && typeof value === "string");
  if (entries.length === 0) return text;
  // 最长优先，避免 `l` 抢走 `ls`
  entries.sort((a, b) => b[0].length - a[0].length);

  for (const [from, to] of entries) {
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 只匹配开头（可有 sudo / env 前缀），后面必须跟空白或结尾
    const re = new RegExp(`^(\\s*(?:sudo\\s+(?:-\\S+\\s+)*)?)${escaped}(?=\\s|$)`, "");
    if (re.test(text)) return text.replace(re, `$1${to}`);
  }
  return text;
}

/** 在命令前加前缀（幂等：已经以该前缀开头就不再加） */
export function prependOnce(command, prefix) {
  const text = String(command ?? "");
  const head = String(prefix ?? "").trim();
  if (!head) return text;
  if (text.trimStart().startsWith(head)) return text;
  return `${head} ${text}`;
}

/**
 * 校验命令是否允许执行。返回 `{ allowed, reason }`。
 * deny 里每项是正则字符串或 `{ pattern, reason }`。
 */
export function checkDeny(command, deny = []) {
  const text = String(command ?? "");
  for (const item of Array.isArray(deny) ? deny : []) {
    const pattern = typeof item === "string" ? item : item?.pattern;
    if (!pattern) continue;
    let re;
    try {
      re = new RegExp(pattern, "i");
    } catch {
      continue; // 非法正则跳过，不能因为配置写错就把一切都拒了
    }
    if (re.test(text)) {
      return {
        allowed: false,
        reason: typeof item === "object" ? item.reason || `matched deny pattern: ${pattern}` : `matched deny pattern: ${pattern}`,
      };
    }
  }
  return { allowed: true, reason: "" };
}

/**
 * 一次完整的改写。纯函数，不改入参。
 * @param {{ command:string, cwd?:string, env?:object }} event
 * @param {{ declareEnv?:object, aliases?:object, prepend?:string, proxy?:string, deny?:Array, quiet?:boolean }} cfg
 * @returns {{ command:string, env:object, changed:boolean, denied?:string }}
 */
export function rewriteShell(event = {}, cfg = {}) {
  const original = {
    command: String(event.command ?? ""),
    env: { ...(event.env ?? {}) },
  };
  let command = original.command;
  const env = { ...original.env };

  // 1) 拒绝优先：命中就不碰命令
  const verdict = checkDeny(command, cfg.deny);
  if (!verdict.allowed) {
    return { command: original.command, env: original.env, changed: false, denied: verdict.reason };
  }

  // 2) env：默认静默项 < 用户声明
  for (const [key, value] of Object.entries(SAFE_ENV_DEFAULTS)) {
    if (env[key] === undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(cfg.declareEnv ?? {})) {
    if (value === null || value === undefined) delete env[key];
    else env[key] = String(value);
  }

  // 3) 命令改写：alias → 前缀（含代理）
  command = applyAliases(command, cfg.aliases);
  const segments = [];
  const proxy = proxyPrefix(cfg.proxy);
  if (proxy) segments.push(`${proxy};`);
  const prepend = String(cfg.prepend ?? "").trim();
  if (prepend) segments.push(`${prepend} `);
  if (segments.length) command = `${segments.join("")}${command}`;

  const changed = command !== original.command || JSON.stringify(env) !== JSON.stringify(original.env);
  return { command, env, changed, denied: undefined };
}
