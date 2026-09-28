import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import '../src/adapters/spec/index.js';
import { CodexRunner } from '../src/adapters/runner/codex.js';
import { createSpecAdapter } from '../src/contract/adapter.js';
import { createChange, loadChange, saveChange } from '../src/core/change.js';
import { loadConfig } from '../src/core/config.js';
import { runChange } from '../src/core/run.js';
import { read, tempProject } from './helpers.js';

function executable(root: string, code: string) {
  const file = path.join(root, 'fake-codex.cjs');
  fs.writeFileSync(file, '#!/usr/bin/env node\n' + code); fs.chmodSync(file, 0o755); return file;
}
const options = { sandboxRead: 'read-only', sandboxWrite: 'workspace-write', approvalPolicy: 'on-request', extraConfig: [] };

describe('Codex CLI transport', () => {
  it('запускает аудит с выбранным профилем, принимает структурированный stdout-ответ и сохраняет receipt', async () => {
    const root = tempProject('spec-box-project', { git: false });
    const config = loadConfig(root); config.runner.stateDir = path.join(root, 'runner-state');
    const binary = executable(root, `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-test'); process.exit(0); }
if (args.includes('--help')) { console.log('--output-schema --output-last-message --json --cd --model --config'); process.exit(0); }
let prompt = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => prompt += c);
process.stdin.on('end', () => {
  fs.writeFileSync('invocation.json', JSON.stringify({ args, prompt }));
  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify({ markdown: 'Аудит завершён.', result: { status: 'готово', findings: [] } }));
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'test-session' }));
});`);
    const { dir, change } = createChange(root, config, { id: 'codex-audit', title: 'Audit', request: 'Check', autonomy: 'autonomous' });
    change.phase = 'challenge'; saveChange(dir, change);
    const result = await runChange({ root, config, dir, adapter: createSpecAdapter(root, config), runner: new CodexRunner(binary, options), maxRuns: 1 });
    expect(result.change.phase).toBe('cover');
    const invocation = JSON.parse(read(root, 'invocation.json'));
    expect(invocation.args).toEqual(expect.arrayContaining(['--model', config.runner.codex.profiles.complex.model, 'model_reasoning_effort="high"', 'sandbox_mode="read-only"']));
    expect(invocation.prompt).toContain('Файл resultFile записывает раннер');
    expect(invocation.prompt).not.toContain('Запиши полный ответ (Markdown');
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'runs/r1/receipt.json'), 'utf8'));
    expect(receipt).toMatchObject({ runner: 'codex', profile: 'complex', effort: 'high', status: 'done' });
    expect(receipt.requested_execution.agent).toBe('sbox-challenger-complex');
    expect(loadChange(dir).runs).toHaveLength(1);
    expect(receipt.session).toBe('test-session');
    const returned = loadChange(dir); returned.phase = 'challenge'; saveChange(dir, returned);
    await runChange({ root, config, dir, adapter: createSpecAdapter(root, config), runner: new CodexRunner(binary, options), maxRuns: 1 });
    const resumed = JSON.parse(read(root, 'invocation.json'));
    expect(resumed.args.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(resumed.args.slice(-2)).toEqual(['test-session', '-']);
    expect(resumed.args).not.toContain('--cd');
    expect(resumed.args).toContain('sandbox_mode="read-only"');
  });
  it('диагностирует отсутствие обязательных возможностей CLI', () => {
    const root = tempProject('spec-box-project', { git: false });
    const binary = executable(root, "console.log(process.argv.includes('--version') ? 'old-codex' : '--json');");
    expect(new CodexRunner(binary, options).supportsResume).toBe(false);
    expect(new CodexRunner(binary, options).probe()).toMatchObject({ ok: false, missing: expect.arrayContaining(['--output-schema', '--output-last-message']) });
  });
});
