/**
 * oc-purge / capability-protocol — 让模型先查目录再动手
 *
 * 移植自 dsh-purge `lib/capability-protocol.js`。原项目发现：模型经常凭记忆硬写，
 * 不看已装的 skill / MCP，于是同一件事反复造轮子。这段协议强制「先读目录 → 再选 → 最后才自己写」。
 *
 * 放在独立文件里，方便按需在注入文本中开关（config.capabilityProtocol）。
 */

export const CAPABILITY_SECTION = "oc-purge:capabilities";

export const CAPABILITY_PROTOCOL = `## Capability selection by task (mandatory)

1. **Read first** — inspect the available skills, MCP servers and host tools for this session before acting. Know what exists.
2. **Match the task** — pick the skill(s) / MCP tool(s) that fit *this* request. Not "always use something", not "never use something".
3. **Call what matches** —
   - Skill fits → load it and follow its methods, premises, branch conditions and counter-evidence.
   - MCP / CLI fits → call it with the real schema; treat failures by the tool's own semantics.
4. **Only then DIY** — if nothing in the catalog fits, use shell / ad-hoc steps, and say what was missing.
5. **Delegates inherit this rule** — any subagent or teammate must read the catalog and call task-matched skills/MCP the same way. Put that requirement in the child brief.
6. Host skills and MCP stay available; this block does not remove any tool.`;

/** @returns {string} 关闭时返回空串，便于直接拼进注入文本 */
export function capabilityProtocolText(enabled = true) {
  return enabled ? CAPABILITY_PROTOCOL : "";
}

/** 把当前会话可用的 skill 名单渲染成目录表（没有 skill 时返回空串） */
export function renderSkillCatalog(skills = []) {
  if (!Array.isArray(skills) || skills.length === 0) return "";
  const lines = skills
    .filter((skill) => skill && skill.name)
    .map((skill) => `- \`${skill.name}\` — ${skill.description || "(no description)"}`);
  if (lines.length === 0) return "";
  return ["## Available skills (this session)", ...lines].join("\n");
}
