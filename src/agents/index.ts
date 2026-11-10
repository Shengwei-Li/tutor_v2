import os from 'node:os';
import { program, run } from '../proc.ts';
import { AcpSession } from './acp.ts';
import { ClaudeCodeSession, claudeEnv } from './claude.ts';
import { CodexSession } from './codex.ts';
import type { AgentId, AgentSession, AgentStatus, SessionStart } from './types.ts';

export type { AgentEvent, AgentId, AgentSession, AgentStatus, McpLaunch, SessionStart } from './types.ts';

export const AGENTS: { id: AgentId; label: string; program: string; signIn: string; install: string }[] = [
  { id: 'codex', label: 'Codex', program: 'codex', signIn: 'codex login', install: 'https://developers.openai.com/codex' },
  { id: 'claude-code', label: 'Claude Code', program: 'claude', signIn: 'claude auth login', install: 'https://claude.com/claude-code' },
  { id: 'opencode', label: 'OpenCode', program: 'opencode', signIn: 'opencode auth login', install: 'https://opencode.ai' },
];

export const agentLabel = (id: string) => AGENTS.find((a) => a.id === id)?.label ?? id;

export function createSession(agent: AgentId, opts: SessionStart): AgentSession {
  switch (agent) {
    case 'claude-code':
      return new ClaudeCodeSession(opts);
    case 'codex':
      return new CodexSession(opts);
    case 'opencode':
      return new AcpSession(opts);
  }
}

/** Installed? Signed in? Asked of each agent's own program, without starting a conversation. */
export async function agentStatus(): Promise<AgentStatus[]> {
  return Promise.all(
    AGENTS.map(async (a): Promise<AgentStatus> => {
      const exe = await program(a.program);
      if (!exe) return { id: a.id, label: a.label, installed: false, hint: `Install ${a.label}: ${a.install}` };
      // Claude Code answers for the tutor's own sign-in only outside another Claude Code session's environment.
      const ask = (args: string[]) => run(exe.command, [...exe.prefixArgs, ...args], { cwd: os.homedir(), timeoutMs: 20_000, env: a.id === 'claude-code' ? claudeEnv() : undefined });
      const version = /\d+\.\d+\.\d+/.exec((await ask(['--version'])).output)?.[0];
      let signedIn: boolean | undefined;
      if (a.id === 'claude-code') {
        try {
          signedIn = (JSON.parse((await ask(['auth', 'status'])).output) as { loggedIn?: boolean }).loggedIn === true;
        } catch {
          signedIn = false;
        }
      } else if (a.id === 'codex') {
        const r = await ask(['login', 'status']);
        signedIn = r.code === 0 && /logged in/i.test(r.output);
      }
      // OpenCode reports its providers only once a session starts.
      return { id: a.id, label: a.label, installed: true, version, signedIn, hint: signedIn === false ? `Sign in to ${a.label}: run \`${a.signIn}\` once.` : undefined };
    }),
  );
}
