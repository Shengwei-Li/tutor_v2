import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { query, type CanUseTool, type EffortLevel, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { findProgram } from '../proc.ts';
import { AsyncQueue, BaseSession, DENIED, allowed, splitToolName, type ActionKind } from './session-base.ts';
import { IMAGE_INPUT_MAX, type Image, type SessionStart } from './types.ts';

type MessageParam = SDKUserMessage['message'];

/** Variables that make a nested CLI think it runs inside another Claude Code session. */
const NESTING_VARS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'];

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'TodoWrite', 'Skill', 'ToolSearch']);
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const COMMAND_TOOLS = ['Bash', 'PowerShell', 'BashOutput', 'KillShell', 'KillBash', 'Task', 'Agent'];
const NETWORK_TOOLS = ['WebFetch', 'WebSearch'];

function classify(tool: string): ActionKind {
  if (splitToolName(tool).server === 'tutordesk') return 'toolbox';
  if (READ_TOOLS.has(tool)) return 'read';
  if (EDIT_TOOLS.has(tool)) return 'edit';
  return 'other';
}

/** The file a tool call reads or writes, if it names one. */
function target(input: Record<string, unknown>): string | undefined {
  for (const k of ['file_path', 'notebook_path', 'path']) if (typeof input[k] === 'string' && input[k]) return input[k] as string;
  const pattern = input.pattern;
  if (typeof pattern === 'string' && path.isAbsolute(pattern)) return pattern.replace(/[*?[{].*$/, '') || pattern;
  return undefined;
}

/** The environment for the Claude Code process: the tutor's own sign-in, never a stray API key. */
export function claudeEnv(extra?: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...extra })) if (v !== undefined) env[k] = v;
  for (const v of [...NESTING_VARS, 'ANTHROPIC_API_KEY']) delete env[v];
  return env;
}

/** The tutor's own Claude Code, so their sign-in is used: the program, or the script npm installed. */
export async function claudeExecutable(): Promise<string | undefined> {
  return (await findProgram('claude'))?.at(-1);
}

function summarise(content: unknown): string | undefined {
  if (typeof content === 'string') return content.slice(0, 400);
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).join(' ').slice(0, 400) || undefined;
  return undefined;
}

/**
 * Claude Code through the Agent SDK in streaming-input mode: one long-lived process per conversation,
 * each send() a user message. The tutordesk tools and the workspace's skills are given to this session
 * only; the tutor's own Claude Code settings are neither read nor changed.
 */
export class ClaudeCodeSession extends BaseSession {
  readonly agent = 'claude-code' as const;
  private input = new AsyncQueue<SDKUserMessage>();
  private q: Query | undefined;
  private abort = new AbortController();
  private interrupted = false;
  private tools = new Map<string, string>();
  private hidden = new Set<string>();

  constructor(opts: SessionStart) {
    super(opts);
  }

  async start(): Promise<void> {
    // Project settings could carry hooks or allow rules that widen what the agent may do.
    const found = ['.claude/settings.json', '.claude/settings.local.json'].filter((f) => existsSync(path.join(this.opts.cwd, f)));
    if (found.length) throw new Error(`The workspace has ${found.join(' and ')}, which could change what Claude Code is allowed to do. Remove it first.`);
    this.q = query({
      prompt: this.input,
      options: {
        cwd: this.opts.cwd,
        resume: this.opts.resume,
        model: this.opts.model,
        ...(this.opts.effort ? { effort: this.opts.effort as EffortLevel } : {}),
        pathToClaudeCodeExecutable: await claudeExecutable(),
        env: claudeEnv(this.opts.env),
        abortController: this.abort,
        includePartialMessages: true,
        // The workspace's CLAUDE.md and skills only.
        settingSources: ['project'],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: this.opts.instructions },
        mcpServers: { tutordesk: { type: 'stdio', command: this.opts.mcp.command, args: this.opts.mcp.args, env: this.opts.mcp.env } },
        allowedTools: ['mcp__tutordesk'],
        disallowedTools: [...COMMAND_TOOLS, ...NETWORK_TOOLS],
        permissionMode: 'default',
        canUseTool: this.canUseTool,
      },
    });
    void this.pump(this.q);
  }

  private canUseTool: CanUseTool = async (toolName, input) => {
    if (allowed(classify(toolName), this.opts.cwd, target(input))) return { behavior: 'allow', updatedInput: input };
    return { behavior: 'deny', message: DENIED };
  };

  protected async beginTurn(text: string, images: Image[]): Promise<void> {
    if (!this.q) throw new Error('Session not started');
    this.interrupted = false;
    // Messages API content blocks (the SDK's types for them are not installed here).
    const content: unknown[] = [];
    // Pictures small enough go in the message; Claude opens bigger ones from their path with Read.
    for (const i of images.filter((x) => x.bytes <= IMAGE_INPUT_MAX)) {
      content.push({ type: 'image', source: { type: 'base64', media_type: i.mime, data: (await readFile(i.path)).toString('base64') } });
    }
    content.push({ type: 'text', text });
    this.input.push({ type: 'user', message: { role: 'user', content } as MessageParam, parent_tool_use_id: null });
  }

  private async pump(q: Query): Promise<void> {
    try {
      for await (const m of q) this.map(m);
      this.markDead('Claude Code stopped.');
    } catch (e) {
      if (this.interrupted && this.busy) this.endTurn('interrupted');
      this.markDead((e as Error).message);
    }
  }

  private map(m: SDKMessage): void {
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') {
          this.announce(m.session_id, m.model);
          const td = m.mcp_servers.find((s) => s.name === 'tutordesk');
          if (td && td.status !== 'connected') this.emit({ type: 'notice', message: `TutorDesk tools are not available (${td.status}).` });
        }
        return;
      case 'stream_event':
        if (m.event.type === 'content_block_delta' && m.event.delta.type === 'text_delta') this.emit({ type: 'text', delta: m.event.delta.text });
        // Text after a tool call starts a new paragraph.
        if (m.event.type === 'content_block_start' && m.event.content_block.type === 'text' && m.event.index > 0) this.emit({ type: 'text', delta: '\n\n' });
        return;
      case 'assistant':
        if (m.parent_tool_use_id) return;
        for (const block of m.message.content) {
          if (block.type !== 'tool_use') continue;
          // Its task list is the plan the desk shows, not a step.
          if (block.name === 'TodoWrite') {
            const todos = (block.input as { todos?: { content?: string; activeForm?: string; status?: string }[] }).todos ?? [];
            this.emit({ type: 'plan', items: todos.map((x) => ({ text: String(x.content ?? x.activeForm ?? ''), status: x.status === 'completed' ? 'done' : x.status === 'in_progress' ? 'active' : 'pending' })) });
            this.hidden.add(block.id);
            continue;
          }
          this.tools.set(block.id, block.name);
          const kind = classify(block.name);
          this.emit({ type: 'tool', id: block.id, ...splitToolName(block.name), kind: kind === 'network' ? 'other' : kind, input: block.input, status: 'running' });
        }
        return;
      case 'user': {
        const content = m.message.content;
        if (typeof content === 'string') return;
        for (const block of content) {
          if (block.type !== 'tool_result') continue;
          if (this.hidden.delete(block.tool_use_id)) continue;
          const name = this.tools.get(block.tool_use_id) ?? 'tool';
          this.tools.delete(block.tool_use_id);
          const kind = classify(name);
          this.emit({ type: 'tool', id: block.tool_use_id, ...splitToolName(name), kind: kind === 'network' ? 'other' : kind, status: block.is_error === true ? 'error' : 'ok', summary: summarise(block.content) });
        }
        return;
      }
      case 'result':
        if (this.interrupted) this.endTurn('interrupted');
        else if (m.subtype === 'success' && !m.is_error) this.endTurn('completed');
        else this.endTurn('failed', m.subtype === 'success' ? m.result : m.errors.join('; ') || m.subtype);
        return;
      default:
        return;
    }
  }

  async interrupt(): Promise<void> {
    if (!this.busy || !this.q || this.dead) return;
    this.interrupted = true;
    await this.q.interrupt();
  }

  async close(): Promise<void> {
    this.input.end();
    this.abort.abort();
    this.endTurn('interrupted');
    this.markDead('Closed.');
  }
}
