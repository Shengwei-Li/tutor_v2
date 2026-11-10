import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { program, stopProcess, type Program } from '../proc.ts';
import { JsonRpcPeer } from './jsonrpc.ts';
import { BaseSession, agentEnv } from './session-base.ts';
import type { SessionStart } from './types.ts';

/**
 * The slice of the Codex app-server protocol TutorDesk uses (v2 thread API). The full, version-exact
 * types come from `codex app-server generate-ts --out <dir>`; checked against codex-cli 0.160.
 */
type CodexItem =
  | { type: 'agentMessage'; id: string; text: string }
  | { type: 'mcpToolCall'; id: string; server: string; tool: string; status: 'inProgress' | 'completed' | 'failed'; arguments: unknown; result?: unknown; error?: { message?: string } | null }
  | { type: 'commandExecution'; id: string; command: string; aggregatedOutput?: string | null; exitCode?: number | null }
  | { type: 'fileChange'; id: string; changes: { path: string }[]; status: string }
  | { type: string; id: string };

interface Turn {
  id: string;
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  error: { message: string } | null;
}

function resultText(result: unknown): string | undefined {
  const content = (result as { content?: { text?: string }[] } | undefined)?.content;
  return content?.map((c) => c.text ?? '').join(' ').slice(0, 400) || undefined;
}

/**
 * Codex through `codex app-server`: one process per conversation, JSON-RPC over stdio (as T3 Code does).
 * Its own sandbox keeps writes inside the workspace and the network off, so nothing needs approving.
 */
export class CodexSession extends BaseSession {
  readonly agent = 'codex' as const;
  private peer: JsonRpcPeer | undefined;
  private child: ChildProcessWithoutNullStreams | undefined;
  private turnId: string | null = null;
  private streamed = new Set<string>();
  /** Codex splits a reply into several messages (a preamble, then the answer); keep them apart. */
  private lastTextItem: string | null = null;
  private lastError: string | undefined;

  private readonly extra: { executable?: Program };

  constructor(opts: SessionStart, extra: { executable?: Program } = {}) {
    super(opts);
    this.extra = extra;
  }

  async start(): Promise<void> {
    const exe = this.extra.executable ?? (await program('codex'));
    if (!exe) throw new Error('Codex is not installed.');
    const child = spawn(exe.command, [...exe.prefixArgs, 'app-server'], { cwd: this.opts.cwd, env: agentEnv(this.opts.env), windowsHide: true });
    this.child = child;
    try {
      await this.handshake(child);
    } catch (e) {
      await stopProcess(child);
      throw e;
    }
  }

  private async handshake(child: ChildProcessWithoutNullStreams): Promise<void> {
    const peer = new JsonRpcPeer(child, { header: false });
    this.peer = peer;
    peer.onNotification = (method, params) => this.onNotification(method, params);
    peer.onRequest = (method, params) => this.onServerRequest(method, params as Record<string, unknown>);
    peer.onClose = (reason) => this.markDead(`Codex ${reason}`);

    await peer.request('initialize', { clientInfo: { name: 'tutordesk', title: 'TutorDesk', version: '2' }, capabilities: null });
    peer.notify('initialized');
    const params = {
      cwd: this.opts.cwd,
      model: this.opts.model ?? null,
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      developerInstructions: this.opts.instructions ?? null,
      // The tutordesk tools exist for this conversation only; the tutor's own Codex setup is not changed.
      config: { mcp_servers: { tutordesk: { command: this.opts.mcp.command, args: this.opts.mcp.args, env: this.opts.mcp.env ?? {}, tool_timeout_sec: 300 } } },
    };
    const r = this.opts.resume
      ? await peer.request<{ thread: { id: string }; model: string }>('thread/resume', { threadId: this.opts.resume, ...params, excludeTurns: true })
      : await peer.request<{ thread: { id: string }; model: string }>('thread/start', params);
    this.nativeId = r.thread.id;
    this.model = r.model;
    // The model in the tutor's Codex config may be one this sign-in cannot use (it then fails every
    // turn). If Codex does not list it, use the account's default from the next turn on.
    if (!this.opts.model) {
      const list = await peer.request<{ data: { model: string; isDefault: boolean }[] }>('model/list', {}).catch(() => ({ data: [] }));
      if (list.data.length && !list.data.some((m) => m.model === r.model)) {
        this.model = this.fallbackModel = (list.data.find((m) => m.isDefault) ?? list.data[0]!).model;
      }
    }
  }
  private fallbackModel: string | undefined;

  protected async beginTurn(text: string): Promise<void> {
    if (!this.peer || !this.nativeId) throw new Error('Session not started');
    this.lastError = undefined;
    this.streamed.clear();
    this.lastTextItem = null;
    const r = await this.peer.request<{ turn: Turn }>('turn/start', { threadId: this.nativeId, input: [{ type: 'text', text, text_elements: [] }], ...(this.fallbackModel ? { model: this.fallbackModel } : {}) });
    this.turnId = r.turn.id;
  }

  private onNotification(method: string, params: unknown): void {
    const p = params as Record<string, unknown>;
    switch (method) {
      case 'item/agentMessage/delta':
        this.streamed.add(String(p.itemId));
        this.text(String(p.itemId), String(p.delta ?? ''));
        return;
      case 'item/started':
        this.itemStarted(p.item as CodexItem);
        return;
      case 'item/completed':
        this.itemCompleted(p.item as CodexItem);
        return;
      case 'error': {
        const e = p as { error?: { message?: string }; willRetry?: boolean };
        if (!e.willRetry) this.lastError = e.error?.message;
        return;
      }
      case 'turn/completed': {
        const turn = p.turn as Turn;
        this.turnId = null;
        this.endTurn(turn.status === 'interrupted' ? 'interrupted' : turn.status === 'failed' ? 'failed' : 'completed', turn.error?.message ?? (turn.status === 'failed' ? this.lastError : undefined));
        return;
      }
      default:
        return;
    }
  }

  private text(itemId: string, delta: string): void {
    if (this.lastTextItem !== null && this.lastTextItem !== itemId) this.emit({ type: 'text', delta: '\n\n' });
    this.lastTextItem = itemId;
    this.emit({ type: 'text', delta });
  }

  private itemStarted(item: CodexItem): void {
    if (item.type === 'mcpToolCall') {
      const it = item as Extract<CodexItem, { type: 'mcpToolCall' }>;
      this.emit({ type: 'tool', id: it.id, server: it.server, name: it.tool, input: it.arguments, status: 'running' });
    } else if (item.type === 'commandExecution') {
      const it = item as Extract<CodexItem, { type: 'commandExecution' }>;
      this.emit({ type: 'tool', id: it.id, name: 'shell', input: { command: it.command }, status: 'running' });
    }
  }

  private itemCompleted(item: CodexItem): void {
    switch (item.type) {
      case 'agentMessage': {
        const it = item as Extract<CodexItem, { type: 'agentMessage' }>;
        // Older servers send the message whole, without deltas.
        if (!this.streamed.has(it.id) && it.text) this.text(it.id, it.text);
        return;
      }
      case 'mcpToolCall': {
        const it = item as Extract<CodexItem, { type: 'mcpToolCall' }>;
        const isError = it.status === 'failed' || (it.result as { isError?: boolean } | undefined)?.isError === true;
        this.emit({ type: 'tool', id: it.id, server: it.server, name: it.tool, status: isError ? 'error' : 'ok', summary: it.error?.message ?? resultText(it.result) });
        return;
      }
      case 'commandExecution': {
        const it = item as Extract<CodexItem, { type: 'commandExecution' }>;
        this.emit({ type: 'tool', id: it.id, name: 'shell', status: it.exitCode === 0 ? 'ok' : 'error' });
        return;
      }
      case 'fileChange': {
        const it = item as Extract<CodexItem, { type: 'fileChange' }>;
        this.emit({ type: 'tool', id: it.id, name: 'edit', input: { path: it.changes.map((c) => c.path).join(', ') }, status: it.status === 'completed' ? 'ok' : 'error' });
        return;
      }
      default:
        return;
    }
  }

  /** With approvalPolicy "never" Codex does not ask; anything it asks anyway is declined. */
  private async onServerRequest(method: string, p: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        return { decision: 'decline' };
      case 'item/permissions/requestApproval':
        return { permissions: {}, scope: 'turn' };
      case 'mcpServer/elicitation/request':
        // Only our own tools: the tutor's other Codex servers are not for this conversation.
        return { action: p?.serverName === 'tutordesk' ? 'accept' : 'decline', content: null, _meta: null };
      case 'item/tool/requestUserInput':
        return { answers: {} };
      case 'execCommandApproval':
      case 'applyPatchApproval':
        return { decision: 'denied' };
      default:
        throw new Error(`TutorDesk does not handle ${method}`);
    }
  }

  async interrupt(): Promise<void> {
    if (!this.peer || !this.nativeId || !this.turnId) return;
    await this.peer.request('turn/interrupt', { threadId: this.nativeId, turnId: this.turnId });
  }

  async close(): Promise<void> {
    this.endTurn('interrupted');
    this.markDead('Closed.');
    if (this.child) await stopProcess(this.child);
  }
}
