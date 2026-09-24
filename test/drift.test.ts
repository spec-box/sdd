import path from 'node:path';
import { describe, expect, it } from 'vitest';
import '../src/adapters/spec/index.js';
import '../src/adapters/repo/index.js';
import { LocalRepoHost } from '../src/adapters/repo/local.js';
import { createChange, loadChange, saveChange } from '../src/core/change.js';
import { loadConfig } from '../src/core/config.js';
import { deliverChange, readinessChecklist } from '../src/core/deliver.js';
import { applyReport } from '../src/core/report.js';
import { createSpecAdapter } from '../src/core/spec-adapter.js';
import { RESULT, tempProject, write } from './helpers.js';

async function reviewed(root: string, id: string) {
  const config = loadConfig(root);
  const adapter = createSpecAdapter(root, config);
  const { dir } = createChange(root, config, { id, title: 'Поиск', request: 'поиск', autonomy: 'autonomous' });
  const rel = path.relative(root, dir);
  write(root, `${rel}/proposal.md`, '## Зачем\nпоиск');
  write(root, `${rel}/specs/home-page.yml`, 'code: home-page\nadded:\n  Поиск:\n    - assert: Поле поиска показывает подсказки\n');
  write(root, `${rel}/design.md`, '## Общая картина\nпоиск');
  write(root, `${rel}/tasks.md`, '- [x] 1.1 сделать\n');
  write(root, 'src/search.ts', 'export const search = () => [];\n');
  const c = loadChange(dir);
  c.phase = 'implement';
  saveChange(dir, c);
  const report = (role: string, phase: string, md: string) => applyReport({ root, config, dir, change: loadChange(dir), role: role as never, phase: phase as never, markdown: md, adapter });
  await report('implementer', 'implement', RESULT('готово'));
  await report('verifier', 'verify', RESULT('готово', 'checks:\n  - { id: V1, result: PASS }\n'));
  await report('reviewer', 'review', RESULT('готово', 'delivery_narrative: { title: "Поиск", delta: "поле", why: "работает" }\n'));
  expect(loadChange(dir).phase).toBe('deliver');
  return { config, adapter, dir, rel, report };
}

describe('дрейф после ревью', () => {
  it('правка .gitignore и README не отменяет вердикт: change-set перепривязывается', async () => {
    const root = tempProject();
    const { config, adapter, dir } = await reviewed(root, 'benign');
    const before = loadChange(dir).changeset!.digest;
    write(root, '.gitignore', 'node_modules/\n# sbox\n**/.stop\n');
    write(root, 'README.md', '# demo\nобновлено\n');
    const { dod, diagnostics } = await readinessChecklist(root, config, dir, loadChange(dir), adapter);
    expect(diagnostics).toEqual([]);
    expect(dod.find((d) => d.id === 9)?.ok).toBe(true);
    const after = loadChange(dir);
    expect(after.changeset!.digest).not.toBe(before);
    expect(after.reviewed_digest).toBe(after.changeset!.digest);
    expect(after.changeset!.rebound[0]!.files.sort()).toEqual(['.gitignore', 'README.md']);
    const result = await deliverChange({ root, config, dir, change: loadChange(dir), adapter, host: new LocalRepoHost(root) });
    expect(result.prBody).toContain('После ревью');
    expect(result.prBody).toContain('.gitignore');
  });

  it('правка кода после ревью блокирует доставку с понятной подсказкой, --force доставляет', async () => {
    const root = tempProject();
    const { config, adapter, dir } = await reviewed(root, 'code');
    write(root, 'src/search.ts', 'export const search = () => [1];\n');
    const { dod } = await readinessChecklist(root, config, dir, loadChange(dir), adapter);
    const item = dod.find((d) => d.id === 9)!;
    expect(item.ok).toBe(false);
    expect(item.detail).toMatch(/src\/search\.ts/);
    expect(item.detail).toMatch(/changeset seal/);
    await expect(deliverChange({ root, config, dir, change: loadChange(dir), adapter, host: new LocalRepoHost(root) })).rejects.toThrow(/9\. Вердикты/);
    const forced = await deliverChange({ root, config, dir, change: loadChange(dir), adapter, host: new LocalRepoHost(root), force: true });
    expect(forced.prBody).toContain('[ ] 9.');
  });

  it('безобидный дрейф на фазе verify перепривязывается, а не отклоняет отчёт', async () => {
    const root = tempProject();
    const config = loadConfig(root);
    const adapter = createSpecAdapter(root, config);
    const { dir } = createChange(root, config, { id: 'vdrift', title: 't', request: 'r', autonomy: 'autonomous' });
    write(root, path.relative(root, path.join(dir, 'tasks.md')), '- [x] 1.1 x\n');
    write(root, 'src/x.ts', 'export const x = 1;\n');
    const c = loadChange(dir);
    c.phase = 'implement';
    saveChange(dir, c);
    await applyReport({ root, config, dir, change: loadChange(dir), role: 'implementer', phase: 'implement', markdown: RESULT('готово'), adapter });
    write(root, 'README.md', '# demo\nправка после запечатывания\n');
    const out = await applyReport({ root, config, dir, change: loadChange(dir), role: 'verifier', phase: 'verify', markdown: RESULT('готово', 'checks:\n  - { id: V1, result: PASS }\n'), adapter });
    expect(out.diagnostics.map((d) => d.code)).toContain('CHANGESET_REBOUND');
    expect(out.phaseCompleted).toBe(true);
    expect(loadChange(dir).reviewed_digest).toBe(loadChange(dir).changeset!.digest);
  });
});
