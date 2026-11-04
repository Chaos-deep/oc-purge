/**
 * oc-purge / retry — 失败重试与"继续"
 *
 * 移植自 dsh-purge `lib/continue-retry.js`。原项目踩过的坑：
 *   · 永久性错误（认证失败、额度用尽、模型不存在）不该重试，重试只是浪费配额；
 *   · 限流要等更久，不能和瞬时错误同一档退避；
 *   · "继续"自动续跑容易和用户输入抢跑（idle 后几百毫秒就发），默认关掉。
 *
 * OpenCode 侧接口：`session.hook("retry")` 事件里有 `{ error, attempt, decision }`，
 * 返回 `{ retry: false }` 或 `{ retry: true, delay }`。这里只负责**判定**，不负责调度。
 */

export const DEFAULT_RETRY = Object.freeze({
  autoRetry: true,
  retryMax: 3,
  autoContinue: false,
  continueMax: 3,
  continueText: "继续",
  rateLimitDelayMs: 20_000,
  transportDelayMs: 3_000,
  baseDelayMs: 1_500,
});

/** 重试也没用的错误：别再烧配额 */
const PERMANENT_CODES = new Set([
  "AUTH",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "INVALID",
  "INVALID_REQUEST",
  "QUOTA",
  "ACCOUNT_QUOTA",
  "BILLING",
  "MODEL_NOT_FOUND",
  "CONTEXT_OVERFLOW",
  "CONTEXT_LENGTH",
  "CONTEXT_WINDOW_EXCEEDED",
  "NO_ADAPTER",
  "MISSING_CREDENTIAL",
  "INVALID_CREDENTIAL",
]);

/** 官方已经重试过的：再来一次"继续"也清不掉 */
const NO_CONTINUE_CODES = new Set([...PERMANENT_CODES, "RATE_LIMIT", "TRANSPORT"]);

const ABNORMAL_KINDS = new Set(["error", "aborted", "interrupted", "max-tokens"]);

/** 计数：0..20 的整数（重试次数、继续次数） */
function clampCount(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(20, Math.trunc(n)));
}

/** 毫秒延迟：0..600000，不能用 clampCount（它把 20000 压成 20 了） */
function clampMs(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, 600_000);
}

export function normalizeRetryConfig(raw = {}) {
  const src = raw && typeof raw === "object" ? raw : {};
  const retryMax = clampCount(src.retryMax, DEFAULT_RETRY.retryMax);
  const continueMax = clampCount(src.continueMax, DEFAULT_RETRY.continueMax);
  const text = typeof src.continueText === "string" ? src.continueText.trim() : "";
  return {
    autoRetry: src.autoRetry !== false && retryMax > 0,
    retryMax,
    autoContinue: src.autoContinue === true && continueMax > 0,
    continueMax,
    continueText: text || DEFAULT_RETRY.continueText,
    rateLimitDelayMs: clampMs(src.rateLimitDelayMs, DEFAULT_RETRY.rateLimitDelayMs),
    transportDelayMs: clampMs(src.transportDelayMs, DEFAULT_RETRY.transportDelayMs),
    baseDelayMs: clampMs(src.baseDelayMs, DEFAULT_RETRY.baseDelayMs),
  };
}

/** 从 OpenCode 的 SessionError 形状里尽量挖出一个分类用的 code */
export function errorCode(error) {
  if (!error || typeof error !== "object") return "";
  const candidates = [
    error.code,
    error.name,
    error.type,
    error._tag,
    error.error?.code,
    error.error?.name,
    error.cause?.code,
  ];
  for (const value of candidates) {
    if (typeof value === "string" && value.trim()) return value.trim().toUpperCase();
  }
  if (typeof error.message === "string") {
    const text = error.message.toLowerCase();
    if (text.includes("rate limit") || text.includes("429")) return "RATE_LIMIT";
    if (text.includes("unauthorized") || text.includes("401")) return "UNAUTHORIZED";
    if (text.includes("forbidden") || text.includes("403")) return "FORBIDDEN";
    if (text.includes("quota") || text.includes("insufficient")) return "QUOTA";
    if (text.includes("overloaded") || text.includes("503") || text.includes("502")) return "OVERLOADED";
    if (text.includes("econnreset") || text.includes("etimedout") || text.includes("socket hang up")) return "TRANSPORT";
  }
  return "";
}

export function isPermanent(error) {
  return PERMANENT_CODES.has(errorCode(error));
}

export function canContinue(error) {
  const code = errorCode(error);
  if (NO_CONTINUE_CODES.has(code)) return false;
  return true;
}

/**
 * 决定这一次要不要重试、等多久。
 * @param {{ error: any, attempt: number, config?: object }} input
 * @returns {{ retry: false, reason: string } | { retry: true, delay: number, reason: string }}
 */
export function decideRetry({ error, attempt = 0, config } = {}) {
  const cfg = normalizeRetryConfig(config ?? DEFAULT_RETRY);
  if (!cfg.autoRetry) return { retry: false, reason: "autoRetry disabled" };
  if (attempt >= cfg.retryMax) return { retry: false, reason: `attempt ${attempt} >= retryMax ${cfg.retryMax}` };

  const code = errorCode(error);
  if (PERMANENT_CODES.has(code)) return { retry: false, reason: `permanent error ${code}` };
  if (code === "RATE_LIMIT") return { retry: true, delay: cfg.rateLimitDelayMs, reason: "rate limited" };
  if (code === "TRANSPORT") return { retry: true, delay: cfg.transportDelayMs, reason: "transport error" };

  // 指数退避，封顶 30s
  const delay = Math.min(cfg.baseDelayMs * 2 ** Math.max(0, attempt), 30_000);
  return { retry: true, delay, reason: code ? `transient ${code}` : "transient" };
}

/** 这一轮之后要不要自动发一句"继续" */
export function decideContinue({ finishKind, error, continuedCount = 0, config } = {}) {
  const cfg = normalizeRetryConfig(config ?? DEFAULT_RETRY);
  if (!cfg.autoContinue) return { continue: false, reason: "autoContinue disabled" };
  if (continuedCount >= cfg.continueMax) return { continue: false, reason: "continue limit reached" };
  if (error) {
    if (isPermanent(error)) return { continue: false, reason: "permanent error" };
    if (!canContinue(error)) return { continue: false, reason: `cannot continue on ${errorCode(error)}` };
  }
  const kind = String(finishKind || "").trim().toLowerCase();
  if (!kind) return { continue: false, reason: "no finish signal" };
  if (!ABNORMAL_KINDS.has(kind)) return { continue: false, reason: `normal finish ${kind}` };
  return { continue: true, text: cfg.continueText };
}
