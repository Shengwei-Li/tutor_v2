import { insideRoot, protectedPart } from '../files.ts';
import type { AgentEvent, AgentId, AgentSession, SessionStart } from './types.ts';

/** A push-based async iterable: producers push, one consumer iterates until end(). */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private done = false;

  push(item: T): void {
    if (this.done) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  end(): void {
    this.done = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/**
 * The one permission rule, for every agent: read and write inside the workspace, use the tutordesk
 * tools, nothing else. No commands (where the agent lets us say so), no network: student data stays here.
 */
export type ActionKind = 'read' | 'edit' | 'toolbox' | 'command' | 'network' | 'other';

export function allowed(kind: ActionKind, root: string, target?: string): boolean {
  if (kind === 'toolbox') return true;
  if (kind === 'read') return target === undefined || insideRoot(root, target);
  if (kind === 'edit') return target !== undefined && insideRoot(root, target) && !protectedPart(root, target);
  return false;
}

export { insideRoot };

export const DENIED = 'Not allowed here: work only inside the workspace folder, with file reads and edits and the tutordesk tools. AGENTS.md, tutordesk.yaml, .agents/, .claude/ and .tutordesk/ are read-only.';

/** Tool names arrive as mcp__tutordesk__export_pdf (Claude), tutordesk_export_pdf (OpenCode) or server + tool (Codex). */
export function splitToolName(raw: string): { server?: string; name: string } {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(raw);
  if (mcp) return { server: mcp[1], name: mcp[2]! };
  const td = /^tutordesk[_.](.+)$/.exec(raw);
  if (td) return { server: 'tutordesk', name: td[1]! };
  return { name: raw };
}

/** The environment for an agent process: the user's own, without API keys that would bypass their sign-in. */
export function agentEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.ANTHROPIC_API_KEY;
  return env;
}

/**
 * Turn bookkeeping shared by every adapter. Subclasses start the agent, translate its protocol into
 * AgentEvents with emit(), and call endTurn() when the agent finishes a turn.
 */
export abstract class BaseSession implements AgentSession {
  abstract readonly agent: AgentId;
  nativeId: string | null;
  private turn: AsyncQueue<AgentEvent> | null = null;
  private announced = false;
  private everCompleted = false;
  private isDead = false;
  protected model: string | undefined;

  protected readonly opts: SessionStart;

  constructor(opts: SessionStart) {
    this.opts = opts;
    this.nativeId = opts.resume ?? null;
  }

  abstract start(): Promise<void>;
  protected abstract beginTurn(text: string): Promise<void>;
  abstract interrupt(): Promise<void>;
  abstract close(): Promise<void>;

  get busy(): boolean {
    return this.turn !== null;
  }

  get dead(): boolean {
    return this.isDead;
  }

  get proven(): boolean {
    return this.everCompleted;
  }

  /** Subclasses call this when the agent can no longer answer; the current turn fails. */
  protected markDead(reason: string): void {
    this.isDead = true;
    this.endTurn('failed', reason);
  }

  send(text: string): AsyncIterable<AgentEvent> {
    if (this.isDead) throw new Error('The agent has stopped; send the message again to restart it.');
    if (this.turn) throw new Error('The agent is still working on the previous message.');
    const q = new AsyncQueue<AgentEvent>();
    this.turn = q;
    if (this.nativeId && !this.announced) this.announce(this.nativeId);
    this.beginTurn(text).catch((e: unknown) => this.endTurn('failed', (e as Error).message));
    return q;
  }

  /** Record the native session id and tell the caller once. */
  protected announce(nativeId: string, model?: string): void {
    this.nativeId = nativeId;
    if (model) this.model = model;
    if (this.announced || !this.turn) return;
    this.announced = true;
    this.emit({ type: 'session', nativeId, model: this.model });
  }

  protected emit(e: AgentEvent): void {
    this.turn?.push(e);
  }

  protected endTurn(status: 'completed' | 'interrupted' | 'failed', error?: string): void {
    const q = this.turn;
    if (!q) return;
    this.turn = null;
    if (status === 'completed') this.everCompleted = true;
    q.push({ type: 'turn_end', status, error });
    q.end();
  }
}
