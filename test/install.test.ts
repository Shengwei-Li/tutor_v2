import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findWorkspace } from '../src/home.ts';
import { codexConfig, connectAgents, disconnectAgents, setupWorkspace } from '../src/init.ts';
import { createServer } from '../src/mcp.ts';
import { exists } from '../src/proc.ts';

// A fake home folder, so nothing touches the real agents' settings.
let home: string;
const saved: Record<string, string | undefined> = {};
const VARS = ['HOME', 'USERPROFILE', 'TUTORDESK_HOME', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'CLAUDE_PROJECT_DIR'];
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'td2-home-'));
  for (const v of VARS) saved[v] = process.env[v];
  Object.assign(process.env, { HOME: home, USERPROFILE: home, TUTORDESK_HOME: path.join(home, '.tutordesk') });
  for (const v of ['CODEX_HOME', 'XDG_CONFIG_HOME', 'CLAUDE_PROJECT_DIR']) delete process.env[v];
});
afterEach(async () => {
  for (const v of VARS) if (saved[v] === undefined) delete process.env[v];
  else process.env[v] = saved[v];
  await rm(home, { recursive: true, force: true });
});

describe('connecting the agents', () => {
  it('adds skills and the server to each agent that is set up, and removes only ours', async () => {
    await mkdir(path.join(home, '.codex'));
    await writeFile(codexConfig(), 'model = "gpt-6-luna"\n');
    await writeFile(path.join(home, '.claude.json'), '{"projects":{},"mcpServers":{"other":{"command":"x"}}}');
    await mkdir(path.join(home, '.claude'));
    // No OpenCode on this computer: its config is not created.
    await connectAgents();

    expect(await exists(path.join(home, '.agents/skills/tutordesk/SKILL.md'))).toBe(true);
    expect(await exists(path.join(home, '.claude/skills/tutordesk-lesson-prep/SKILL.md'))).toBe(true);
    expect(await readFile(codexConfig(), 'utf8')).toMatch(/model = "gpt-6-luna"\n\n\[mcp_servers\.tutordesk\]\ncommand = .*\nargs = \[.*"mcp"\]/);
    const claude = JSON.parse(await readFile(path.join(home, '.claude.json'), 'utf8'));
    expect(Object.keys(claude.mcpServers)).toEqual(['other', 'tutordesk']);
    expect(claude.mcpServers.tutordesk.args.at(-1)).toBe('mcp');
    expect(await exists(path.join(home, '.config/opencode/opencode.json'))).toBe(false);

    await disconnectAgents();
    expect(await exists(path.join(home, '.agents/skills/tutordesk'))).toBe(false);
    expect(await readFile(codexConfig(), 'utf8')).toBe('model = "gpt-6-luna"\n');
    expect(Object.keys(JSON.parse(await readFile(path.join(home, '.claude.json'), 'utf8')).mcpServers)).toEqual(['other']);
  });
});

describe('finding the workspace', () => {
  it("uses the agent's project, then the folder, then the one used last", async () => {
    const a = path.join(home, 'A');
    const b = path.join(home, 'B');
    await setupWorkspace(a);
    await setupWorkspace(b);
    expect(await findWorkspace()).toBe(b);
    process.env.CLAUDE_PROJECT_DIR = path.join(a, 'students');
    expect(await findWorkspace()).toBe(a);
    expect(await findWorkspace(path.join(home, 'C'))).toBe(path.join(home, 'C'));
  });
});

describe('MCP server', () => {
  it('asks for a workspace first, then sets one up and opens the desk', async () => {
    const opened: string[] = [];
    const server = createServer('test', { open: (u) => opened.push(u) });
    const client = new Client({ name: 't', version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: r.content[0]!.text, isError: r.isError };
    };

    // Run from a folder that is not a workspace, with none remembered.
    const cwd = process.cwd();
    process.chdir(home);
    try {
      expect(await call('check_workspace')).toMatchObject({ isError: true, text: expect.stringContaining('setup_workspace') });
      const folder = path.join(home, 'Documents', 'TutorDesk');
      expect((await call('setup_workspace', { folder, tutor: 'Lin' })).text).toContain(`Workspace ready at ${folder}`);
      expect((await call('check_workspace')).text).toContain(`Workspace: ${folder}`);
      expect((await call('open_desk', { page: 'wang-yiran' })).text).toMatch(/^Opened the desk in the tutor's browser: http:\/\/127\.0\.0\.1:\d+\/s\/wang-yiran\. /);
      const health = await (await fetch(new URL('/health', opened[0]!))).json();
      expect(health).toEqual({ app: 'tutordesk', root: folder });
      expect(await readFile(path.join(folder, 'tutordesk.yaml'), 'utf8')).toContain('tutor: "Lin"');
    } finally {
      process.chdir(cwd);
      await client.close();
    }
  });
});

describe('OpenCode config with comments', () => {
  it('edits opencode.jsonc in place, keeps a copy of the original, and keeps URLs in strings', async () => {
    const dir = path.join(home, '.config', 'opencode');
    await mkdir(dir, { recursive: true });
    const original = '{\n  // my model\n  "$schema": "https://opencode.ai/config.json",\n  "model": "zen/big", /* trailing */\n}\n';
    await writeFile(path.join(dir, 'opencode.jsonc'), original);
    await connectAgents();
    const j = JSON.parse(await readFile(path.join(dir, 'opencode.jsonc'), 'utf8'));
    expect(j).toMatchObject({ $schema: 'https://opencode.ai/config.json', model: 'zen/big', mcp: { tutordesk: { type: 'local', enabled: true } } });
    expect(await readFile(path.join(dir, 'opencode.jsonc.bak'), 'utf8')).toBe(original);
    expect(await exists(path.join(dir, 'opencode.json'))).toBe(false);
  });
});

describe('never moving into a folder in use', () => {
  it('refuses a TutorDesk 1 workspace', async () => {
    const v1 = path.join(home, 'v1');
    await mkdir(path.join(v1, 'students'), { recursive: true });
    await writeFile(path.join(v1, 'workspace.json'), '{}');
    await expect(setupWorkspace(v1)).rejects.toThrow(/TutorDesk 1 workspace/);
    expect(await exists(path.join(v1, 'tutordesk.yaml'))).toBe(false);
  });
});

describe('Claude Code through its own command', () => {
  it('replaces the entry with claude mcp, and leaves ~/.claude.json to Claude Code', async () => {
    const log = path.join(home, 'claude.log');
    process.env.FAKE_CLAUDE_LOG = log;
    process.env.TUTORDESK_CLAUDE_CLI = JSON.stringify([process.execPath, path.resolve('test/fixtures/fake-claude.mjs')]);
    process.env.TUTORDESK_TECTONIC = 'C:/tex';
    try {
      await writeFile(path.join(home, '.claude.json'), '{"projects":{}}');
      await connectAgents();
      await disconnectAgents();
      const calls = (await readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as string[]);
      expect(calls[0]).toEqual(['mcp', 'remove', '--scope', 'user', 'tutordesk']);
      expect(calls[1]!.slice(0, 7)).toEqual(['mcp', 'add', '--scope', 'user', 'tutordesk', '-e', 'TUTORDESK_TECTONIC=C:/tex']);
      expect(calls[1]!.slice(-1)).toEqual(['mcp']);
      expect(calls[2]).toEqual(['mcp', 'remove', '--scope', 'user', 'tutordesk']);
      expect(await readFile(path.join(home, '.claude.json'), 'utf8')).toBe('{"projects":{}}');
    } finally {
      process.env.TUTORDESK_CLAUDE_CLI = '';
      delete process.env.TUTORDESK_TECTONIC;
    }
  });
});
