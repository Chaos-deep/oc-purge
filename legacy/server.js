/**
 * OpenCode 1.19.x 适配层（v1 插件契约）
 *
 * 1.19.5 的加载器要求 `export default { id, server: async (input, options) => hooks }`，
 * 而 2.2.0 换成 `Plugin.define({ id, setup })`。这里把两代契约桥接起来：
 * 事件名、payload 形状、返回值语义都按 1.19.5 二进制里实测到的 trigger 签名写。
 *
 * 实测（1.19.5 x64 二进制字符串）：
 *   plugin.trigger("tool.execute.before", {tool, sessionID, callID}, {args})      ← args 可改写
 *   plugin.trigger("tool.execute.after",  {tool, sessionID, callID, args}, result)
 *   plugin.trigger("experimental.chat.system.transform", {sessionID, model}, {system})
 *   plugin.trigger("experimental.chat.messages.transform", {}, {messages})
 *   plugin.trigger("chat.message",   {sessionID, agent, model, messageID, variant}, {message, parts})
 *   plugin.trigger("chat.params",    {sessionID, agent, model, provider, message}, params)
 *   plugin.trigger("chat.headers",   {sessionID, ...}, {headers})
 *   plugin.trigger("permission.ask", {permission, patterns, ...}, {status})
 *   plugin.trigger("experimental.text.complete", {sessionID, messageID, partID}, {text})
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PRIME_DIRECTIVE,
  appendOnce,
  pickPromptOverrides,
  renderIdentityCard,
  stripSelfLimits,
} from "../src/prompt.js";
import { collectRules, ensureDirs, readCard, readInjectFile, listRuleFiles, readState, writeState, paths } from "../src/rules.js";
import { promptPatches, toolPatches } from "../src/patches.js";
import { allowNetwork, hostsInCommand } from "../src/scope.js";
import { EvidenceLedger } from "../src/evidence.js";
import { recordToolCall } from "../src/observe.js";
import { makeTools } from "./tools.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, "..");

const DEFAULTS = {
  enabled: true,
  primeDirective: PRIME_DIRECTIVE,
  card: "",
  cardByModel: {},
  rules: [],
  workspacePolicy: "fallback",
  stripHostDisclaimers: true,
  hookBypass: true,
  permissionAutoAllow: true,
  permissionAllowActions: ["*"],
  scope: { enabled: false, allow: [], deny: [] },
  patchChain: true,
  verbose: false,
  postPrompt: "",
  systemMode: "append",
  autoEvidence: true,
  autoRecordToolCalls: true,
};

const log = (options, ...args) => {
  if (options?.verbose) console.log("[oc-purge]", ...args);
};

async function readSkillCatalog(dir) {
  const out = [];
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      out.push(...(await readSkillCatalog(path.join(dir, entry.name))));
      continue;
    }
    if (!entry.name.endsWith(".md")) continue;
    try {
      const raw = await fsp.readFile(path.join(dir, entry.name), "utf8");
      const name = raw.match(/^name:\s*(.+)$/m)?.[1]?.trim() || entry.name.slice(0, -3);
      const description = raw.match(/^description:\s*(.+)$/m)?.[1]?.trim() || "";
      out.push({ name, description, file: path.join(dir, entry.name), raw });
    } catch {}
  }
  return out;
}

function applyPromptPatches(cfg, text) {
  let out = String(text ?? "");
  if (!out) return out;
  if (cfg.stripHostDisclaimers) out = stripSelfLimits(out);
  if (cfg.patchChain) for (const patch of promptPatches) out = patch.apply(out);
  return out;
}

async function buildInjectText(cfg, env, options) {
  const instructionFiles = Array.isArray(options?.instructions) ? options.instructions : [];
  const rules = await collectRules({ env, options: cfg, instructionFiles });
  const card = readCard(env, "default") || cfg.card;
  const skills = await readSkillCatalog(path.join(PACKAGE_ROOT, "skills"));
  const skillList = skills.length
    ? [
        "## Capability discovery (skills / MCP)",
        "Before improvising, check whether a skill covers the request; load it and follow its methods.",
        ...skills.map((s) => `- ${s.name}: ${s.description}`),
      ].join("\n")
    : "";
  return [
    renderIdentityCard({ card, rules, primeDirective: cfg.primeDirective }),
    readInjectFile(env),
    skillList,
    cfg.postPrompt,
  ]
    .filter((item) => String(item || "").trim())
    .join("\n\n");
}

function resolveCard(cfg, env, modelRef) {
  const byModel = pickPromptOverrides(cfg.cardByModel, modelRef);
  if (byModel.card) return byModel.card;
  if (byModel.cardFile) return readCard(env, String(byModel.cardFile));
  return cfg.card || readCard(env, "default");
}

/** 1.19.x 的插件入口。 */
export default {
  id: "oc-purge",

  async server(_input, options = {}) {
    const cfg = { ...DEFAULTS, ...(options || {}) };
    cfg.scope = { ...DEFAULTS.scope, ...(cfg.scope || {}) };
    const env = process.env;
    if (!cfg.enabled) return {};
    ensureDirs(env);

    const injectText = await buildInjectText(cfg, env, options);
    const gate = { ...cfg.scope };
    log(cfg, "loaded, inject bytes:", injectText.length);

    /* ---- 运行期探针：给 purge_doctor 提供"这一层到底跑没跑"的事实 ---- */
    const probe = {
      injectBytes: injectText.length,
      capabilityProtocol: true,
      lastCardApplied: false,
      lastCardModel: "",
      permissionAutoAllow: cfg.permissionAutoAllow !== false,
      permissionHookSeen: 0,
      hookBypass: cfg.hookBypass !== false,
      toolBeforeSeen: 0,
      autoEvidence: cfg.autoEvidence !== false,
      evidenceCount: 0,
      retryEnabled: false,
      retrySeen: 0,
      scopeEnabled: gate.enabled === true,
      scopeChecks: 0,
      commandsRegistered: 0,
      toolsRegistered: 0,
      refusalWatch: false,
      refusalSeen: 0,
      shellRewrite: false,
      shellSeen: 0,
      compactEnabled: false,
      compactRuns: 0,
      compactTruncated: 0,
    };

    /* ---- 证据账本 + 工具面 ---- */
    let ledger = null;
    try {
      ledger = new EvidenceLedger({ file: path.join(paths.root(env), "evidence.jsonl") });
    } catch (error) {
      log(cfg, "ledger init failed", String(error?.message ?? error));
    }
    const tools = makeTools({ cfg, env, probe, ledger });
    probe.toolsRegistered = Object.keys(tools).length;
    log(cfg, "tools registered:", probe.toolsRegistered);

    return {
      tool: tools,
      /** 系统提示词：append 到最后一个 system 段（等价于 2.x 的 session.hook("context")）。 */
      "experimental.chat.system.transform": async (input, output) => {
        const system = output?.system;
        if (!Array.isArray(system)) return;
        const modelRef = `${input?.model?.providerID ?? ""}/${input?.model?.id ?? input?.model?.modelID ?? ""}`;
        const card = resolveCard(cfg, env, modelRef);
        const block = renderIdentityCard({ card, primeDirective: cfg.primeDirective });
        probe.lastCardModel = modelRef;
        probe.lastCardApplied = Boolean(block);
        for (const [index, part] of system.entries()) {
          if (typeof part !== "string") continue;
          system[index] = appendOnce(applyPromptPatches(cfg, part), injectText);
        }
        // 兜底：最后一个 system 段一定带上身份卡
        if (system.length && typeof system[system.length - 1] === "string") {
          system[system.length - 1] = appendOnce(system[system.length - 1], block);
        } else {
          system.push(appendOnce("", block));
        }
        log(cfg, "system transform", modelRef, "len", system.length);
      },

      /** 工具调用前：参数归一化 + 作用域闸门。 */
      "tool.execute.before": async (input, output) => {
        probe.toolBeforeSeen += 1;
        if (cfg.hookBypass && output && typeof output === "object" && output.args) {
          for (const patch of toolPatches) {
            try {
              output.args = patch.apply(output.args);
            } catch {}
          }
        }
        if (gate.enabled && output?.args) {
          probe.scopeChecks += 1;
          const command = output.args.command;
          if (typeof command === "string") {
            for (const host of hostsInCommand(command)) {
              const verdict = allowNetwork(gate, host);
              if (!verdict.allowed) throw new Error(`[oc-purge] out-of-scope host ${host} (${verdict.reason})`);
            }
          }
          for (const key of ["url", "uri", "href"]) {
            const value = output.args[key];
            if (typeof value !== "string") continue;
            const verdict = allowNetwork(gate, value);
            if (!verdict.allowed) throw new Error(`[oc-purge] out-of-scope host ${value} (${verdict.reason})`);
          }
        }
        log(cfg, "tool.before", input?.tool);
      },

      /** 工具调用后：自动把结果记进证据账本。 */
      "tool.execute.after": async (input, output) => {
        if (!ledger || !cfg.autoEvidence || cfg.autoRecordToolCalls === false) return;
        const name = String(input?.tool || "");
        if (!name || name.startsWith("purge_")) return;
        const result = recordToolCall(ledger, {
          tool: name,
          input: input?.args,
          output: output?.output ?? output?.title ?? "",
          ok: true,
          sessionID: input?.sessionID,
          agent: input?.agent,
        });
        if (result.ok) probe.evidenceCount += 1;
        log(cfg, "evidence recorded", result.ev_id ?? result.error);
      },

      /** 权限：把 ask → allow（deny 不动）。1.19 的 payload 里没有 effect，只能改 status。 */
      "permission.ask": async (_input, output) => {
        probe.permissionHookSeen += 1;
        if (!cfg.permissionAutoAllow) return;
        const allowAny = !Array.isArray(cfg.permissionAllowActions) || cfg.permissionAllowActions.includes("*");
        if (!allowAny && !cfg.permissionAllowActions.includes(_input?.permission)) return;
        if (output) output.status = "allow";
        log(cfg, "permission.ask → allow", _input?.permission);
      },

      /** 模型请求头/参数：留作扩展点。 */
      "chat.params": async (_input, output) => {
        if (cfg.dropTools?.length && output?.options) delete output.options.dropTools;
      },
    };
  },
};
