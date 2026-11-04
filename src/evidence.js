/**
 * oc-purge / evidence-ledger — 证据账本
 *
 * 移植自 dsh-purge `lib/redteam/evidence-ledger.mjs`，语义原样保留：
 *
 *   claimed   子智能体口头说"我拿到了"       —— 绝不能直接信
 *   observed  工具回显 / 数据库记录证实       —— 核对后采信
 *   derived   从 observed 推理出来的
 *   inferred  推测，必须标注
 *
 * 每条 evidence 有 `ev_<sha256>` 的**语义哈希**：规范化 JSON（键按码点排序）后取 SHA-256。
 * 内容同 → 哈希同；改一个字 → 哈希变。落库时可以验"子智能体说 A、库里记的是不是 A"。
 *
 * 与 dsh-purge 的差异：
 *   - 不依赖 `node:sqlite`（OpenCode 宿主不一定给 DatabaseSync）。默认落 JSONL 追加归档，
 *     读时全量扫描；数据量到万级再换 SQLite（`adapter` 参数留了口子）。
 *   - 增加 `engagement`（作战名）分区，一个文件里可以放多次演练。
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const EVIDENCE_CONFIDENCE = ["claimed", "observed", "derived", "inferred"];

export const EVIDENCE_AUTHORITY = [
  "tool-output", // nmap / curl / fscan 原始回显
  "database-record", // 库里已存在的行
  "screenshot", // 现场截图
  "request-replay", // HTTP 原始请求重放成功
  "subagent-report", // 子智能体回报（= claimed，必须核对）
  "operator-input", // 操作者提供
];

/** 子智能体回报必须经核实才能从 claimed 升级为 observed */
export const CONFIDENCE_REQUIRES_VERIFICATION = new Set(["claimed", "inferred"]);

export const RESIDUAL_STATUS = ["open", "investigating", "blocked", "contradicted", "resolved"];
export const RESIDUAL_SEVERITY = ["low", "medium", "high", "critical"];

/** 规范化 JSON：键按码点排序，语义相同哈希必同 */
export function canonicalize(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
}

/** 语义哈希 → `ev_<hex>` */
export function evidenceId(semantic) {
  return "ev_" + createHash("sha256").update(canonicalize(semantic), "utf8").digest("hex");
}

/** 大对象/长字符串截断后再进哈希，避免同一结果因为多一个空格就换 ev_id */
const MAX_STR = 4096;
export function sanitizeForHash(value, depth = 0) {
  if (depth > 8) return "[depth]";
  if (typeof value === "string") return value.length > MAX_STR ? value.slice(0, MAX_STR) : value;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeForHash(item, depth + 1));
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = sanitizeForHash(value[key], depth + 1);
  return out;
}

class JsonlStore {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  readAll() {
    let text = "";
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch {
      return [];
    }
    const out = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed));
      } catch {
        // 半行（进程被杀）直接跳过
      }
    }
    return out;
  }

  append(record) {
    fs.appendFileSync(this.file, JSON.stringify(record) + "\n", "utf8");
  }

  rewrite(records) {
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : ""), "utf8");
    fs.renameSync(tmp, this.file);
  }
}

export class EvidenceLedger {
  /**
   * @param {{ file: string, engagement?: string }} options
   */
  constructor({ file, engagement } = {}) {
    if (!file) throw new Error("EvidenceLedger requires a file path");
    this.store = new JsonlStore(file);
    this.engagement = engagement || "default";
  }

  _records(kind) {
    return this.store.readAll().filter((row) => row.kind === kind);
  }

  /**
   * 记一条 evidence。
   * @returns {{ok:true, ev_id:string, duplicate:boolean} | {ok:false, error:string}}
   */
  record(input = {}) {
    const {
      operation,
      parameters = {},
      result,
      confidence = "observed",
      authority = "tool-output",
      limitations = [],
      supporting_ev_ids = [],
      recorded_by,
      source_agent,
      engagement_id,
      raw_ref,
    } = input;

    if (!operation || typeof operation !== "string") return { ok: false, error: "operation is required" };
    if (result === undefined || result === null) return { ok: false, error: "result is required" };
    if (!EVIDENCE_CONFIDENCE.includes(confidence))
      return { ok: false, error: `confidence must be one of ${EVIDENCE_CONFIDENCE.join(",")}` };
    if (!EVIDENCE_AUTHORITY.includes(authority))
      return { ok: false, error: `authority must be one of ${EVIDENCE_AUTHORITY.join(",")}` };

    const semantic = {
      operation,
      parameters: sanitizeForHash(parameters),
      result: sanitizeForHash(result),
      confidence,
      authority,
      limitations: [...limitations].sort(),
      supporting_ev_ids: [...supporting_ev_ids].sort(),
    };
    const ev_id = evidenceId(semantic);

    const existing = this.store.readAll().find((row) => row.kind === "evidence" && row.ev_id === ev_id);
    if (existing) return { ok: true, ev_id, duplicate: true };

    try {
      this.store.append({
        kind: "evidence",
        ev_id,
        confidence,
        authority,
        operation,
        parameters: JSON.stringify(parameters),
        result: JSON.stringify(result),
        raw_ref: raw_ref ?? null,
        limitations: JSON.stringify(limitations),
        supporting_ev_ids: JSON.stringify(supporting_ev_ids),
        recorded_by: recorded_by ?? null,
        recorded_at: new Date().toISOString(),
        source_agent: source_agent ?? null,
        engagement_id: engagement_id ?? this.engagement,
      });
      return { ok: true, ev_id, duplicate: false };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  get(ev_id) {
    const row = this.store.readAll().find((item) => item.kind === "evidence" && item.ev_id === ev_id);
    return row ? parseEvidenceRow(row) : undefined;
  }

  /**
   * 核对：子智能体说"我做了 X 得到 Y"，指挥侧算一遍哈希比对。
   * @returns {{matched:boolean, expected_ev_id?:string, actual_ev_id?:string, recorded?:object}}
   */
  verify(input = {}) {
    const {
      operation,
      parameters = {},
      result,
      confidence = "observed",
      authority = "tool-output",
      limitations = [],
      supporting_ev_ids = [],
    } = input;
    const expected = evidenceId({
      operation,
      parameters: sanitizeForHash(parameters),
      result: sanitizeForHash(result),
      confidence,
      authority,
      limitations: [...limitations].sort(),
      supporting_ev_ids: [...supporting_ev_ids].sort(),
    });
    const found = this.get(expected);
    if (found) return { matched: true, expected_ev_id: expected, recorded: found };
    const same = this.store
      .readAll()
      .filter(
        (row) =>
          row.kind === "evidence" && row.operation === operation && (row.engagement_id ?? "default") === this.engagement,
      )
      .map((row) => row.ev_id);
    return { matched: false, expected_ev_id: expected, actual_ev_id: same.at(-1) };
  }

  /** 列出 evidence，可按置信度/操作过滤 */
  list({ confidence, operation, limit = 100 } = {}) {
    let rows = this._records("evidence").map(parseEvidenceRow);
    if (confidence) rows = rows.filter((row) => row.confidence === confidence);
    if (operation) rows = rows.filter((row) => row.operation === operation);
    return rows.slice(-limit);
  }

  /** 置信度分布：报告里一眼看出"有多少条其实只是 claimed" */
  stats() {
    const rows = this._records("evidence");
    const byConfidence = {};
    for (const row of rows) byConfidence[row.confidence] = (byConfidence[row.confidence] ?? 0) + 1;
    const unverified = rows.filter((row) => CONFIDENCE_REQUIRES_VERIFICATION.has(row.confidence)).length;
    const unknowns = this._records("unknown");
    return {
      total: rows.length,
      byConfidence,
      unverified,
      verifiedRatio: rows.length ? Number(((rows.length - unverified) / rows.length).toFixed(3)) : 1,
      residualUnknown: {
        open: unknowns.filter((row) => row.status === "open").length,
        total: unknowns.length,
      },
    };
  }

  /* ── Residual Unknown：还没打完、证据不足的问题 ─────────────────── */

  openUnknown(input = {}) {
    const { question, severity = "medium", domain = "general", recommended_probe, required_authority, supporting_ev_ids = [] } = input;
    if (!question || typeof question !== "string") return { ok: false, error: "question is required" };
    if (!RESIDUAL_SEVERITY.includes(severity))
      return { ok: false, error: `severity must be one of ${RESIDUAL_SEVERITY.join(",")}` };
    const unk_id = "unk_" + createHash("sha256").update(`${this.engagement}:${question}`, "utf8").digest("hex");
    const existing = this.store.readAll().find((row) => row.kind === "unknown" && row.unk_id === unk_id);
    if (existing) return { ok: true, unk_id, duplicate: true };
    this.store.append({
      kind: "unknown",
      unk_id,
      revision: 1,
      question,
      status: "open",
      severity,
      domain,
      supporting_ev_ids: JSON.stringify(supporting_ev_ids),
      contradicting_ev_ids: "[]",
      required_authority: required_authority ?? null,
      recommended_probe: recommended_probe ?? null,
      resolution: null,
      recorded_at: new Date().toISOString(),
      resolved_at: null,
      engagement_id: this.engagement,
    });
    return { ok: true, unk_id, duplicate: false };
  }

  resolveUnknown({ unk_id, status = "resolved", resolution } = {}) {
    if (!RESIDUAL_STATUS.includes(status)) return { ok: false, error: `status must be one of ${RESIDUAL_STATUS.join(",")}` };
    const rows = this.store.readAll();
    const target = rows.find((row) => row.kind === "unknown" && row.unk_id === unk_id);
    if (!target) return { ok: false, error: `unknown ${unk_id} not found` };
    target.status = status;
    target.revision = (target.revision ?? 1) + 1;
    if (resolution) target.resolution = resolution;
    if (status === "resolved" || status === "contradicted") target.resolved_at = new Date().toISOString();
    this.store.rewrite(rows);
    return { ok: true, unk_id, status };
  }

  listUnknown({ status } = {}) {
    const rows = this._records("unknown").map(parseUnknownRow);
    return status ? rows.filter((row) => row.status === status) : rows;
  }
}

export function parseEvidenceRow(row) {
  return {
    ...row,
    parameters: safeJson(row.parameters, {}),
    result: safeJson(row.result, {}),
    limitations: safeJson(row.limitations, []),
    supporting_ev_ids: safeJson(row.supporting_ev_ids, []),
  };
}

export function parseUnknownRow(row) {
  return {
    ...row,
    supporting_ev_ids: safeJson(row.supporting_ev_ids, []),
    contradicting_ev_ids: safeJson(row.contradicting_ev_ids, []),
  };
}

function safeJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/* ── 账号/隧道口径：抄 dsh-purge 的判定，别把自助注册当战果 ─────────── */

export const TUNNEL_ENTRY_KINDS = {
  "target-outbound": "Target-initiated outbound (reverse shell / frp client on the target)",
  "target-http": "Target WebShell/HTTP channel (suo5 / Neo-ReGeorg)",
  "target-agent": "Forwarding through a compromised process/session on the target (SSH -R)",
  "self-only": "Own VPS only (does NOT count as a boundary breach)",
};

/** 这条隧道算不算跨过了靶标边界；未声明返回 null，界面按"待确认"处理 */
export function tunnelIsLegit(entryKind) {
  const kind = String(entryKind || "").trim();
  if (kind === "") return null;
  return kind !== "self-only";
}

/** 自己注册/自己创建的账号不算拿到权限 */
export const ACCOUNT_POINT_CODES = [
  "web-account-user",
  "web-account-admin",
  "server-shell",
  "db-access",
  "internal-pivot",
  "core-system",
];
