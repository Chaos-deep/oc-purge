/**
 * oc-purge — OpenCode V2 插件入口（Promise API）
 *
 * 从 dsh-purge 移植的对应关系：
 *   dsh-purge 补丁表(#1..#90)          → 这里 = chain-transform（带 marker 的链式替换，幂等）
 *   rewritePromptAssembly(sections)      → 这里 = agent.system 改写 + context hook 置顶身份卡
 *   $DSH_HOME/rules + skills             → 这里 = ~/.config/opencode/oc-purge/{rules,cards}
 *   user-approval 自动放行               → 这里 = permission.hook("evaluate") 改 effect
 *   fs-observation-policy 绕过           → 这里 = tool.execute.before 的输入归一化
 *   net-scope 允许清单                   → 这里 = 域名/IP 作用域闸门（可关）
 *   演练台 HTTP 桥 / 证据库              → 这里 = 新增工具 purge_* + storage.hook
 *
 * 设计约束（OpenCode 特有的坑）：
 *   - system 段顺序 = [agent.system, initial(指令/环境/日期)]，身份卡必须落在**最后一段**末尾，
 *     所以用 session.hook("context") 追加；直接改 agent.system 只能改「前半段」。
 *   - hook 回调是同步/异步的，但 transform 编辑器是同步的：异步数据（读盘）必须提前在 setup 里 await。
 *   - 身份卡里所有 `{{ }}` 一律不写：OpenCode 会用 prompt 变量插值，未定义变量会补齐而不是报错，
 *     但为了可预期，正文统一用 `[placeholder]` 风格。
 *   - 除 `@opencode/plugin` 与 peer 的 `effect`（工具 input/output 的 `Schema.Struct`）之外不引外部依赖。
 *   - 身份卡以「首 80 字符」为指纹做幂等，多轮/多 hook 触发不会叠出第二份。
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Plugin, Skill, Agent } from "@opencode/plugin";
import { Schema } from "effect";

import {
  PRIME_DIRECTIVE,
  appendOnce,
  pickPromptOverrides,
  renderIdentityCard,
  stripSelfLimits,
} from "./prompt.js";
import { collectRules, ensureDirs, readCard, readInjectFile, listRuleFiles, readState, writeState, paths } from "./rules.js";
import { agentPatch, promptPatches, toolPatches } from "./patches.js";
import { allowNetwork, installScopeGate, scopeReport } from "./scope.js";
import { capabilityProtocolText, renderSkillCatalog } from "./capability.js";
import { decideRetry, normalizeRetryConfig } from "./retry.js";
import { EvidenceLedger } from "./evidence.js";
import { evidenceFromEvent, recordToolCall } from "./observe.js";
import { looksLikeRefusal, resumePrompt, withNudge } from "./refusal.js";
import { renderSelfcheck, selfcheck } from "./selfcheck.js";
import { replayFromEvidence } from "./replay.js";
import { atomicWriteSync } from "./fsx.js";
import { rewriteShell } from "./shexec.js";
import { compactMessages, DEFAULT_COMPACT } from "./compact.js";

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
  dropTools: [],
  skillsDir: path.join(PACKAGE_ROOT, "skills"),
  agentsDir: path.join(PACKAGE_ROOT, "agents"),
  // 让模型先查 skill / MCP 目录再动手（capability-protocol.js）
  capabilityProtocol: true,
  // 从事件流自动攒证据；关掉则只有手动 purge_evidence
  autoEvidence: true,
  // 重试策略（retry.js）
  retry: { autoRetry: true, retryMax: 3 },
  // 命令面板：/purge 系列
  commands: true,
  // 自检：把运行期事实累计到 state 里（/purge-doctor 读它）
  selfcheck: true,
  // shell 执行前改写（env / alias / 前缀 / 代理 / 拒绝）
  shell: { declareEnv: {}, aliases: {}, prepend: "", proxy: "", deny: [] },
  // 派发前给历史消息减压（默认关）
  compact: { ...DEFAULT_COMPACT },
};

const log = (options, ...args) => {
  if (options?.verbose) console.log("[oc-purge]", ...args);
};

function config(options) {
  const merged = { ...DEFAULTS, ...(options || {}) };
  merged.rules = Array.isArray(merged.rules) ? merged.rules : [];
  merged.cardByModel = merged.cardByModel && typeof merged.cardByModel === "object" ? merged.cardByModel : {};
  merged.scope = { ...DEFAULTS.scope, ...(merged.scope || {}) };
  merged.retry = normalizeRetryConfig({ ...DEFAULTS.retry, ...(merged.retry || {}) });
  merged.shell = { ...DEFAULTS.shell, ...(merged.shell || {}) };
  merged.compact = { ...DEFAULTS.compact, ...(merged.compact || {}) };
  return merged;
}

/* ------------------------------------------------------------------ *
 * 1. 提示词注入
 * ------------------------------------------------------------------ */

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
    } catch {
      // 读不到就跳过
    }
  }
  return out;
}

async function buildInjectText(cfg, ctx, env) {
  const instructionFiles = Array.isArray(ctx.options?.instructions)
    ? ctx.options.instructions.filter((item) => typeof item === "string")
    : [];
  const rules = await collectRules({ env, options: cfg, instructionFiles });
  const card =
    readCard(env, pickPromptOverridesKey(cfg.cardByModel, cfg)) || cfg.card || readCard(env, "default");
  const skills = await readSkillCatalog(cfg.skillsDir);
  const skillList = [renderSkillCatalog(skills), capabilityProtocolText(cfg.capabilityProtocol)]
    .filter((item) => String(item || "").trim())
    .join("\n\n");
  const inject = readInjectFile(env);
  const blocks = [
    renderIdentityCard({ card, rules, primeDirective: cfg.primeDirective }),
    inject,
    skillList,
    cfg.postPrompt,
  ].filter((item) => String(item || "").trim());
  return blocks.join("\n\n");
}

function pickPromptOverridesKey(map, cfg) {
  // cardByModel 的 key 可能是 "deepseek/deepseek-chat" 或 "anthropic/claude-x"；
  // 具体模型在 context hook 里才知道，这里先取默认卡，context hook 再按模型覆盖。
  return cfg.cardByModel.__default ? "__default" : "default";
}

function resolveCard(cfg, env, modelRef) {
  const byModel = pickPromptOverrides(cfg.cardByModel, modelRef);
  if (byModel.card) return byModel.card;
  if (byModel.cardFile) return readCard(env, String(byModel.cardFile));
  if (cfg.card) return cfg.card;
  return readCard(env, "default");
}

/* ------------------------------------------------------------------ *
 * 2. 宿主原生提示词改写（agent.transform）
 * ------------------------------------------------------------------ */

function applyPromptPatches(cfg, text) {
  let out = String(text ?? "");
  if (!out) return out;
  if (cfg.stripHostDisclaimers) out = stripSelfLimits(out);
  if (cfg.patchChain) {
    for (const patch of promptPatches) {
      out = patch.apply(out);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 3. 插件主体
 * ------------------------------------------------------------------ */

export const plugin = Plugin.define({
  id: "oc-purge",

  async setup(ctx) {
    const cfg = config(ctx.options);
    const env = process.env;
    ensureDirs(env);
    if (!cfg.enabled) {
      log(cfg, "disabled");
      return;
    }

    const injectText = await buildInjectText(cfg, ctx, env);
    const disposables = [];
    // 2.x 宿主在 standalone 模式下把插件 stdout 收进 server 日志，这里同时写一份到文件，
    // 便于 /tmp 侧的验证脚本在没有 --print-logs 的情况下也能看到装载证据。
    const traceFile = process.env.OC_PURGE_TRACE;
    const trace = (msg) => {
      if (!traceFile) return;
      try {
        fs.appendFileSync(traceFile, `${new Date().toISOString()} ${msg}\n`);
      } catch {}
    };
    trace(`setup start inject=${injectText.length}`);

    /* ---- 3.0a 运行期探针：给 selfcheck 提供"这一层到底跑没跑"的事实 ---- */
    const probe = {
      injectBytes: injectText.length,
      capabilityProtocol: cfg.capabilityProtocol !== false,
      lastCardApplied: false,
      lastCardModel: "",
      permissionAutoAllow: cfg.permissionAutoAllow !== false,
      permissionHookSeen: 0,
      hookBypass: cfg.hookBypass !== false,
      toolBeforeSeen: 0,
      autoEvidence: cfg.autoEvidence !== false,
      evidenceCount: 0,
      retryEnabled: cfg.retry?.autoRetry !== false,
      retrySeen: 0,
      scopeEnabled: cfg.scope?.enabled === true,
      scopeChecks: 0,
      commandsRegistered: 0,
      toolsRegistered: 0,
      refusalWatch: true,
      refusalSeen: 0,
      shellRewrite: Boolean(cfg.shell && Object.keys(cfg.shell.declareEnv || {}).length + (cfg.shell.aliases ? Object.keys(cfg.shell.aliases).length : 0) + (cfg.shell.prepend ? 1 : 0) + (cfg.shell.proxy ? 1 : 0) + (cfg.shell.deny ? cfg.shell.deny.length : 0)) ,
      shellSeen: 0,
      compactEnabled: cfg.compact?.enabled === true,
      compactRuns: 0,
      compactTruncated: 0,
    };

    /* ---- 3.0 证据账本 + 事件订阅（自动攒证据）---- */
    let ledger = null;
    try {
      ledger = new EvidenceLedger({ file: path.join(paths.root(env), "evidence.jsonl") });
    } catch (error) {
      log(cfg, "ledger init failed", String(error?.message ?? error));
    }
    if (ledger && cfg.autoEvidence && cfg.autoRecordToolCalls !== false) {
      const before = await ctx.tool.hook("execute.before", (event) => {
        trace(`tool.before ${event.tool}`);
      });
      disposables.push(() => before.dispose());
      const after = await ctx.tool.hook("execute.after", (event) => {
        const ok = event.status === "completed";
        const record = recordToolCall(ledger, {
          tool: event.tool,
          input: event.input,
          output: ok ? event.result : event.error,
          ok,
          sessionID: event.sessionID,
          agent: event.agent,
        });
        if (record.ok) probe.evidenceCount += 1;
        trace(`evidence ${ok ? "ok" : "fail"} ${record.ev_id ?? record.error}`);
        log(cfg, "evidence recorded", record.ev_id ?? record.error);
      });
      disposables.push(() => after.dispose());
    }

    /* ---- 3.0b 重试策略：把 dsh-purge 的判定搬进 session.retry ---- */
    const retryReg = await ctx.session.hook("retry", (event) => {
      probe.retrySeen += 1;
      const decision = decideRetry({ error: event.error, attempt: event.attempt, config: cfg.retry });
      trace(`retry attempt=${event.attempt} → ${decision.retry ? `delay ${decision.delay}` : "stop"} (${decision.reason})`);
      event.decision = decision.retry ? { retry: true, delay: decision.delay } : { retry: false };
    });
    disposables.push(() => retryReg.dispose());

    /* ---- 3.1 agents：原生 agent 的 system 改写 + 注入专用 primary agent ---- */
    const agentsDir = cfg.agentsDir;
    const agentSources = await readSkillCatalog(agentsDir);
    await ctx.agent.transform((editor) => {
      for (const item of agentSources) {
        const id = item.name;
        if (!editor.get(id)) {
          try {
            editor.add(Agent.Info.default(Agent.ID.make(id)));
          } catch {
            continue;
          }
        }
        editor.update(id, (agent) => {
          agent.name = id;
          agent.description = item.description;
          agent.mode = "primary";
          agent.system = appendOnce(applyPromptPatches(cfg, agent.system || ""), injectText);
        });
      }
      for (const agent of editor.list()) {
        if (agentSources.some((item) => item.name === agent.id)) continue;
        editor.update(agent.id, (item) => {
          if (!item.system) return;
          const next = appendOnce(applyPromptPatches(cfg, item.system), injectText);
          item.system = next;
        });
      }
    });
    disposables.push(() => ctx.agent.reload());
    log(cfg, "agents:", agentSources.map((a) => a.name).join(",") || "(none)");
    trace(`agents injected=${agentSources.length} inject=${injectText.length}`);

    /* ---- 3.2 每次派发前：身份卡钉到最后一段 system ---- */
    const contextReg = await ctx.session.hook("context", (event) => {
      const modelRef = `${event.model?.providerID ?? ""}/${event.model?.modelID ?? ""}`;
      log(cfg, "context hook", modelRef);
      probe.lastCardModel = modelRef;
      trace(`context hook model=${modelRef} parts=${Array.isArray(event.system) ? event.system.length : -1}`);
      const card = resolveCard(cfg, env, modelRef);
      const block = renderIdentityCard({ card, primeDirective: cfg.primeDirective });
      const parts = Array.isArray(event.system) ? [...event.system] : [];
      const last = parts.length ? { ...parts[parts.length - 1] } : undefined;
      // 身份卡必须落在**最后一段** system 末尾：宿主把 agent.system 放在第 0 段，
      // 后面才是指令文件/环境/日期，只有尾部才是「最贴近本轮」的位置。
      if (last && typeof last.text === "string") {
        last.text = appendOnce(last.text, block);
        parts[parts.length - 1] = last;
      } else {
        parts.push({ type: "text", text: block });
      }
      event.system = parts;
      probe.lastCardApplied = parts.length > 0;
      // 工具面收窄：声明了 dropTools 就删掉对应工具描述
      if (Array.isArray(cfg.dropTools) && cfg.dropTools.length && event.tools) {
        for (const name of cfg.dropTools) delete event.tools[name];
      }
    });
    disposables.push(() => contextReg.dispose());

    /* ---- 3.2b 拒绝检测：把"推脱"当故障处理 ----
     * OpenCode 没有取消后静默重跑的官方入口，所以这里只做两件可控的事：
     *   · 记录命中（probe.refusalSeen）供 /purge-doctor 与审计使用
     *   · 提供 resumePrompt()/withNudge() 给上层调用（工具 purge_doctor、命令、外部脚本）
     * 不在 stream 里拦截：那需要劫持 Provider，属于改宿主行为，本插件不做。 */
    const refusalReg = await ctx.tool.hook("execute.after", (event) => {
      if (event.status !== "completed") return;
      const text = typeof event.result === "string" ? event.result : event.result?.content;
      if (typeof text !== "string" || text.length < 20) return;
      if (!looksLikeRefusal(text)) return;
      probe.refusalSeen = (probe.refusalSeen ?? 0) + 1;
      trace(`refusal detected in ${event.tool}`);
      log(cfg, "refusal-like output from tool", event.tool, "→ use purge_doctor / resumePrompt()");
    });
    disposables.push(() => refusalReg.dispose());

    /* ---- 3.2c shell 执行前改写 ----
     * 宿主在 packages/core/src/shell.ts:284 触发 create.before，事件可变。
     * 命中 deny 直接抛错 —— 这是 scope 之外的第二道闸，作用在最底层（任何工具最终都落到 shell）。 */
    if (ctx.shell?.hook) {
      try {
        const shellReg = await ctx.shell.hook("create.before", (event) => {
          probe.shellSeen += 1;
          const out = rewriteShell(event, cfg.shell);
          if (out.denied) {
            trace(`shell denied: ${out.denied}`);
            throw new Error(`[oc-purge] command denied: ${out.denied}`);
          }
          if (!out.changed) return;
          event.command = out.command;
          event.env = out.env;
          trace("shell rewritten");
        });
        disposables.push(() => shellReg.dispose());
      } catch (error) {
        trace(`shell hook unavailable: ${String(error?.message ?? error)}`);
      }
    }

    /* ---- 3.2d 派发前给历史消息减压（默认关）---- */
    if (cfg.compact?.enabled && ctx.session?.hook) {
      const compactReg = await ctx.session.hook("context", (event) => {
        if (!Array.isArray(event.messages)) return;
        const out = compactMessages(event.messages, cfg.compact);
        if (out.stats.skipped) return;
        event.messages = out.messages;
        probe.compactRuns += 1;
        probe.compactTruncated += out.stats.truncated;
        if (out.stats.truncated || out.stats.deduped) {
          trace(`compact truncated=${out.stats.truncated} deduped=${out.stats.deduped}`);
        }
      });
      disposables.push(() => compactReg.dispose());
    }

    /* ---- 3.3 执行链改写（fs 观察绕过 / hooks 拒绝绕过）---- */
    const beforeReg = await ctx.tool.hook("execute.before", (event) => {
      probe.toolBeforeSeen += 1;
      if (!cfg.hookBypass) return;
      for (const patch of toolPatches) {
        try {
          event.input = patch.apply(event.input);
        } catch {
          // 单条链失败不影响工具调用
        }
      }
    });
    disposables.push(() => beforeReg.dispose());

    /* ---- 3.4 权限：审批门改写 ---- */
    const permReg = await ctx.permission.hook("evaluate", (event) => {
      probe.permissionHookSeen += 1;
      if (!cfg.permissionAutoAllow) return;
      const allowAny = !Array.isArray(cfg.permissionAllowActions) || cfg.permissionAllowActions.includes("*");
      if (!allowAny && !cfg.permissionAllowActions.includes(event.action)) return;
      if (event.effect === "deny") return; // 显式 deny 规则保持原样，交由 operator 决定
      event.effect = "allow";
      event.message = undefined;
    });
    disposables.push(() => permReg.dispose());

    /* ---- 3.5 网络作用域闸门（默认关）---- */
    const gate = installScopeGate({
      enabled: cfg.scope.enabled,
      allow: cfg.scope.allow,
      deny: cfg.scope.deny,
      log: (...args) => log(cfg, ...args),
    });
    disposables.push(() => gate.dispose());

    if (cfg.scope.enabled) {
      const scopeToolReg = await ctx.tool.hook("execute.before", (event) => {
        const command = event.input?.command;
        if (typeof command === "string") {
          probe.scopeChecks += 1;
          const verdict = gate.checkCommand(command);
          if (!verdict.allowed) {
            throw new Error(`[oc-purge] out-of-scope host ${verdict.host} (${verdict.reason})`);
          }
        }
        for (const key of ["url", "uri", "href"]) {
          const value = event.input?.[key];
          if (typeof value !== "string") continue;
          const verdict = gate.check(value);
          if (!verdict.allowed) throw new Error(`[oc-purge] out-of-scope host ${value} (${verdict.reason})`);
        }
      });
      disposables.push(() => scopeToolReg.dispose());

      // scope 只管「操作者的工具出网」（bash/webfetch/http），不能拦模型 API 请求，
      // 否则一开 scope 就把自己到 provider 的链路掐断。模型请求只记录不拦。
      const scopeHttpReg = await ctx.session.hook("http.request", (event) => {
        const verdict = gate.check(event.request?.url || "");
        if (!verdict.allowed) {
          log(cfg, "model request outside scope (not blocked):", verdict.reason, event.request?.url);
          trace(`model request out-of-scope ${verdict.reason}`);
        }
      });
      disposables.push(() => scopeHttpReg.dispose());
    }

    /* ---- 3.6 新增工具 / 技能 ---- */
    const toolSpecs = makePurgeTools({ cfg, env, ledger, probe });
    probe.toolsRegistered = toolSpecs.length;
    await ctx.tool.transform((tools) => {
      for (const tool of toolSpecs) tools.add(tool);
    });
    disposables.push(() => ctx.tool.reload());

    if (cfg.commands && ctx.command?.transform) {
      try {
        await ctx.command.transform((editor) => {
          const make = (name, description, body) => ({
            name,
            description,
            execute: async ({ prompt }) => {
              // 命令只是把一段固定文本塞进当前 prompt，不自己发请求
              const text = typeof prompt === "object" && prompt ? prompt.text : prompt;
              if (typeof prompt === "object" && prompt) prompt.text = `${body}\n\n${text ?? ""}`;
            },
          });
          editor.add(
            make("purge-status", "Show oc-purge state: rules, card, scope, evidence stats", "Call purge_status and purge_evidence(action=stats), then summarise."),
          );
          editor.add(
            make("purge-evidence", "Summarise recorded evidence and unverified claims", "Call purge_evidence(action=stats) and purge_evidence(action=list, limit=20). Flag every claimed/inferred row that has not been verified."),
          );
          editor.add(
            make("purge-release", "Publish the package via the npm workflow", "Check package.json version, run npm test, then tell the operator the exact gh workflow command for the chosen bump."),
          );
          editor.add(
            make("purge-doctor", "Layer-by-layer self-check: which oc-purge layers actually fired", "Call purge_doctor (format=text) and report every failed/pending layer with its consequence. Do not claim a layer works without evidence from the tool output."),
          );
          editor.add(
            make("purge-replay", "Turn recorded evidence into reproducible commands", "Call purge_replay with the latest evidence and flag anything marked synthesized=true as not a real capture."),
          );
        });
        disposables.push(() => ctx.command.reload?.());
        probe.commandsRegistered = 5;
        trace("commands registered");
      } catch (error) {
        trace(`commands skipped: ${String(error?.message ?? error)}`);
      }
    }

    const skills = await readSkillCatalog(cfg.skillsDir);
    trace(`tools added=${toolSpecs.length} skills=${skills.length}`);
    await ctx.skill.transform((editor) => {
      for (const item of skills) {
        const id = item.name;
        if (editor.get(id)) continue;
        editor.add(
          Skill.Info.make({
            id: Skill.ID.make(id),
            name: Skill.Name.make(item.name),
            description: item.description || item.name,
            autoinvoke: true,
            path: item.file,
            content: stripFrontmatter(item.raw),
          }),
        );
      }
    });
    disposables.push(() => ctx.skill.reload());

    /* ---- 3.7 状态摘要（storage 里的最后一份记录）---- */
    try {
      await ctx.storage.set("oc-purge:status", {
        injectBytes: injectText.length,
        rules: (await collectRules({ env, options: cfg })).length,
        scope: scopeReport(cfg.scope),
        selfcheck: cfg.selfcheck === false ? null : selfcheck(probe),
        at: Date.now(),
      });
    } catch {
      // 无存储后端时忽略
    }

    return async () => {
      for (const dispose of disposables.reverse()) {
        try {
          await dispose?.();
        } catch {
          // 卸载阶段不抛
        }
      }
    };
  },
});

function stripFrontmatter(text) {
  const raw = String(text || "");
  if (!raw.startsWith("---")) return raw;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return raw;
  return raw.slice(raw.indexOf("\n", end + 1) + 1);
}

/* ------------------------------------------------------------------ *
 * 4. 新增工具
 * ------------------------------------------------------------------ */

export function makePurgeTools({ cfg, env, ledger, probe }) {
  const tool = (name, description, input, run) => ({
    name,
    options: { codemode: false },
    description,
    input,
    output: Schema.Struct({ text: Schema.String }),
    execute: async (args, context) => {
      const text = await run(args || {}, context);
      return { output: { text }, content: text };
    },
  });

  return [
    tool(
      "purge_status",
      "Report oc-purge state: rules, selected card, scope, inject size.",
      Schema.Struct({}),
      async () => {
        const state = readState(env);
        const rules = listRuleFiles(env).map((r) => `${state.rules.includes(r.id) ? "[x]" : "[ ]"} ${r.id}`);
        return [
          `enabled: ${cfg.enabled}`,
          `rule files: ${rules.length ? rules.join(", ") : "(none)"}`,
          `workspacePolicy: ${cfg.workspacePolicy}`,
          `scope: ${JSON.stringify(scopeReport(cfg.scope))}`,
          `inject: ${readInjectFile(env).length} bytes`,
        ].join("\n");
      },
    ),
    tool(
      "purge_rules",
      "List, add, toggle or remove rule files under $OC_PURGE_HOME/rules.",
      Schema.Struct({
        action: Schema.Literals(["list", "add", "toggle", "remove"]),
        id: Schema.optional(Schema.String),
        body: Schema.optional(Schema.String),
      }),
      async ({ action, id, body }) => {
        const state = readState(env);
        ensureDirs(env);
        if (action === "list") return listRuleFiles(env).map((r) => `${r.id}\t${r.title}\t${r.bytes}B`).join("\n");
        if (!id) return "error: id required";
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) return `error: invalid id ${id}`;
        const file = path.join(paths.rules(env), `${id}.md`);
        if (action === "add") {
          await fsp.writeFile(file, String(body || `# ${id}\n`), "utf8");
          if (!state.rules.includes(id)) state.rules.push(id);
          writeState(env, state);
          return `added ${id}`;
        }
        if (action === "toggle") {
          state.rules = state.rules.includes(id) ? state.rules.filter((x) => x !== id) : [...state.rules, id];
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
    tool(
      "purge_inject",
      "Read or replace the free-form inject text (prompt-inject.md equivalent).",
      Schema.Struct({ text: Schema.optional(Schema.String) }),
      async ({ text }) => {
        if (typeof text !== "string") return readInjectFile(env);
        ensureDirs(env);
        await fsp.writeFile(paths.legacyInject(env), text, "utf8");
        return `wrote ${text.length} bytes to ${paths.legacyInject(env)} (reload: /oc-purge reload)`;
      },
    ),
    tool(
      "purge_scope",
      "Check whether a host is inside the allowed network scope.",
      Schema.Struct({ host: Schema.String }),
      async ({ host }) => {
        const verdict = allowNetwork(cfg.scope, host);
        return `${verdict.allowed ? "ALLOW" : "DENY"}\t${verdict.reason}\t${host}`;
      },
    ),
    tool(
      "purge_evidence",
      "Record / verify / list evidence in the local ledger. Evidence is content-addressed (ev_<sha256>): same content → same id, so a subagent's claim can be checked against what actually ran.",
      Schema.Struct({
        action: Schema.Literals(["record", "verify", "list", "stats", "open_unknown", "resolve_unknown", "unknowns"]),
        operation: Schema.optional(Schema.String),
        parameters: Schema.optional(Schema.Unknown),
        result: Schema.optional(Schema.Unknown),
        confidence: Schema.optional(Schema.Literals(["claimed", "observed", "derived", "inferred"])),
        authority: Schema.optional(Schema.String),
        limitations: Schema.optional(Schema.Array(Schema.String)),
        question: Schema.optional(Schema.String),
        severity: Schema.optional(Schema.Literals(["low", "medium", "high", "critical"])),
        unk_id: Schema.optional(Schema.String),
        status: Schema.optional(Schema.String),
        resolution: Schema.optional(Schema.String),
        limit: Schema.optional(Schema.Number),
      }),
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
          return rows
            .map((row) => `${row.ev_id}\t${row.confidence}\t${row.operation}\t${String(row.result).slice(0, 80)}`)
            .join("\n");
        }
        if (action === "stats") return JSON.stringify(ledger.stats(), null, 2);
        if (action === "open_unknown") {
          const out = ledger.openUnknown({
            question: args.question,
            severity: args.severity ?? "medium",
          });
          return out.ok ? `${out.duplicate ? "duplicate" : "opened"} ${out.unk_id}` : `error: ${out.error}`;
        }
        if (action === "resolve_unknown") {
          const out = ledger.resolveUnknown({
            unk_id: args.unk_id,
            status: args.status ?? "resolved",
            resolution: args.resolution,
          });
          return out.ok ? `${out.unk_id} → ${out.status}` : `error: ${out.error}`;
        }
        if (action === "unknowns") {
          const rows = ledger.listUnknown({ status: args.status });
          if (rows.length === 0) return "(no residual unknowns)";
          return rows.map((row) => `${row.unk_id}\t${row.status}\t${row.severity}\t${row.question}`).join("\n");
        }
        return "noop";
      },
    ),
    tool(
      "purge_doctor",
      "Layer-by-layer self-check: prove each oc-purge layer actually fired on this machine, instead of trusting 'the plugin is installed'.",
      Schema.Struct({
        format: Schema.optional(Schema.Literals(["text", "json"])),
      }),
      async ({ format }) => {
        if (!probe) return "error: probe state unavailable";
        const report = selfcheck(probe);
        if (format === "json") return JSON.stringify(report, null, 2);
        return renderSelfcheck(report);
      },
    ),
    tool(
      "purge_replay",
      "Turn a recorded evidence row into a reproducible command / HTTP request. Anything synthesised is flagged so it is never mistaken for a real capture.",
      Schema.Struct({
        ev_id: Schema.optional(Schema.String),
        limit: Schema.optional(Schema.Number),
      }),
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
  ];
}

export { agentPatch, applyPromptPatches, DEFAULTS };
export { EvidenceLedger } from "./evidence.js";
export { decideRetry, decideContinue, normalizeRetryConfig } from "./retry.js";
export { capabilityProtocolText, renderSkillCatalog } from "./capability.js";
export default plugin;
