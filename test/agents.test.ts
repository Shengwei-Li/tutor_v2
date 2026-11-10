import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AcpSession, classify } from '../src/agents/acp.ts';
import { CodexSession } from '../src/agents/codex.ts';
import { allowed, insideRoot, splitToolName } from '../src/agents/session-base.ts';
import type { AgentEvent, AgentSession, SessionStart } from '../src/agents/types.ts';

// A scripted stand-in for `codex app-server` and an ACP agent; FAKE_LOG receives every message it reads.
const FAKE = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url));
const fake = (flavour: string) => ({ executable: { command: process.execPath, prefixArgs: [FAKE, flavour] } });

let tmp: string;
let log: string;
const sessions: AgentSession[] = [];
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'td2-agents-'));
  log = path.join(tmp, 'agent.log');
});
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  await rm(tmp, { recursive: true, force: true });
});

const opts = (extra: Partial<SessionStart> = {}): SessionStart => ({ cwd: tmp, instructions: 'Student Mina.', mcp: { command: 'tutordesk', args: ['mcp', '--workspace', tmp] }, env: { FAKE_LOG: log }, ...extra });
const sent = async () => (await readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { method?: string; params?: Record<string, unknown> });
async function collect(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe('the permission rule', () => {
  it('lets agents read and write inside the workspace and use our tools, nothing else', () => {
    expect(allowed('toolbox', tmp)).toBe(true);
    expect(allowed('edit', tmp, 'students/mina/profile.md')).toBe(true);
    expect(allowed('edit', tmp, '../outside.md')).toBe(false);
    expect(allowed('read', tmp, path.join(os.homedir(), '.ssh', 'id_rsa'))).toBe(false);
    expect(allowed('command', tmp)).toBe(false);
    expect(allowed('network', tmp)).toBe(false);
    // The agent's own instructions and the desk's records are read-only.
    for (const f of ['AGENTS.md', 'tutordesk.yaml', '.agents/skills/x/SKILL.md', '.claude/settings.json', '.tutordesk/threads/mina.json']) {
      expect(allowed('edit', tmp, f), f).toBe(false);
      expect(allowed('read', tmp, f), f).toBe(true);
    }
    expect(allowed('edit', tmp, path.join(tmp, 'students', '..', '.agents', 'x'))).toBe(false);
    expect(allowed('edit', tmp)).toBe(false);
    expect(splitToolName('mcp__tutordesk__export_pdf')).toEqual({ server: 'tutordesk', name: 'export_pdf' });
    // A title is free text: a command titled like one of our tools is still a command.
    expect(classify('execute', 'tutordesk_export_pdf')).toBe('command');
  });
});

describe('paths', () => {
  it('follows links out of the workspace, ignores letter case on Windows, and refuses odd Windows paths', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'td2-outside-'));
    try {
      await mkdir(path.join(tmp, 'students'), { recursive: true });
      // A junction needs no special rights on Windows; elsewhere it is a plain directory link.
      await symlink(outside, path.join(tmp, 'students', 'link'), 'junction');
      expect(insideRoot(tmp, 'students/link/secret.md')).toBe(false);
      expect(allowed('edit', tmp, path.join(tmp, 'students', 'link', 'new', 'file.md'))).toBe(false);
      expect(insideRoot(tmp, 'students/../students/mina.md')).toBe(true);
      expect(insideRoot(tmp, 'students/../../x.md')).toBe(false);
      if (process.platform === 'win32') {
        expect(insideRoot(tmp, tmp.toUpperCase() + '\\students\\a.md')).toBe(true);
        expect(allowed('edit', tmp, tmp.toUpperCase() + '\\AGENTS.MD')).toBe(false);
        expect(insideRoot(tmp, 'students\\a.md:hidden')).toBe(false);
        expect(insideRoot(tmp, '\\\\?\\' + tmp + '\\a.md')).toBe(false);
        expect(insideRoot(tmp, '\\\\server\\share\\a.md')).toBe(false);
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('Codex', () => {
  it('starts sandboxed to the workspace with our tools for this conversation only, and maps a turn', async () => {
    const s = new CodexSession(opts({ model: 'gpt-deep' }), fake('codex'));
    sessions.push(s);
    await s.start();
    const start = (await sent()).find((m) => m.method === 'thread/start')!.params!;
    expect(start).toMatchObject({ sandbox: 'workspace-write', approvalPolicy: 'never', developerInstructions: 'Student Mina.', model: 'gpt-deep' });
    expect((start.config as { mcp_servers: { tutordesk: { args: string[] } } }).mcp_servers.tutordesk.args).toEqual(['mcp', '--workspace', tmp]);

    const events = await collect(s.send('Plan the lesson'));
    expect(events[0]).toEqual({ type: 'session', nativeId: 'thr-1', model: 'gpt-fake' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool', server: 'tutordesk', name: 'get_student_context', status: 'ok', summary: 'Mina Park, IELTS' }));
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('Hello tutor\n\nDone.');
    expect(events.at(-1)).toEqual({ type: 'turn_end', status: 'completed', error: undefined });
  });

  it('declines anything Codex asks to approve, resumes threads, and stops on request', async () => {
    const s = new CodexSession(opts({ resume: 'thr-9' }), fake('codex'));
    sessions.push(s);
    await s.start();
    expect(s.nativeId).toBe('thr-9');
    expect(await collect(s.send('approve this'))).toContainEqual({ type: 'text', delta: 'decision=decline' });
    const done = collect(s.send('hang'));
    await new Promise((r) => setTimeout(r, 100));
    await s.interrupt();
    expect((await done).at(-1)).toMatchObject({ type: 'turn_end', status: 'interrupted' });
  });

  it('fails the turn and reports dead when the process exits', async () => {
    const s = new CodexSession(opts(), fake('codex'));
    sessions.push(s);
    await s.start();
    expect((await collect(s.send('crash'))).at(-1)).toMatchObject({ type: 'turn_end', status: 'failed' });
    expect(s.dead).toBe(true);
  });
});

describe('OpenCode (ACP)', () => {
  it('passes our tools with the session, sends instructions once, sets the model, and maps updates', async () => {
    const s = new AcpSession(opts({ model: 'zen/big' }), fake('acp'));
    sessions.push(s);
    await s.start();
    const log1 = await sent();
    expect(log1.find((m) => m.method === 'session/new')!.params).toMatchObject({ cwd: tmp, mcpServers: [{ name: 'tutordesk', command: 'tutordesk' }] });
    expect(log1.find((m) => m.method === 'session/set_config_option')!.params).toEqual({ sessionId: 'ses-1', configId: 'model', value: 'zen/big' });

    const events = await collect(s.send('Plan it'));
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool', server: 'tutordesk', name: 'save_plan', status: 'ok', summary: 'Saved plan card' }));
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', status: 'completed' });
    await collect(s.send('Again'));
    const prompts = (await sent()).filter((m) => m.method === 'session/prompt').map((m) => m.params!.prompt as { text: string }[]);
    expect(prompts[0]![0]!.text).toContain('Student Mina.');
    expect(prompts[1]).toHaveLength(1);
  });

  it('allows an edit the agent asks about, and ignores replayed history when loading', async () => {
    const s = new AcpSession(opts({ resume: 'ses-7' }), fake('acp'));
    sessions.push(s);
    await s.start();
    const events = await collect(s.send('approve'));
    expect(events).toContainEqual({ type: 'text', delta: 'picked=a1' });
    expect(events.some((e) => e.type === 'text' && e.delta === 'old history')).toBe(false);
  });

  it('maps its plan, and sends pictures as image blocks only when it takes them', async () => {
    const pic = path.join(tmp, 'essay.png');
    await writeFile(pic, 'png bytes');
    const image = { path: pic, mime: 'image/png' as const, bytes: 9 };
    const plain = new AcpSession(opts(), fake('acp'));
    sessions.push(plain);
    await plain.start();
    const events = await collect(plain.send('plan please', [image]));
    expect(events).toContainEqual({ type: 'plan', items: [{ text: 'Read the essay', status: 'active' }, { text: 'Mark it', status: 'pending' }] });
    const seeing = new AcpSession(opts({ env: { FAKE_LOG: log, FAKE_ACP_IMAGE: '1' } }), fake('acp'));
    sessions.push(seeing);
    await seeing.start();
    await collect(seeing.send('Mark it', [image]));
    const prompts = (await sent()).filter((m) => m.method === 'session/prompt').map((m) => (m.params!.prompt as { type: string }[]).map((b) => b.type));
    expect(prompts).toEqual([
      ['text', 'text'],
      ['text', 'image', 'text'],
    ]);
  });
});

describe('Codex model fallback', () => {
  it("uses the account's default when the configured model is not one Codex lists", async () => {
    const s = new CodexSession(opts(), fake('codex'));
    sessions.push(s);
    await s.start();
    const events = await collect(s.send('Plan the lesson'));
    expect(events[0]).toMatchObject({ type: 'session', model: 'gpt-fast' });
    expect((await sent()).find((m) => m.method === 'turn/start')!.params).toMatchObject({ model: 'gpt-fast' });
  });

  it('maps its plan updates, and a stop pressed before Codex names the turn still stops it', async () => {
    const s = new CodexSession(opts(), fake('codex'));
    sessions.push(s);
    await s.start();
    const events = await collect(s.send('plan please'));
    expect(events.filter((e) => e.type === 'plan').at(-1)).toEqual({ type: 'plan', items: [{ text: 'Read the profile', status: 'done' }, { text: 'Write the plan', status: 'done' }] });
    const turn = collect(s.send('hang'));
    await s.interrupt();
    expect((await turn).at(-1)).toMatchObject({ type: 'turn_end', status: 'interrupted' });
  });
});
