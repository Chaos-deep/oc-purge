/**
 * oc-purge / compact — 在派发前给历史消息"减压"
 *
 * 对应 `experimental.chat.messages.transform`（OpenCode 2.x）。事件拿到 `{ messages }`，
 * 可以就地改写。用途不是"压缩对话"，而是**去掉会污染判断的噪音**：
 *
 *   · 超长的工具输出（> 阈值）→ 截断并标注原文位置
 *   · 重复的同一命令输出 → 只留最后一次
 *   · 注入类文本（system 里的旧身份卡、重复 nudge）→ 去重
 *
 * 刻意保守：
 *   · **不改 assistant 的推理与结论**，只动 tool 结果与重复块
 *   · **不删消息**，只截断内容 —— 删消息会让 tool_call/tool_result 配对断裂，宿主直接报错
 *   · 每一步都返回 `{ messages, stats }`，stats 说明改了什么，便于在 `/purge-doctor` 里核实
 */

export const DEFAULT_COMPACT = Object.freeze({
  enabled: false, // 默认关：碰到历史消息的东西必须显式开启
  maxToolOutputChars: 8_000,
  keepTailChars: 1_200,
  dedupeToolOutputs: true,
  dedupeSystemBlocks: true,
  maxSystemBlocks: 6,
});

const TRUNCATE_MARK = "\n…[truncated by oc-purge]…\n";

function textOf(part) {
  if (!part || typeof part !== "object") return "";
  if (typeof part.text === "string") return part.text;
  if (typeof part.content === "string") return part.content;
  if (Array.isArray(part.content)) {
    return part.content
      .map((block) => (block && typeof block.text === "string" ? block.text : ""))
      .filter(Boolean)
      .join("");
  }
  return "";
}

/** 保头保尾，中间用标记替换 */
export function truncateMiddle(text, { maxChars = DEFAULT_COMPACT.maxToolOutputChars, keepTail = DEFAULT_COMPACT.keepTailChars } = {}) {
  const value = String(text ?? "");
  if (value.length <= maxChars) return value;
  const headLen = Math.max(0, maxChars - keepTail);
  return `${value.slice(0, headLen)}${TRUNCATE_MARK}${value.slice(-keepTail)}`;
}

function fingerprint(text) {
  return String(text ?? "").slice(0, 200);
}

/**
 * 主入口。
 * @param {Array} messages 宿主的 messages 数组（就地替换内容，不增删条目）
 * @param {object} config
 * @returns {{messages:Array, stats:{truncated:number,deduped:number,kept:System.number,skipped?:string}}}
 */
export function compactMessages(messages, config = {}) {
  const cfg = { ...DEFAULT_COMPACT, ...(config || {}) };
  const stats = { truncated: 0, deduped: 0, kept: 0, skipped: undefined };
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: messages ?? [], stats: { ...stats, skipped: "empty" } };
  }
  if (!cfg.enabled) return { messages, stats: { ...stats, skipped: "disabled" } };

  const out = messages.map((message) => ({ ...message }));

  // 1) 截断超长的 tool 结果
  for (const message of out) {
    if (!Array.isArray(message.content)) continue;
    const content = message.content.map((part) => {
      if (!part || typeof part !== "object") return part;
      if (part.type !== "tool-result" && part.type !== "tool") return part;
      const text = textOf(part);
      const limit = part.type === "tool-result" ? cfg.maxToolOutputChars : Number.POSITIVE_INFINITY;
      if (!text || text.length <= limit) return part;
      stats.truncated += 1;
      return { ...part, text: truncateMiddle(text, { maxChars: cfg.maxToolOutputChars, keepTail: cfg.keepTailChars }) };
    });
    message.content = content;
  }

  // 2) 去重：同一段工具输出出现多次，只保留最后一次的完整内容
  if (cfg.dedupeToolOutputs) {
    const lastIndex = new Map();
    out.forEach((message, index) => {
      if (!Array.isArray(message.content)) return;
      for (const part of message.content) {
        if (!part || part.type !== "tool-result") continue;
        const key = fingerprint(textOf(part));
        if (key.length < 40) continue;
        lastIndex.set(key, index);
      }
    });
    out.forEach((message, index) => {
      if (!Array.isArray(message.content)) return;
      message.content = message.content.map((part) => {
        if (!part || part.type !== "tool-result") return part;
        const key = fingerprint(textOf(part));
        if (key.length < 40 || lastIndex.get(key) === index) return part;
        stats.deduped += 1;
        return { ...part, text: `[duplicate tool output elided; identical to a later result]` };
      });
    });
  }

  // 3) system 段去重（同一段身份卡被追加多次的情况）
  if (cfg.dedupeSystemBlocks) {
    const seen = new Set();
    out.forEach((message, index) => {
      if (message.role !== "system") return;
      const text = textOf({ content: message.content });
      const blocks = text.split("\n\n---\n\n");
      const kept = [];
      for (const block of blocks) {
        const key = fingerprint(block.trim());
        if (key.length > 80 && seen.has(key)) {
          stats.deduped += 1;
          continue;
        }
        if (key.length > 80) seen.add(key);
        kept.push(block);
      }
      if (kept.length !== blocks.length) {
        out[index] = { ...message, content: kept.join("\n\n---\n\n") };
      }
      stats.kept = index + 1;
    });
  }

  return { messages: out, stats };
}
