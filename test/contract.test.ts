import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, afterEach } from 'vitest';
import { contractContext, initContract } from '../src/contract/context.js';
import { ContractService } from '../src/contract/service.js';
import { buildProgram as buildSbox } from '../src/cli/main.js';
import { tempProject, write, read } from './helpers.js';

const dirs: string[] = [];
const DELTA = '## ADDED Requirements\n\n### Requirement: Two-Factor Authentication\nThe system MUST support TOTP.\n\n#### Scenario: Enrollment\n- **WHEN** the user enables 2FA\n- **THEN** a QR code is displayed\n';
function setup(format: 'spec-box' | 'openspec' = 'openspec') {
  const root = tempProject(`${format}-project`, { git: false }); dirs.push(root);
  fs.rmSync(path.join(root, '.sbox'), { recursive: true, force: true });
  const { adapter } = contractContext({ cwd: root });
  return { root, svc: new ContractService(root, adapter) };
}
afterEach(() => { for (const root of dirs.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const cli = (root: string, args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', 'import {main} from "./src/contract/cli.ts"; await main(["node", "sbox-contract", ...process.argv.slice(1)]);', '--', '--cwd', root, '--json', ...args], { encoding: 'utf8' });

describe('sbox-contract', () => {
  it('убирает старую группу spec, сохраняя archive в оркестраторе', () => {
    const commands = buildSbox().commands.map(c => c.name());
    expect(commands).not.toContain('spec');
    expect(commands).toContain('archive');
  });
  it('автономно обнаруживает оба формата и сохраняет нормативный текст', async () => {
    for (const format of ['spec-box', 'openspec'] as const) {
      const { root, svc } = setup(format);
      expect(svc.adapter.name).toBe(format);
      expect((await svc.inspect()).truth.length).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(root, '.sbox'))).toBe(false);
    }
    const { svc } = setup();
    const auth = await svc.show('auth'); expect(auth.requirements[0]!.text).toBeTruthy();
    const results = await svc.search(auth.requirements[0]!.scenarios[0]!.title);
    expect(results.some(r => r.kind === 'scenario')).toBe(true);
  });
  it('инициализирует отдельный конфиг и обнаруживает его из вложенного каталога', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-init-')); dirs.push(root);
    initContract(root, 'spec-box'); fs.mkdirSync(path.join(root, 'src'));
    expect(contractContext({ cwd: path.join(root, 'src') }).root).toBe(root);
    expect(() => initContract(root)).toThrow();
    expect(fs.existsSync(path.join(root, '.sbox'))).toBe(false);
  });
  it('preview не пишет файлы; применение соответствует предпросмотру и сохраняет остальные разделы OpenSpec', async () => {
    const { root, svc } = setup(); const before = read(root, 'openspec/specs/auth/spec.md');
    write(root, 'delta/auth/spec.md', DELTA);
    const plan = await svc.inspect(path.join(root, 'delta'));
    const preview = svc.adapter.preview(plan.truth, plan.deltas);
    expect(read(root, 'openspec/specs/auth/spec.md')).toBe(before);
    expect(preview.find(c => c.id === 'auth')!.requirements.some(r => r.title === 'Two-Factor Authentication')).toBe(true);
    await svc.apply(path.join(root, 'delta'), { ifMatch: plan.revision });
    expect((await svc.inspect()).truth).toEqual(preview);
    expect(read(root, 'openspec/specs/auth/spec.md')).toContain('## Notes');
  });
  it('применяет spec-box через тот же сервис и находит новый сценарий', async () => {
    const { root, svc } = setup('spec-box');
    write(root, 'delta/home.yml', 'code: home-page\nadded:\n  Экспорт заказа:\n    - assert: Выгрузка содержит номер заказа\n');
    const plan = await svc.inspect(path.join(root, 'delta'));
    const preview = svc.adapter.preview(plan.truth, plan.deltas);
    await svc.apply(path.join(root, 'delta'), { ifMatch: plan.revision });
    expect((await svc.inspect()).truth).toEqual(preview);
    expect((await svc.search('номер заказа')).some(r => r.kind === 'scenario')).toBe(true);
  });
  it('отклоняет параллельное применение и не удаляет чужой lock', async () => {
    const { root, svc } = setup();
    write(root, '.sbox-contract.lock', 'other');
    await expect(svc.apply(undefined)).rejects.toThrow(/Другая операция/);
    expect(read(root, '.sbox-contract.lock')).toBe('other');
  });
  it('создаёт инструкцию дельты и сохраняет JSON ошибки вложенной команды', () => {
    const { root } = setup();
    expect(cli(root, ['delta', 'init', 'delta']).status).toBe(0);
    expect(read(root, 'delta/README.md')).toContain('OpenSpec');
    expect(JSON.parse(cli(root, ['delta', 'init']).stdout).ok).toBe(false);
    expect(JSON.parse(cli(root, ['delta', 'init', 'delta']).stdout).error.code).toBe('CONTRACT_DELTA_EXISTS');
  });
  it('отклоняет дрейф истины и дельты после проверки', async () => {
    const { root, svc } = setup(); write(root, 'delta/auth/spec.md', DELTA);
    const plan = await svc.inspect(path.join(root, 'delta'));
    write(root, 'delta/auth/spec.md', DELTA.replace('TOTP', 'SMS'));
    await expect(svc.apply(path.join(root, 'delta'), { ifMatch: plan.revision })).rejects.toThrow(/изменилась/);
    const next = await svc.inspect(path.join(root, 'delta'));
    const before = read(root, 'openspec/specs/auth/spec.md') + '\nКомментарий\n';
    write(root, 'openspec/specs/auth/spec.md', before);
    await expect(svc.apply(path.join(root, 'delta'), { ifMatch: next.revision })).rejects.toThrow(/изменилась/);
    expect(read(root, 'openspec/specs/auth/spec.md')).toBe(before);
  });
  it('откатывает применение при сбое вызывающего оркестратора и освобождает lock', async () => {
    const { root, svc } = setup(); write(root, 'delta/auth/spec.md', DELTA);
    const before = read(root, 'openspec/specs/auth/spec.md');
    await expect(svc.apply(path.join(root, 'delta'), { finalize: () => { throw new Error('archive failed'); } })).rejects.toThrow('archive failed');
    expect(read(root, 'openspec/specs/auth/spec.md')).toBe(before);
    expect(fs.existsSync(path.join(root, '.sbox-contract.lock'))).toBe(false);
  });
  it('CLI выдаёт JSON ошибок и не применяет без revision или с пустым каталогом', () => {
    const { root } = setup(); write(root, 'delta/auth/spec.md', DELTA);
    expect(JSON.parse(cli(root, ['show']).stdout).ok).toBe(false);
    expect(JSON.parse(cli(root, ['apply', '--delta', 'delta']).stdout).error.code).toBe('CONTRACT_REVISION');
    expect(JSON.parse(cli(root, ['diff', '--delta', 'missing']).stdout).error.code).toBe('CONTRACT_DELTA_DIR');
    fs.mkdirSync(path.join(root, 'empty'));
    expect(JSON.parse(cli(root, ['diff', '--delta', 'empty']).stdout).error.code).toBe('CONTRACT_DELTA_EMPTY');
    const check = cli(root, ['apply', '--delta', 'delta', '--check']); expect(check.status).toBe(0);
    const revision = JSON.parse(check.stdout).data.revision;
    expect(cli(root, ['apply', '--delta', 'delta', '--if-match', revision]).status).toBe(0);
    expect(fs.existsSync(path.join(root, 'delta/auth/spec.md'))).toBe(true);
  });
});
