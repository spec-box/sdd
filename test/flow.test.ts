import path from 'node:path';
import { describe, expect, it } from 'vitest';
import '../src/adapters/spec/index.js';
import { archiveChange } from '../src/core/archive.js';
import { createChange, loadChange } from '../src/core/change.js';
import { loadConfig } from '../src/core/config.js';
import { buildPacket } from '../src/core/packet.js';
import { approveGate, nextStep, rejectGate } from '../src/core/phases.js';
import { applyReport } from '../src/core/report.js';
import { createSpecAdapter } from '../src/core/spec-adapter.js';
import { RESULT, read, tempProject, write } from './helpers.js';

async function report(root: string, dir: string, role: string, phase: string, md: string) {
  const config = loadConfig(root);
  const change = loadChange(dir);
  const adapter = createSpecAdapter(root, config);
  return applyReport({ root, config, dir, change, role: role as never, phase: phase as never, markdown: md, adapter });
}

describe('полный цикл изменения (supervised, без агентов)', () => {
  it('проходит от intake до архива с гейтами и возвратом', async () => {
    const root = tempProject();
    const config = loadConfig(root);
    const adapter = createSpecAdapter(root, config);
    const { dir } = createChange(root, config, { id: 'add-search', title: 'Поиск по каталогу', request: 'Добавить поле поиска на главную.' });
    const rel = (p: string) => path.relative(root, p);

    // research
    let step = nextStep(loadChange(dir), config);
    expect(step).toMatchObject({ kind: 'role', role: 'researcher', phase: 'research' });
    const packet = buildPacket({ root, config, change: loadChange(dir), dir, role: 'researcher', phase: 'research', adapter, truthSources: ['specs/home-page.spec-box.yml'] });
    expect(packet.files.docs.map((d) => d.category)).toContain('product');
    expect(packet.rules[0]?.id).toBe('ADR-0001');
    write(root, `${rel(dir)}/evidence/research.md`, '# Evidence\nфакты');
    let out = await report(root, dir, 'researcher', 'research', RESULT('готово'));
    expect(out.phaseCompleted).toBe(true);
    expect(loadChange(dir).phase).toBe('propose');

    // propose → гейт proposal
    out = await report(root, dir, 'planner', 'propose', RESULT('утверждение', 'size: normal\ncomplexity: { implementation: обычная, review: высокая }\n'));
    expect(out.diagnostics.map((d) => d.code)).toContain('ARTIFACT_MISSING'); // proposal.md не создан
    write(root, `${rel(dir)}/proposal.md`, '## Зачем\nПоиск.');
    out = await report(root, dir, 'planner', 'propose', RESULT('утверждение', 'size: normal\ncomplexity: { implementation: обычная, review: высокая }\n'));
    expect(out.next).toMatchObject({ kind: 'gate', gate: 'proposal' });

    // отклоняем и утверждаем
    let change = loadChange(dir);
    rejectGate(change, 'proposal', 'dima', 'сузить объём');
    expect(change.phase).toBe('propose');
    expect(buildPacket({ root, config, change, dir, role: 'planner', phase: 'propose', adapter, truthSources: [] }).feedback).toContain('сузить объём');
    out = await report(root, dir, 'planner', 'propose', RESULT('утверждение'));
    change = loadChange(dir);
    approveGate(change, 'proposal', 'dima');
    expect(change.phase).toBe('plan');
    const { saveChange } = await import('../src/core/change.js');
    saveChange(dir, change);

    // plan: нужны дельта, design, tasks
    write(root, `${rel(dir)}/specs/home-page.yml`, 'code: home-page\nadded:\n  Поиск по каталогу:\n    - assert: Поле поиска показывает подсказки\n');
    write(root, `${rel(dir)}/design.md`, '## Общая картина\nпоиск');
    write(root, `${rel(dir)}/tasks.md`, '## 1\n- [ ] 1.1 Сделать поле\n- [ ] 1.2 Прогнать тесты\n');
    out = await report(root, dir, 'planner', 'plan', RESULT('готово'));
    expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(out.next).toMatchObject({ kind: 'gate', gate: 'plan' });
    change = loadChange(dir);
    approveGate(change, 'plan', 'dima', undefined, { Q1: 'B' });
    saveChange(dir, change);
    expect(change.phase).toBe('cover');

    // cover: coverage.yaml + защита тестов
    write(root, `${rel(dir)}/coverage.yaml`, 'home-page: {}\n');
    out = await report(root, dir, 'tester', 'cover', RESULT('готово', 'protected:\n  - "src/**/*.test.ts"\n'));
    expect(loadChange(dir).protected).toEqual(['src/**/*.test.ts']);
    expect(out.next).toMatchObject({ kind: 'role', role: 'reviewer', phase: 'tests_review' });

    // ревью тестов с блокирующей находкой → возврат к тестировщику
    out = await report(root, dir, 'reviewer', 'tests_review', RESULT('готово', 'findings:\n  - { level: blocking, file: "src/a.test.ts:3", text: "нет теста на подсказки" }\n'));
    expect(loadChange(dir).phase).toBe('cover');
    expect(loadChange(dir).returns.cover).toBe(1);
    out = await report(root, dir, 'tester', 'cover', RESULT('готово'));
    out = await report(root, dir, 'reviewer', 'tests_review', RESULT('готово'));
    expect(out.next).toMatchObject({ kind: 'gate', gate: 'tests' });
    change = loadChange(dir);
    approveGate(change, 'tests', 'dima');
    saveChange(dir, change);

    // implement: задачи не отмечены → отчёт не принят
    out = await report(root, dir, 'implementer', 'implement', RESULT('готово'));
    expect(out.diagnostics.map((d) => d.code)).toContain('TASKS_REMAINING');
    write(root, `${rel(dir)}/tasks.md`, '## 1\n- [x] 1.1 Сделать поле\n- [x] 1.2 Прогнать тесты\n');
    out = await report(root, dir, 'implementer', 'implement', RESULT('готово'));
    expect(loadChange(dir).phase).toBe('verify');

    // верификатор до ревьюера; блокер реализации от ревьюера → возврат
    out = await report(root, dir, 'verifier', 'verify', RESULT('готово'));
    expect(loadChange(dir).phase).toBe('review');
    out = await report(root, dir, 'reviewer', 'review', 'Плохо.\n```yaml\n# sbox-result\nstatus: заблокировано\nblocker: { category: реализация, message: "нет обработки пустого запроса" }\n```\n');
    expect(loadChange(dir).phase).toBe('implement');
    out = await report(root, dir, 'implementer', 'implement', RESULT('готово'));
    out = await report(root, dir, 'verifier', 'verify', RESULT('готово', 'checks:\n  - { id: V1, result: PASS }\n'));
    out = await report(root, dir, 'reviewer', 'review', RESULT('готово', 'delivery_narrative: { title: "Поиск", delta: "поле поиска", why: "подсказки с бэкенда" }\n'));
    expect(out.next).toEqual({ kind: 'deliver' });

    // архивация
    const result = await archiveChange(root, config, adapter, dir, loadChange(dir), { date: '2026-09-12' });
    expect(result.appliedFiles).toEqual(['specs/home-page.spec-box.yml']);
    expect(read(root, 'specs/home-page.spec-box.yml')).toContain('Поиск по каталогу');
    expect(path.basename(result.archivedTo)).toBe('2026-09-12-add-search');
    expect(loadChange(result.archivedTo).status).toBe('archived');
  });

  it('вопрос P0 останавливает изменение на человека', async () => {
    const root = tempProject();
    const config = loadConfig(root);
    const { dir } = createChange(root, config, { id: 'p0', title: 't', request: 'r', autonomy: 'autonomous' });
    write(root, path.relative(root, path.join(dir, 'evidence/research.md')), 'x');
    await report(root, dir, 'researcher', 'research', RESULT('готово'));
    write(root, path.relative(root, path.join(dir, 'proposal.md')), 'x');
    await report(root, dir, 'planner', 'propose', RESULT('утверждение'));
    expect(loadChange(dir).phase).toBe('plan'); // гейт proposal пропущен профилем autonomous
    expect(loadChange(dir).gates.proposal?.state).toBe('skipped');
    write(root, path.relative(root, path.join(dir, 'specs/home-page.yml')), 'code: home-page\nadded:\n  Г:\n    - assert: a\n');
    write(root, path.relative(root, path.join(dir, 'design.md')), 'x');
    write(root, path.relative(root, path.join(dir, 'tasks.md')), '- [ ] 1.1 x\n');
    const out = await report(root, dir, 'planner', 'plan', RESULT('готово', 'questions:\n  - { id: Q1, priority: P0, text: "какой бэкенд?" }\n'));
    expect(out.next).toMatchObject({ kind: 'wait', status: 'waiting_user' });
    expect(loadChange(dir).blocker?.category).toBe('пользователь');
  });

  it('лимит возвратов паркует изменение', async () => {
    const root = tempProject();
    const config = loadConfig(root);
    const { dir } = createChange(root, config, { id: 'lim', title: 't', request: 'r', autonomy: 'autonomous' });
    const change = loadChange(dir);
    change.phase = 'review';
    const { saveChange } = await import('../src/core/change.js');
    saveChange(dir, change);
    const blocked = 'x\n```yaml\n# sbox-result\nstatus: заблокировано\nblocker: { category: реализация, message: "снова" }\n```\n';
    for (let i = 0; i < 3; i += 1) {
      await report(root, dir, 'reviewer', 'review', blocked);
      const c = loadChange(dir);
      c.phase = 'review';
      saveChange(dir, c);
    }
    const out = await report(root, dir, 'reviewer', 'review', blocked);
    expect(out.next).toMatchObject({ kind: 'wait', status: 'parked' });
  });
});
