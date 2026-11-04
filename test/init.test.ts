import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexConfig, init } from '../src/init.ts';
import { exists } from '../src/proc.ts';

let root: string;
let home: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'td2-init-'));
  home = await mkdtemp(path.join(os.tmpdir(), 'td2-codex-'));
  process.env.CODEX_HOME = home;
});
afterEach(async () => {
  delete process.env.CODEX_HOME;
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe('init', () => {
  it('writes the agent kit and registers the MCP server with every agent', async () => {
    await writeFile(path.join(root, 'opencode.json'), '{"model":"zen/big"}');
    await writeFile(codexConfig(), 'model = "gpt-6-luna"\n\n[mcp_servers.tutordesk]\ncommand = "old"\nargs = []\n\n[mcp_servers.other]\ncommand = "x"\n');
    await init(root, { studio: 'Northbridge' });
    await init(root);

    expect(await readFile(path.join(root, 'tutordesk.yaml'), 'utf8')).toContain('studio: "Northbridge"');
    expect(await exists(path.join(root, '.agents/skills/lesson-prep/SKILL.md'))).toBe(true);
    expect(await exists(path.join(root, '.claude/skills/lesson-materials/examples/handout.tex'))).toBe(true);

    const oc = JSON.parse(await readFile(path.join(root, 'opencode.json'), 'utf8'));
    expect(oc.model).toBe('zen/big');
    expect(oc.mcp.tutordesk.command.slice(-3)).toEqual(['mcp', '--workspace', root]);
    expect(JSON.parse(await readFile(path.join(root, '.mcp.json'), 'utf8')).mcpServers.tutordesk.args.at(-1)).toBe(root);

    const codex = await readFile(codexConfig(), 'utf8');
    expect(codex.match(/\[mcp_servers\.tutordesk\]/g)).toHaveLength(1);
    expect(codex).toContain('model = "gpt-6-luna"');
    expect(codex).toContain('[mcp_servers.other]\ncommand = "x"');
    expect(codex).not.toContain('"old"');
  });

  it('refuses to overwrite a config file it cannot read', async () => {
    await writeFile(path.join(root, 'opencode.json'), '{ broken');
    await expect(init(root, { codex: false })).rejects.toThrow(/opencode.json is not valid JSON/);
  });
});
