/**
 * oc-purge / selfcheck — 逐层自检"这次装配到底生效了没有"
 *
 * 移植自 kingcharleslzy-ai/dsh-purge 的 `lib/selfcheck.js`。原项目的核心观念：
 * 插件装上 ≠ 破甲生效，必须**分层证明**每一层真的在工作，否则出问题时只能猜。
 *
 * DSH 版每层对应一组宿主补丁 id。OpenCode 侧不 patch 宿主，所以每层对应的是
 * 我们自己注册的 hook / tool / 注入段 —— `kind` 从 host/runtime/config 改成
 * hook / prompt / tool / state。
 *
 * 关键设计（照抄上游）：**只有明确不适用时才从分母里去掉**，
 * 否则"没跑起来"会被算成"不需要"，自检永远 100%。
 */

/** 每一层：id、说明、检测函数、失败时会发生什么 */
export const BYPASS_LAYERS = Object.freeze([
  {
    id: "prompt.inject",
    kind: "prompt",
    title: "身份卡注入",
    why: "没有这层，模型回到宿主自带的自我定位，前功尽弃",
    probe: (state) => (state.injectBytes > 0 ? "applied" : "failed"),
    detail: (state) => `${state.injectBytes} bytes`,
  },
  {
    id: "prompt.capability",
    kind: "prompt",
    title: "能力选用协议",
    why: "模型不看 skill/MCP 目录，就会凭记忆硬写",
    probe: (state) => (state.capabilityProtocol ? "applied" : "off"),
    detail: (state) => (state.capabilityProtocol ? "enabled" : "disabled by config"),
  },
  {
    id: "prompt.card",
    kind: "prompt",
    title: "身份卡落位",
    why: "卡没贴到最后一段 system 就会被指令文件压过去",
    probe: (state) => (state.lastCardApplied ? "applied" : "pending"),
    detail: (state) => (state.lastCardModel ? `model=${state.lastCardModel}` : "no request yet"),
  },
  {
    id: "permission.evaluate",
    kind: "hook",
    title: "审批自动放行",
    why: "没有这层，每个需审批的动作都会卡住整轮",
    probe: (state) =>
      !state.permissionAutoAllow ? "off" : state.permissionHookSeen > 0 ? "applied" : "pending",
    detail: (state) => `${state.permissionHookSeen ?? 0} evaluations seen`,
  },
  {
    id: "tool.before",
    kind: "hook",
    title: "工具链改写",
    why: "路径归一化与重复记账失效，长会话里会出现莫名其妙的工具报错",
    probe: (state) => (!state.hookBypass ? "off" : state.toolBeforeSeen > 0 ? "applied" : "pending"),
    detail: (state) => `${state.toolBeforeSeen ?? 0} tool calls seen`,
  },
  {
    id: "tool.after",
    kind: "hook",
    title: "证据自动落账",
    why: "没有这层，账本是空的，verify 无从比对",
    probe: (state) => (!state.autoEvidence ? "off" : state.evidenceCount > 0 ? "applied" : "pending"),
    detail: (state) => `${state.evidenceCount ?? 0} evidence rows`,
  },
  {
    id: "retry.decision",
    kind: "hook",
    title: "重试判定",
    why: "没有这层，永久错误会被反复重试，白烧配额",
    probe: (state) => (!state.retryEnabled ? "off" : state.retrySeen > 0 ? "applied" : "pending"),
    detail: (state) => `${state.retrySeen ?? 0} retries evaluated`,
  },
  {
    id: "scope.gate",
    kind: "hook",
    title: "作用域闸门",
    why: "关着也能用，但一旦要限定目标就没有兜底",
    probe: (state) => (state.scopeEnabled ? (state.scopeChecks > 0 ? "applied" : "pending") : "off"),
    detail: (state) => (state.scopeEnabled ? `${state.scopeChecks ?? 0} checks` : "disabled by config"),
  },
  {
    id: "commands",
    kind: "tool",
    title: "命令面板",
    why: "常用动作得每次打自然语言，慢且不一致",
    probe: (state) => (state.commandsRegistered ? "applied" : "off"),
    detail: (state) => `${state.commandsRegistered ?? 0} commands`,
  },
  {
    id: "tools.purge",
    kind: "tool",
    title: "purge_* 工具面",
    why: "模型没有任何入口读写规则/证据/作用域",
    probe: (state) => (state.toolsRegistered > 0 ? "applied" : "failed"),
    detail: (state) => `${state.toolsRegistered ?? 0} tools`,
  },
  {
    id: "refusal.watch",
    kind: "hook",
    title: "拒绝检测",
    why: "模型推脱时没有任何记录，问题会被当成'模型不太行'和稀泥过去",
    probe: (state) => (state.refusalWatch ? "applied" : "off"),
    detail: (state) => `${state.refusalSeen ?? 0} detected`,
  },
]);

const NOT_APPLICABLE = new Set(["na", "off", "disabled"]);

/**
 * 汇总。只有 `na`/`off`/`disabled` 从分母里去掉；
 * `pending` 留在分母里 —— 那是"装了但还没被触发"，不是"不需要"。
 */
export function tallyLayers(results) {
  const out = {
    applied: 0,
    pending: 0,
    failed: 0,
    not_applicable: 0,
    total: 0,
    layers: [],
  };
  for (const item of results) {
    const status = item.status;
    if (NOT_APPLICABLE.has(status)) out.not_applicable += 1;
    else {
      out.total += 1;
      if (status === "applied") out.applied += 1;
      else if (status === "failed") out.failed += 1;
      else out.pending += 1;
    }
    out.layers.push(item);
  }
  out.ratio = out.total === 0 ? 1 : Number((out.applied / out.total).toFixed(3));
  return out;
}

/**
 * 跑一遍所有层。`state` 由插件在运行期累积（见 index.js 的 `probe` 对象）。
 * @returns {{applied:number,pending:number,failed:number,not_applicable:number,total:number,ratio:number,layers:Array}}
 */
export function selfcheck(state = {}) {
  const results = BYPASS_LAYERS.map((layer) => {
    let status;
    try {
      status = layer.probe(state);
    } catch {
      status = "failed";
    }
    return {
      id: layer.id,
      kind: layer.kind,
      title: layer.title,
      status,
      detail: safeDetail(layer, state),
      why: layer.why,
    };
  });
  return tallyLayers(results);
}

function safeDetail(layer, state) {
  try {
    return typeof layer.detail === "function" ? layer.detail(state) : "";
  } catch {
    return "";
  }
}

/** 渲染成给模型/人看的文本 */
export function renderSelfcheck(report) {
  const icon = { applied: "✓", pending: "·", failed: "✗", na: "-", off: "-", disabled: "-" };
  const lines = report.layers.map(
    (layer) => `${icon[layer.status] ?? "?"} ${layer.id.padEnd(22)} ${layer.status.padEnd(10)} ${layer.detail}`,
  );
  lines.push("");
  lines.push(
    `applied ${report.applied}/${report.total}  pending ${report.pending}  failed ${report.failed}  ` +
      `not-applicable ${report.not_applicable}  ratio ${report.ratio}`,
  );
  const failed = report.layers.filter((layer) => layer.status === "failed");
  if (failed.length) {
    lines.push("");
    lines.push("failed layers:");
    for (const layer of failed) lines.push(`  ${layer.id}: ${layer.why}`);
  }
  return lines.join("\n");
}
