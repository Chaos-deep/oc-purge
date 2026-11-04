/**
 * oc-purge / replay — 把每条证据变成"能照着做一遍"的复现入口
 *
 * 移植自 kingcharleslzy-ai/dsh-purge 的 `lib/redteam/report-replay.js`。
 * 原项目的两条底线，这里原样保留：
 *
 *   1. **合成的东西必须标注来源**（`synthesized: true`）—— 推断出来的请求与真实抓包
 *      在可信度上不是一回事，报告里要能一眼分辨。
 *   2. **只在信息足够时合成** —— 有 URL 或有明确的 curl 命令才合成，否则宁可留空
 *      并给补录指引，不编造。
 *
 * 实现上补了一处上游踩过的坑：IPv6 字面量 `http://[::1]:8080/x` 里
 * "地址内部的冒号" 与 "端口分隔冒号" 混在一起，一条正则一起抓会把 host 解析成
 * `::1:`、path 变成 `:8080/x`。这里先按方括号取 authority，再剥端口。
 */

/** 解析 target：`http://h:8080/p` / `10.0.0.5:6379` / `[::1]:22` */
export function parseTarget(target) {
  const text = String(target ?? "").trim();
  if (text === "") return null;

  const withScheme = /^([a-z][a-z0-9+.-]*):\/\/([^/?#\s]*)([^?#\s]*)?/i.exec(text);
  if (withScheme) {
    const scheme = withScheme[1].toLowerCase();
    const authority = withScheme[2] || "";
    const path = withScheme[3] || "/";
    const { host, port, ipv6 } = splitAuthority(authority);
    if (!host) return null;
    return { scheme, host, port, path, authority, ipv6 };
  }

  // 没有 scheme：`host:port` 或 `[ipv6]:port`
  const bare = /^(\[[^\]]+\]|[^\s/?#:]+)(?::(\d+))?(\/[^\s?#]*)?$/.exec(text);
  if (bare) {
    const hostRaw = bare[1];
    const ipv6 = hostRaw.startsWith("[");
    const host = ipv6 ? hostRaw.slice(1, -1) : hostRaw;
    const port = bare[2] ? Number(bare[2]) : null;
    const path = bare[3] || null;
    return { scheme: null, host, port, path, authority: text, ipv6 };
  }

  const head = /^([^\s/?#]+)/.exec(text);
  if (!head) return null;
  return { scheme: null, host: head[1], port: null, path: null, authority: text, ipv6: false };
}

function splitAuthority(authority) {
  const raw = String(authority ?? "");
  // userinfo 先剥掉（curl -u 之类不走这里，但 URL 里可能有）
  const at = raw.lastIndexOf("@");
  const core = at >= 0 ? raw.slice(at + 1) : raw;

  if (core.startsWith("[")) {
    const close = core.indexOf("]");
    if (close === -1) return { host: core, port: null, ipv6: true };
    const host = core.slice(1, close);
    const rest = core.slice(close + 1);
    const port = rest.startsWith(":") && /^\d+$/.test(rest.slice(1)) ? Number(rest.slice(1)) : null;
    return { host, port, ipv6: true };
  }

  const colon = core.lastIndexOf(":");
  if (colon === -1) return { host: core, port: null, ipv6: false };
  const hostPart = core.slice(0, colon);
  const portPart = core.slice(colon + 1);
  if (!/^\d+$/.test(portPart)) return { host: core, port: null, ipv6: false };
  return { host: hostPart, port: Number(portPart), ipv6: false };
}

/** 这条命令看起来是什么工具 */
export function commandKind(tool) {
  const text = String(tool ?? "").trim();
  if (text === "") return null;
  if (/^curl\b/i.test(text)) return "curl";
  if (/^http(ie| x)?\b/i.test(text) || /^http\s/i.test(text)) return "httpie";
  if (/^(nuclei|ffuf|feroxbuster|gobuster|dirsearch|sqlmap|hydra|nmap|masscan|fscan|gogo)\b/i.test(text))
    return "scanner";
  if (/^(msfconsole|use\s|set\s)/i.test(text)) return "msf";
  if (/^(python|python3|java|go run|node)\b/i.test(text)) return "script";
  return "other";
}

/** 从 curl 命令里保守地抽 URL / 方法 / 头。抽不出就返回 null，不猜。 */
export function parseCurl(tool) {
  const text = String(tool ?? "").trim();
  if (!/^curl\b/i.test(text)) return null;
  const urlMatch = /(https?:\/\/[^\s'"]+)/i.exec(text);
  if (!urlMatch) return null;
  const methodMatch = /(?:-X|--request)\s+([A-Z]+)/i.exec(text);
  const dataMatch = /(?:-d|--data(?:-raw|-binary|-urlencode)?)\s+(?:'([^']*)'|"([^"]*)"|(\S+))/i.exec(text);
  const headerMatches = Array.from(text.matchAll(/(?:-H|--header)\s+(?:'([^']*)'|"([^"]*)")/gi))
    .map((match) => (match[1] !== undefined ? match[1] : match[2]))
    .filter((value) => typeof value === "string" && value.includes(":"));
  const cookieMatch = /(?:-b|--cookie)\s+(?:'([^']*)'|"([^"]*)"|(\S+))/i.exec(text);
  const data = dataMatch === null ? null : (dataMatch[1] ?? dataMatch[2] ?? dataMatch[3] ?? null);
  const method = methodMatch !== null ? methodMatch[1].toUpperCase() : data === null ? "GET" : "POST";
  return {
    url: urlMatch[1],
    method,
    data,
    headers: headerMatches,
    cookie: cookieMatch === null ? null : (cookieMatch[1] ?? cookieMatch[2] ?? cookieMatch[3] ?? null),
    insecure: /(^|\s)-k(\s|$)|--insecure/.test(text),
    followRedirect: /(^|\s)-L(\s|$)|--location/.test(text),
  };
}

/**
 * 合成一条能粘进 Repeater 的 HTTP 报文。
 * 信息不足（没有可解析的 URL）返回 null。
 */
export function buildHttpRequest(options = {}) {
  const target = parseTarget(options.url);
  if (!target) return null;

  const scheme = target.scheme || "http";
  const hostText = target.ipv6 ? `[${target.host}]` : target.host;
  const defaultPort = scheme === "https" ? 443 : 80;
  const hostHeader =
    target.port !== null && target.port !== defaultPort ? `${hostText}:${target.port}` : hostText;
  const path =
    options.path !== undefined && options.path !== null && options.path !== ""
      ? options.path
      : target.path || "/";
  const method = String(
    options.method ?? (options.data === undefined || options.data === null ? "GET" : "POST"),
  ).toUpperCase();

  const headers = Array.isArray(options.headers) ? options.headers.slice() : [];
  const hasHeader = (name) =>
    headers.some((header) => String(header).toLowerCase().startsWith(`${name.toLowerCase()}:`));

  if (!hasHeader("User-Agent")) headers.push("User-Agent: Mozilla/5.0");
  if (!hasHeader("Accept")) headers.push("Accept: */*");
  if (options.cookie && !hasHeader("Cookie")) headers.push(`Cookie: ${options.cookie}`);

  const body = options.data === undefined || options.data === null ? "" : String(options.data);
  if (body !== "" && !hasHeader("Content-Type")) {
    headers.push(
      /^\{.*\}$/.test(body.trim())
        ? "Content-Type: application/json"
        : "Content-Type: application/x-www-form-urlencoded",
    );
  }
  if (body !== "" && !hasHeader("Content-Length")) {
    headers.push(`Content-Length: ${Buffer.byteLength(body, "utf8")}`);
  }
  if (!hasHeader("Connection")) headers.push("Connection: close");

  return [`${method} ${path} HTTP/1.1`, `Host: ${hostHeader}`, ...headers, "", body].join("\r\n");
}

/** 合成一条"直接在终端能跑"的复现命令 */
export function buildCurlCommand(options = {}) {
  const { url, method, data, headers = [], cookie, insecure, followRedirect } = options;
  if (!parseTarget(url)) return null;
  const parts = ["curl", "-sS"];
  if (insecure) parts.push("-k");
  if (followRedirect) parts.push("-L");
  if (method && String(method).toUpperCase() !== "GET") parts.push("-X", String(method).toUpperCase());
  for (const header of headers) parts.push("-H", shellQuote(header));
  if (cookie) parts.push("-b", shellQuote(cookie));
  if (data !== undefined && data !== null && data !== "") parts.push("--data-raw", shellQuote(String(data)));
  parts.push(shellQuote(url));
  return parts.join(" ");
}

function shellQuote(value) {
  const text = String(value ?? "");
  if (text === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * 从一条账本行合成复现材料。
 * @param {{ operation:string, parameters?:object, result?:any }} row
 * @returns {{kind:string, command?:string, http?:string, synthesized:boolean, note?:string}}
 */
export function replayFromEvidence(row = {}) {
  const params = row.parameters && typeof row.parameters === "object" ? row.parameters : {};
  const command = typeof params.command === "string" ? params.command.trim() : "";
  const url = typeof params.url === "string" ? params.url : typeof params.href === "string" ? params.href : "";

  // 1) 有真实命令且是 curl → 原样保留命令，另附一份合成报文（标注 synthesized）
  if (command) {
    const kind = commandKind(command) || "other";
    if (kind === "curl") {
      const parsed = parseCurl(command);
      if (parsed) {
        return {
          kind,
          command,
          http: buildHttpRequest(parsed) ?? undefined,
          synthesized: true,
          note: "报文由 curl 命令合成，命令本身来自原始记录",
        };
      }
    }
    return { kind, command, synthesized: false };
  }

  // 2) 只有 URL → 合成 curl + 报文
  if (url) {
    const target = parseTarget(url);
    if (target) {
      const command = buildCurlCommand({ url, method: "GET" });
      return {
        kind: "http",
        command: command ?? undefined,
        http: buildHttpRequest({ url }) ?? undefined,
        synthesized: true,
        note: "没有原始命令，按 URL 合成；需要真实报文请补录原始请求",
      };
    }
  }

  // 3) 什么都没有 → 留空并给补录指引，不编造
  return {
    kind: "unknown",
    synthesized: false,
    note: "证据里没有 command/url，无法复现；下次执行时请保留原始命令",
  };
}
