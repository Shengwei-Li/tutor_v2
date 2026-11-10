/**
 * Conversations with a coding agent already installed and signed in on this computer. One interface
 * for Claude Code, Codex and ACP agents (OpenCode). TutorDesk starts the agent's own program, so the
 * model, the sign-in and the bill stay the agent's.
 */
export type AgentId = 'claude-code' | 'codex' | 'opencode';

/** How the agent starts the tutordesk MCP server for this conversation (nothing is installed into the agent). */
export interface McpLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface SessionStart {
  /** The workspace: the agent's working directory, and the only place it may write. */
  cwd: string;
  /** Native session or thread id to continue. */
  resume?: string;
  /** Omit to use the agent's own default model. */
  model?: string;
  /** The agent's own name for how hard to think (Codex "low", Claude "high"…); omit for its default. */
  effort?: string;
  /** Added to the agent's instructions: where it is and which student this conversation is about. */
  instructions?: string;
  mcp: McpLaunch;
  env?: NodeJS.ProcessEnv;
}

/** A step of the agent's own task list. */
export interface PlanItem {
  text: string;
  status: 'pending' | 'active' | 'done';
}

/** What a tool call does, as far as the tutor cares: reads, writes, a tutordesk tool, or something else. */
export type ToolKind = 'read' | 'edit' | 'toolbox' | 'command' | 'other';

export type AgentEvent =
  | { type: 'session'; nativeId: string; model?: string }
  | { type: 'text'; delta: string }
  | { type: 'tool'; id: string; server?: string; name: string; kind?: ToolKind; input?: unknown; status: 'running' | 'ok' | 'error'; summary?: string }
  /** The agent's task list for this turn, whole each time (it replaces the last one). */
  | { type: 'plan'; items: PlanItem[] }
  | { type: 'notice'; message: string }
  | { type: 'turn_end'; status: 'completed' | 'interrupted' | 'failed'; error?: string };

export interface AgentSession {
  readonly agent: AgentId;
  /** Known after start (Codex, ACP) or after the first turn begins (Claude Code). */
  readonly nativeId: string | null;
  /** The agent process has gone; a new session is needed for the next message. */
  readonly dead: boolean;
  /** A turn has completed in this session (so the native id it resumed is valid). */
  readonly proven: boolean;
  start(): Promise<void>;
  /** One turn. Events stream until a `turn_end`; only one turn runs at a time. Images go as the agent's own image input where it takes one. */
  send(text: string, images?: Image[]): AsyncIterable<AgentEvent>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

/** A picture the tutor attached, saved in the workspace. The message text names it too. */
export interface Image {
  /** Absolute path. */
  path: string;
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  bytes: number;
}

/** Largest picture sent as image input; bigger ones the agent opens from the path itself. */
export const IMAGE_INPUT_MAX = 3_750_000;

export interface AgentStatus {
  id: AgentId;
  label: string;
  installed: boolean;
  /** undefined when the agent gives no way to check without starting a session. */
  signedIn?: boolean;
  version?: string;
  /** The next step for the tutor when something is missing. */
  hint?: string;
}
