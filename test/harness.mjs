// 最小宿主替身：按 packages/core/src/plugin/host.ts 的语义实现各 domain
import { Schema } from "effect";

export function makeHost({ options = {}, agentSystem = "You are a coding agent.", instructions = [] } = {}) {
  const hooks = new Map();
  const add = (domain, name, cb) => {
    const id = `${domain}.${name}`;
    hooks.set(id, [...(hooks.get(id) ?? []), cb]);
    return { dispose: async () => { hooks.set(id, (hooks.get(id) ?? []).filter((x) => x !== cb)); } };
  };
  const fire = async (domain, name, event) => {
    for (const cb of hooks.get(`${domain}.${name}`) ?? []) await cb(event);
    return event;
  };
  const agents = [
    {
      id: "general",
      name: "general",
      mode: "primary",
      hidden: false,
      system: agentSystem,
      permissions: [],
      request: { settings: {}, headers: {}, body: {} },
    },
  ];
  const tools = [];
  const skills = [];
  const commands = [];
  const ctx = {
    options,
    app: { name: "opencode", version: "2.2.0", channel: "dev" },
    location: { directory: process.cwd() },
    agent: {
      transform: async (cb) => {
        const editor = {
          list: () => agents,
          get: (id) => agents.find((a) => a.id === id),
          add: (a) => agents.push(a),
          update: (id, fn) => { const a = agents.find((x) => x.id === id); if (a) fn(a); },
          remove: (id) => { const i = agents.findIndex((a) => a.id === id); if (i >= 0) agents.splice(i, 1); },
          default: () => {},
        };
        cb(editor);
        return { dispose: async () => {} };
      },
      reload: async () => {},
      list: async () => agents,
    },
    session: {
      hook: (name, cb) => add("session", name, cb),
    },
    tool: {
      transform: async (cb) => {
        cb({ add: (t) => tools.push(t), list: () => tools, get: (n) => tools.find((t) => t.name === n), update: () => {}, remove: () => {}, namespace: () => {} });
        return { dispose: async () => {} };
      },
      hook: (name, cb) => add("tool", name, cb),
      reload: async () => {},
      list: async () => tools,
    },
    permission: { hook: (name, cb) => add("permission", name, cb) },
    shell: { hook: (name, cb) => add("shell", name, cb) },
    skill: {
      transform: async (cb) => {
        cb({ list: () => skills, get: (id) => skills.find((s) => s.id === id), add: (s) => skills.push(s), update: () => {}, remove: () => {} });
        return { dispose: async () => {} };
      },
      reload: async () => {},
    },
    command: {
      transform: async (cb) => {
        const added = [];
        cb({ add: (def) => added.push(def), list: () => added });
        commands.push(...added);
        return { dispose: async () => {} };
      },
      reload: async () => {},
      list: async () => commands,
    },
    storage: { get: async () => undefined, set: async () => {}, remove: async () => {}, scan: async () => ({ entries: [] }) },
    experimental: {},
  };
  return { ctx, fire, agents, tools, skills, commands };
}

export { Schema };
