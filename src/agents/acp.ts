import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ContentBlock, InitializeResponse, LoadSessionResponse, NewSessionResponse, PermissionOption, PromptResponse, RequestPermissionRequest, RequestPermissionResponse, SessionConfigOption, SessionNotification, ToolKind } from '@agentclientprotocol/sdk';
import { program, stopProcess, type Program } from '../proc.ts';
import { JsonRpcPeer, RpcError } from './jsonrpc.ts';
import { BaseSession, agentEnv, allowed, splitToolName, type ActionKind } from './session-base.ts';
import type { SessionStart } from './types.ts';

/**
 * The tool's kind decides first: a title is free text the agent can shape, so a shell command whose
 * title happens to start with "tutordesk_" must still count as a command.
 */
export function classify(kind: ToolKind | null | undefined, title: string): ActionKind {
  switch (kind) {
    case 'read':
    case 'search':
    case 'think':
      return 'read';
    case 'edit':
    case 'delete':
    case 'move':
      return 'edit';
    case 'execute':
      return 'command';
    case 'fetch':
      return 'network';
    default:
      return /^tutordesk_[a-z_]+$/.test(title) || /^mcp__tutordesk__[a-z_]+$/.test(title) ? 'toolbox' : 'other';
  }
}

/** OpenCode's own permission rules for this conversation: edit files, no commands, no web. */
export const OPENCODE_PERMISSIONS = JSON.stringify({ permission: { edit: 'allow', bash: 'deny', webfetch: 'deny' } });

/**
 * OpenCode over the Agent Client Protocol on stdio. Plain JSON-RPC, so only the protocol's types are
 * needed. The tutordesk tools are passed with the session; OpenCode's own config is not changed.
 */
export class AcpSession extends BaseSession {
  readonly agent = 'opencode' as const;
  private peer: JsonRpcPeer | undefined;
  private child: ChildProcessWithoutNullStreams | undefined;
  /** session/load replays history as updates; those are not part of the current turn. */
  private loading = false;
  private toolTitles = new Map<string, string>();
  private sentFirst = false;
  /** The agent loaded an earlier session (it may not support loading, and then starts afresh). */
  private resumed = false;

  private readonly extra: { executable?: Program };

  constructor(opts: SessionStart, extra: { executable?: Program } = {}) {
    super(opts);
    this.extra = extra;
  }

  async start(): Promise<void> {
    const exe = this.extra.executable ?? (await program('opencode'));
    if (!exe) throw new Error('OpenCode is not installed.');
    const env = { ...agentEnv(this.opts.env), OPENCODE_CONFIG_CONTENT: OPENCODE_PERMISSIONS };
    const child = spawn(exe.command, [...exe.prefixArgs, ...(this.extra.executable ? [] : ['acp'])], { cwd: this.opts.cwd, env, windowsHide: true });
    this.child = child;
    try {
      await this.handshake(child);
    } catch (e) {
      await stopProcess(child);
      throw e;
    }
  }

  private async handshake(child: ChildProcessWithoutNullStreams): Promise<void> {
    const peer = new JsonRpcPeer(child, { header: true });
    this.peer = peer;
    peer.onNotification = (method, params) => {
      if (method === 'session/update') this.onUpdate(params as SessionNotification);
    };
    peer.onRequest = (method, params) => this.onAgentRequest(method, params);
    peer.onClose = (reason) => this.markDead(`OpenCode ${reason}`);

    const caps = await peer.request<InitializeResponse>('initialize', {
      protocolVersion: 1,
      // We do not offer our file system or terminal: the agent works in the workspace itself.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'tutordesk', title: 'TutorDesk', version: '2' },
    });
    const mcpServers = [{ name: 'tutordesk', command: this.opts.mcp.command, args: this.opts.mcp.args, env: Object.entries(this.opts.mcp.env ?? {}).map(([name, value]) => ({ name, value })) }];
    let options: SessionConfigOption[] | undefined;
    if (this.opts.resume && caps.agentCapabilities?.loadSession) {
      this.loading = true;
      try {
        const r = await peer.request<LoadSessionResponse | null>('session/load', { sessionId: this.opts.resume, cwd: this.opts.cwd, mcpServers });
        options = r?.configOptions ?? undefined;
      } finally {
        this.loading = false;
      }
      this.nativeId = this.opts.resume;
      this.resumed = true;
    } else {
      const r = await peer.request<NewSessionResponse>('session/new', { cwd: this.opts.cwd, mcpServers });
      this.nativeId = r.sessionId;
      options = r.configOptions ?? undefined;
    }
    // ACP has no model parameter: the agent offers it as a session config option of category "model".
    if (this.opts.model) {
      const option = options?.find((o) => o.category === 'model');
      if (!(option?.type === 'select' && option.currentValue === this.opts.model)) {
        await peer.request('session/set_config_option', { sessionId: this.nativeId, configId: option?.id ?? 'model', value: this.opts.model });
      }
    }
  }

  protected async beginTurn(text: string): Promise<void> {
    if (!this.peer || !this.nativeId) throw new Error('Session not started');
    const prompt: ContentBlock[] = [];
    // ACP has no system prompt; the conversation's instructions ride on its first message.
    if (this.opts.instructions && !this.resumed && !this.sentFirst) prompt.push({ type: 'text', text: `${this.opts.instructions}\n\n---\n\n` });
    this.sentFirst = true;
    prompt.push({ type: 'text', text });
    const r = await this.peer.request<PromptResponse>('session/prompt', { sessionId: this.nativeId, prompt });
    if (r.stopReason === 'cancelled') this.endTurn('interrupted');
    else if (r.stopReason === 'refusal') this.endTurn('failed', 'The agent refused this request.');
    else this.endTurn('completed', r.stopReason === 'end_turn' ? undefined : `Stopped: ${r.stopReason}`);
  }

  private onUpdate(n: SessionNotification): void {
    if (this.loading || n.sessionId !== this.nativeId) return;
    const u = n.update;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        if (u.content.type === 'text') this.emit({ type: 'text', delta: u.content.text });
        return;
      case 'tool_call':
        this.toolTitles.set(u.toolCallId, u.title);
        this.emit({ type: 'tool', id: u.toolCallId, ...splitToolName(u.title), input: u.rawInput, status: u.status === 'failed' ? 'error' : u.status === 'completed' ? 'ok' : 'running' });
        return;
      case 'tool_call_update': {
        if (u.status !== 'completed' && u.status !== 'failed') return;
        const raw = u.title ?? this.toolTitles.get(u.toolCallId) ?? 'tool';
        const text = (u.content ?? []).map((c) => (c.type === 'content' && c.content.type === 'text' ? c.content.text : '')).join(' ').slice(0, 400);
        this.emit({ type: 'tool', id: u.toolCallId, ...splitToolName(raw), status: u.status === 'failed' ? 'error' : 'ok', summary: text || undefined });
        return;
      }
      default:
        return;
    }
  }

  private async onAgentRequest(method: string, params: unknown): Promise<unknown> {
    if (method !== 'session/request_permission') throw new RpcError(-32601, `TutorDesk does not provide ${method}`);
    const req = params as RequestPermissionRequest;
    const kind = classify(req.toolCall.kind, req.toolCall.title ?? '');
    // Where the request names the files, each must pass; without them OpenCode's own rules (above)
    // keep edits to its folder, and the desk puts back protected files after the turn.
    const paths = (req.toolCall.locations ?? []).map((l) => l.path).filter(Boolean);
    const ok = kind === 'read' || kind === 'edit' ? paths.every((p) => allowed(kind, this.opts.cwd, p)) : allowed(kind, this.opts.cwd);
    const pick = (kinds: PermissionOption['kind'][]) => req.options.find((o) => kinds.includes(o.kind));
    const option = ok ? pick(['allow_once', 'allow_always']) : pick(['reject_once', 'reject_always']);
    const response: RequestPermissionResponse = option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } };
    return response;
  }

  async interrupt(): Promise<void> {
    if (!this.peer || !this.nativeId || !this.busy) return;
    this.peer.notify('session/cancel', { sessionId: this.nativeId });
  }

  async close(): Promise<void> {
    this.endTurn('interrupted');
    this.markDead('Closed.');
    if (this.child) await stopProcess(this.child);
  }
}
