/**
 * oc-purge / hook-observer — 从真实事件里攒证据
 *
 * dsh-purge 的证据库要靠使用者手动 `record`，太麻烦。OpenCode 有事件流
 * （`session.tool.success` / `session.tool.failed` / `session.execution.failed` …），
 * 可以让账本自动落账，人只需要补 `claimed` 与结论。
 *
 * 自动落账的口径（刻意保守）：
 *   · 工具成功 → `confidence: "observed"`, `authority: "tool-output"`
 *   · 工具失败 → `confidence: "observed"`，但 `limitations` 写明失败原因
 *   - 子智能体回报 → `claimed`（必须由指挥侧 verify 才能升级）
 *
 * 隐私：只记操作名、参数摘要（截断）、结果摘要（截断），不记完整命令行以外的环境变量。
 */

import { createHash } from "node:crypto";

const MAX_TEXT = 2000;

function truncate(text, limit = MAX_TEXT) {
  const value = typeof text === "string" ? text : JSON.stringify(text);
  if (typeof value !== "string") return "";
  return value.length > limit ? `${value.slice(0, limit)}…(${value.length - limit} more chars)` : value;
}

/** 从工具调用里抽出"做什么"，避免每条都是 demo */
export function operationOf(tool, input) {
  const name = String(tool || "unknown");
  const args = input && typeof input === "object" ? input : {};
  if (typeof args.command === "string") {
    const first = args.command.trim().split(/\s+/).slice(0, 2).join(" ");
    return `${name}:${first}`.slice(0, 80);
  }
  for (const key of ["filePath", "path", "url", "pattern", "query"]) {
    if (typeof args[key] === "string") return `${name}:${args[key]}`.slice(0, 80);
  }
  return name.slice(0, 80);
}

/** 参数摘要：去掉明显的噪音字段，截断长值 */
export function summarizeParameters(input) {
  if (!input || typeof input !== "object") return {};
  const drop = new Set(["__purge_repeat", "timeout", "signal"]);
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (drop.has(key)) continue;
    if (typeof value === "string") out[key] = truncate(value, 400);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) out[key] = value;
    else out[key] = truncate(JSON.stringify(value), 400);
  }
  return out;
}

export function summarizeResult(result) {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return truncate(result);
  if (typeof result === "object") {
    const content = result.content ?? result.output ?? result.text;
    if (typeof content === "string") return truncate(content);
    return truncate(JSON.stringify(result));
  }
  return truncate(String(result));
}

/** 稳定的 target 摘要：同一主机/文件的多条证据能聚在一起 */
export function fingerprintOf(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex").slice(0, 16);
}

/**
 * 把一次工具执行记进账本。
 * @returns {{ok:boolean, ev_id?:string, duplicate?:boolean, error?:string}}
 */
export function recordToolCall(ledger, { tool, input, output, ok, sessionID, agent, durationMs } = {}) {
  if (!ledger) return { ok: false, error: "no ledger" };
  const operation = operationOf(tool, input);
  const result = ok ? summarizeResult(output) : `ERROR: ${summarizeResult(output)}`;
  return ledger.record({
    operation,
    parameters: summarizeParameters(input),
    result: result || "(empty)",
    confidence: "observed",
    authority: "tool-output",
    limitations: ok ? [] : ["tool returned an error; no target-side effect confirmed"],
    recorded_by: agent || "agent",
    source_agent: agent || null,
    engagement_id: sessionID ? `ses:${sessionID}` : undefined,
    raw_ref: durationMs !== undefined ? `duration_ms:${durationMs}` : undefined,
  });
}

/**
 * 把事件流里的一条映射成账本条目；不认识的事件返回 null。
 * 事件形状取自 `packages/schema/src/session-event.ts`（session.tool.* / session.execution.*）。
 */
export function evidenceFromEvent(event) {
  if (!event || typeof event !== "object") return null;
  const type = String(event.type || "");
  const data = event.data ?? event.properties ?? {};
  switch (type) {
    case "session.tool.success":
      return {
        tool: data.tool ?? data.name,
        input: data.input ?? data.args,
        output: data.output ?? data.result,
        ok: true,
        sessionID: data.sessionID,
        agent: data.agent,
      };
    case "session.tool.failed":
      return {
        tool: data.tool ?? data.name,
        input: data.input ?? data.args,
        output: data.error ?? data.message,
        ok: false,
        sessionID: data.sessionID,
        agent: data.agent,
      };
    case "session.execution.failed":
      return {
        tool: "session.execution",
        input: { finish: data.finish ?? data.reason },
        output: data.error ?? data.message,
        ok: false,
        sessionID: data.sessionID,
        agent: data.agent,
      };
    default:
      return null;
  }
}
