import { spawn } from 'node:child_process';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { program, run, stopProcess, type Program } from '../proc.ts';
import { claudeEnv, claudeExecutable } from './claude.ts';
import { JsonRpcPeer } from './jsonrpc.ts';
import { agentEnv } from './session-base.ts';
import type { AgentId } from './types.ts';

/** A model the agent offers, and the thinking levels it takes (the agent's own names, lowest first). */
export interface ModelChoice {
  id: string;
  label: string;
  efforts: string[];
}

export interface ModelList {
  models: ModelChoice[];
  /** The levels of the model the agent uses when none is chosen. */
  defaultEfforts: string[];
  /** What the agent's default model is called, when it says. */
  defaultLabel?: string;
}

/** How hard the tutor wants the agent to think. "standard" is the agent's own default, so it sends nothing. */
export type Effort = 'fast' | 'standard' | 'deep';

/**
 * The agent's name for a level: the lowest it has for "fast", its highest short of "max" for "deep".
 * Undefined means leave it to the agent.
 */
export function nativeEffort(effort: Effort | undefined, levels: string[]): string | undefined {
  if (!effort || effort === 'standard' || !levels.length) return undefined;
  const usable = levels.filter((l) => l !== 'max' && l !== 'none' && l !== 'minimal');
  if (!usable.length) return undefined;
  return effort === 'fast' ? usable[0] : usable.at(-1);
}

const ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const byLevel = (a: string, b: string) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99);

/**
 * The models the agent offers the tutor's own account, asked of the agent itself so the list follows
 * its updates and the tutor's plan. Nothing is sent to a model, so asking costs nothing.
 */
export async function listModels(agent: AgentId, o: { cwd: string; executable?: Program; timeoutMs?: number }): Promise<ModelList> {
  const timeoutMs = o.timeoutMs ?? 45_000;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('The agent took too long to list its models.')), timeoutMs);
  });
  try {
    const ask = agent === 'claude-code' ? claudeModels(o.cwd) : agent === 'codex' ? codexModels(o.cwd, o.executable) : opencodeModels(o.cwd, o.executable, timeoutMs);
    return await Promise.race([ask, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Claude Code reports its models during the SDK handshake, before any message. */
async function claudeModels(cwd: string): Promise<ModelList> {
  const abort = new AbortController();
  const never: AsyncIterable<SDKUserMessage> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
  try {
    const q = query({ prompt: never, options: { cwd, env: claudeEnv(), abortController: abort, settingSources: [], pathToClaudeCodeExecutable: await claudeExecutable() } });
    const rows = await q.supportedModels();
    const levels = (r: (typeof rows)[number]) => (r.supportsEffort ? [...(r.supportedEffortLevels ?? ['low', 'medium', 'high'])].sort(byLevel) : []);
    // The "default" row stands for whichever model the account defaults to.
    const def = rows.find((r) => r.value === 'default');
    return {
      models: rows.filter((r) => r !== def).map((r) => ({ id: r.value, label: r.displayName, efforts: levels(r) })),
      defaultEfforts: def ? levels(def) : [],
      defaultLabel: def && rows.find((r) => r !== def && r.resolvedModel && r.resolvedModel === def.resolvedModel)?.displayName,
    };
  } finally {
    abort.abort();
  }
}

interface CodexModel {
  model: string;
  displayName: string;
  hidden: boolean;
  isDefault: boolean;
  supportedReasoningEfforts?: { reasoningEffort: string }[];
}

/** Codex answers `model/list` on its app-server. */
async function codexModels(cwd: string, executable?: Program): Promise<ModelList> {
  const exe = executable ?? (await program('codex'));
  if (!exe) throw new Error('Codex is not installed.');
  const child = spawn(exe.command, [...exe.prefixArgs, 'app-server'], { cwd, env: agentEnv(), windowsHide: true });
  try {
    const peer = new JsonRpcPeer(child, { header: false });
    await peer.request('initialize', { clientInfo: { name: 'tutordesk', title: 'TutorDesk', version: '2' }, capabilities: null });
    peer.notify('initialized');
    const all: CodexModel[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const r: { data: CodexModel[]; nextCursor?: string | null } = await peer.request('model/list', { cursor });
      all.push(...r.data);
      cursor = r.nextCursor ?? null;
      if (!cursor) break;
    }
    const levels = (m: CodexModel) => (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort).sort(byLevel);
    const def = all.find((m) => m.isDefault);
    return {
      models: all.filter((m) => !m.hidden).map((m) => ({ id: m.model, label: m.displayName, efforts: levels(m) })),
      defaultEfforts: def ? levels(def) : [],
      defaultLabel: def?.displayName,
    };
  } finally {
    await stopProcess(child);
  }
}

/**
 * `opencode models` prints the provider/model ids the tutor has set up, the same ids its ACP model
 * option takes. (Asking over ACP would need a session, which OpenCode then keeps in its history.)
 * Its thinking levels are known only inside a session, so none are listed.
 */
async function opencodeModels(cwd: string, executable: Program | undefined, timeoutMs: number): Promise<ModelList> {
  const exe = executable ?? (await program('opencode'));
  if (!exe) throw new Error('OpenCode is not installed.');
  const r = await run(exe.command, [...exe.prefixArgs, 'models'], { cwd, env: agentEnv(), timeoutMs });
  if (r.code !== 0) throw new Error(r.output.trim().split(/\r?\n/).at(-1) || 'OpenCode could not list its models.');
  const models = r.output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[\w.-]+\/\S+$/.test(l))
    .map((id) => ({ id, label: id, efforts: [] }));
  return { models, defaultEfforts: [] };
}
