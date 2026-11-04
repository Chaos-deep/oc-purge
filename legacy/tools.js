/**
 * oc-purge / legacy tools — 1.18.x 适配层
 *
 * 1.19.x 的 legacy 契约只挂事件 hook，不注册工具；而 @opencode-ai/plugin 1.18
 * 的 Hooks 已经支持 `tool`。这里用同一套 zod 形状把 2.x 的 purge_* 工具补齐，
 * 让 1.18/1.19 也能真正调用规则、注入、证据、自检、回放。
 *
 * 工具定义用 `@opencode-ai/plugin/tool`（identity + `tool.schema = zod`），
 * 具体逻辑直接复用 ../src 下的纯函数，避免复制。
 */

import path from "node:path";
import fsp from "node:fs/promises";

import { tool } from "@opencode-ai/plugin/tool";

import {
  ensureDirs,
  readInjectFile,
  listRuleFiles,
  readState,
  writeState,
  paths,
} from "../src/rules.js";
import { allowNetwork, scopeReport } from "../src/scope.js";
import { EvidenceLedger } from "../src/evidence.js";
import { selfcheck, renderSelfcheck } from "../src/selfcheck.js";
import { replayFromEvidence } from "../src/replay.js";

const z = tool.schema;

const RULE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function def(description, args, run) {
  return tool({
    description,
    args,
    async execute(input) {
      try {
        return String(await run(input || {}));
      } catch (error) {
        return `error: ${String(error?.message ?? error)}`;
      }
    },
  });
}

export function makeTools({ cfg, env, probe, ledger }) {
  return {
    purge_status: def(
      "Report oc-purge state: rules, selected card, scope, inject size.",
      {},
      async () => {
        const state = readState(env);
        const rules = listRuleFiles(env).map(
          (r) => `${state.rules.includes(r.id) || state.rules.length === 0 ? "[x]" : "[ ]"} ${r.id}`,
        );
        return [
          `enabled: ${cfg.enabled}`,
          `rule files: ${rules.length ? rules.join(", ") : "(none)"}`,
          `workspacePolicy: ${cfg.workspacePolicy}`,
          `scope: ${JSON.stringify(scopeReport(cfg.scope))}`,
          `inject: ${readInjectFile(env).length} bytes`,
        ].join("\n");
      },
    ),

    purge_rules: def(
      "List, add, toggle or remove rule files under $OC_PURGE_HOME/rules.",
      {
        action: z.enum(["list", "add", "toggle", "remove"]),
        id: z.string().optional(),
        body: z.string().optional(),
      },
      async ({ action, id, body }) => {
        const state = readState(env);
        ensureDirs(env);
        if (action === "list") {
          return listRuleFiles(env).map((r) => `${r.id}\t${r.title}\t${r.bytes}B`).join("\n");
        }
        if (!id) return "error: id required";
        if (!RULE_ID_RE.test(id)) return `error: invalid id ${id}`;
        const file = path.join(paths.rules(env), `${id}.md`);
        if (action === "add") {
          await fsp.writeFile(file, String(body || `# ${id}\n`), "utf8");
          if (!state.rules.includes(id)) state.rules.push(id);
          writeState(env, state);
          return `added ${id}`;
        }
        if (action === "toggle") {
          state.rules = state.rules.includes(id)
            ? state.rules.filter((x) => x !== id)
            : [...state.rules, id];
          writeState(env, state);
          return `rules: ${state.rules.join(", ") || "(none)"}`;
        }
        if (action === "remove") {
          await fsp.rm(file, { force: true });
          state.rules = state.rules.filter((x) => x !== id);
          writeState(env, state);
          return `removed ${id}`;
        }
        return "noop";
      },
    ),

    purge_inject: def(
      "Read or replace the free-form inject text (prompt-inject.md equivalent).",
      { text: z.string().optional() },
      async ({ text }) => {
        if (typeof text !== "string") return readInjectFile(env);
        ensureDirs(env);
        await fsp.writeFile(paths.legacyInject(env), text, "utf8");
        return `wrote ${text.length} bytes to ${paths.legacyInject(env)}`;
      },
    ),

    purge_scope: def(
      "Check whether a host is inside the allowed network scope.",
      { host: z.string() },
      async ({ host }) => {
        const verdict = allowNetwork(cfg.scope, host);
        return `${verdict.allowed ? "ALLOW" : "DENY"}\t${verdict.reason}\t${host}`;
      },
    ),

    purge_evidence: def(
      "Record / verify / list evidence in the local ledger. Evidence is content-addressed (ev_<sha256>): same content -> same id.",
      {
        action: z.enum(["record", "verify", "list", "stats", "open_unknown", "resolve_unknown", "unknowns"]),
        operation: z.string().optional(),
        parameters: z.unknown().optional(),
        result: z.unknown().optional(),
        confidence: z.enum(["claimed", "observed", "derived", "inferred"]).optional(),
        authority: z.string().optional(),
        limitations: z.array(z.string()).optional(),
        question: z.string().optional(),
        severity: z.enum(["low", "medium", "high", "critical"]).optional(),
        unk_id: z.string().optional(),
        status: z.string().optional(),
        resolution: z.string().optional(),
        limit: z.number().optional(),
      },
      async (args) => {
        if (!ledger) return "error: ledger unavailable";
        const { action } = args;
        if (action === "record") {
          const out = ledger.record({
            operation: args.operation,
            parameters: args.parameters ?? {},
            result: args.result,
            confidence: args.confidence ?? "observed",
            authority: args.authority ?? "operator-input",
            limitations: args.limitations ?? [],
          });
          return out.ok ? `${out.duplicate ? "duplicate" : "recorded"} ${out.ev_id}` : `error: ${out.error}`;
        }
        if (action === "verify") {
          const out = ledger.verify({
            operation: args.operation,
            parameters: args.parameters ?? {},
            result: args.result,
            confidence: args.confidence ?? "observed",
            authority: args.authority ?? "operator-input",
            limitations: args.limitations ?? [],
          });
          if (out.matched) return `MATCH ${out.expected_ev_id}`;
          return `MISMATCH expected=${out.expected_ev_id} actual=${out.actual_ev_id ?? "(none)"}`;
        }
        if (action === "list") {
          const rows = ledger.list({ limit: args.limit ?? 50 });
          if (rows.length === 0) return "(no evidence)";
          return rows.map((row) => `${row.ev_id}\t${row.confidence}\t${row.operation}\t${String(row.result).slice(0, 80)}`).join("\n");
        }
        if (action === "stats") return JSON.stringify(ledger.stats(), null, 2);
        if (action === "open_unknown") {
          const out = ledger.openUnknown({ question: args.question, severity: args.severity ?? "medium" });
          return out.ok ? `${out.duplicate ? "duplicate" : "opened"} ${out.unk_id}` : `error: ${out.error}`;
        }
        if (action === "resolve_unknown") {
          const out = ledger.resolveUnknown({ unk_id: args.unk_id, status: args.status ?? "resolved", resolution: args.resolution });
          return out.ok ? `${out.unk_id} -> ${out.status}` : `error: ${out.error}`;
        }
        if (action === "unknowns") {
          const rows = ledger.listUnknown({ status: args.status });
          if (rows.length === 0) return "(no residual unknowns)";
          return rows.map((row) => `${row.unk_id}\t${row.status}\t${row.severity}\t${row.question}`).join("\n");
        }
        return "noop";
      },
    ),

    purge_doctor: def(
      "Layer-by-layer self-check: prove each oc-purge layer actually fired on this machine.",
      { format: z.enum(["text", "json"]).optional() },
      async ({ format }) => {
        if (!probe) return "error: probe state unavailable";
        const report = selfcheck(probe);
        if (format === "json") return JSON.stringify(report, null, 2);
        return renderSelfcheck(report);
      },
    ),

    purge_replay: def(
      "Turn a recorded evidence row into a reproducible command / HTTP request. Anything synthesised is flagged.",
      { ev_id: z.string().optional(), limit: z.number().optional() },
      async ({ ev_id, limit }) => {
        if (!ledger) return "error: ledger unavailable";
        const rows = ev_id ? [ledger.get(ev_id)].filter(Boolean) : ledger.list({ limit: limit ?? 10 });
        if (rows.length === 0) return "(no evidence)";
        return rows
          .map((row) => {
            const replay = replayFromEvidence(row);
            const lines = [`## ${row.ev_id}`, `kind: ${replay.kind}`, `synthesized: ${replay.synthesized}`];
            if (replay.command) lines.push("", "```bash", replay.command, "```");
            if (replay.http) lines.push("", "```http", replay.http, "```");
            if (replay.note) lines.push("", `note: ${replay.note}`);
            return lines.join("\n");
          })
          .join("\n\n");
      },
    ),
  };
}

export { EvidenceLedger };
