import path from 'node:path';
import { describe, expect, it } from 'vitest';
import '../src/adapters/spec/index.js';
import { createChange, loadChange } from '../src/core/change.js';
import { loadConfig } from '../src/core/config.js';
import { nextStep } from '../src/core/phases.js';
import { applyReport, appliedOutcome, normalizeQuote, resolveReportFile } from '../src/core/report.js';
import { createSpecAdapter } from '../src/core/spec-adapter.js';
import { RESEARCH, RESULT, tempProject, write } from './helpers.js';

const REQUEST = 'Формы открываются прямо на странице списка. Для этого нужно обновить th-ui.';

function setup(id = 'req') {
  const root = tempProject();
  const config = loadConfig(root);
  const adapter = createSpecAdapter(root, config);
  const { dir } = createChange(root, config, { id, title: 'Шторка', request: REQUEST });
  const rel = path.relative(root, dir);
  write(root, `${rel}/evidence/research.md`, '# Evidence\n');
  const report = (role: string, phase: string, md: string) =>
    applyReport({ root, config, dir, change: loadChange(dir), role: role as never, phase: phase as never, markdown: md, adapter });
  return { root, config, dir, rel, adapter, report };
}

describe('разбор запроса', () => {
  it('без поля request отчёт исследователя не принят', async () => {
    const { report, dir } = setup();
    const out = await report('researcher', 'research', RESULT('готово'));
    expect(out.accepted).toBe(false);
    expect(out.diagnostics.map((d) => d.code)).toEqual(['REQUEST_MAP_MISSING']);
    expect(loadChange(dir).phase).toBe('research');
    expect(out.summary).toContain('отчёт не принят, ошибок: 1');
  });

  it('дословная цитата принимается, пересказ даёт предупреждение', async () => {
    const { report } = setup();
    const md = RESULT('готово', 'request:\n  - { quote: "нужно обновить th-ui", status: подтверждено, evidence: "package.json" }\n  - { quote: "нужно починить th-ui", status: подтверждено }\n');
    const out = await report('researcher', 'research', md);
    expect(out.accepted).toBe(true);
    expect(out.phaseCompleted).toBe(true);
    expect(out.diagnostics.map((d) => d.code)).toEqual(['REQUEST_QUOTE_MISMATCH']);
    expect(out.diagnostics[0]!.message).toContain('нужно починить th-ui');
    expect(out.summary).toMatch(/^researcher r1: готово, фаза завершена, предупреждений: 1\. Артефакты: .*evidence\/research\.md\. Дальше: роль planner, фаза propose\.$/);
  });

  it('одна цитата почти на весь запрос помечается как пересказ целиком', async () => {
    const { report } = setup();
    const out = await report('researcher', 'research', RESEARCH(REQUEST));
    expect(out.accepted).toBe(true);
    expect(out.diagnostics.map((d) => d.code)).toEqual(['REQUEST_QUOTE_BLANKET']);
  });

  it('нормализация цитат не зависит от регистра, ё, кавычек, тире и пробелов', () => {
    expect(normalizeQuote('  «Обновить  th-ui», ещё. ')).toBe('обновить th-ui, еще');
    expect(normalizeQuote('формы — *прямо* на странице')).toBe('формы - прямо на странице');
  });

  it('статус «противоречит» сохраняется как расхождение и требует deviations от планировщика', async () => {
    const { report, dir, rel, root, config } = setup();
    const research = RESULT('готово', 'request:\n  - { quote: "нужно обновить th-ui", status: противоречит, evidence: "в реестре нет версии с исправлением" }\n  - { quote: "прямо на странице списка", status: подтверждено, evidence: "src/list.tsx" }\n');
    let out = await report('researcher', 'research', research);
    expect(out.accepted).toBe(true);
    let change = loadChange(dir);
    expect(change.conflicts).toEqual([{ id: 'C1', kind: 'противоречие', subject: 'запрос', role: 'researcher', run: 'r1', text: 'нужно обновить th-ui', evidence: 'в реестре нет версии с исправлением' }]);
    expect(out.summary).toContain('Расхождения: C1.');

    write(root, `${rel}/proposal.md`, '## Зачем\nШторка.');
    out = await report('planner', 'propose', RESULT('утверждение', 'size: normal\n'));
    expect(out.accepted).toBe(false);
    expect(out.diagnostics.map((d) => d.code)).toContain('DEVIATIONS_MISSING');
    expect(loadChange(dir).conflicts).toHaveLength(1); // противоречие исследователя не потеряно

    out = await report('planner', 'propose', RESULT('утверждение', 'size: normal\ndeviations:\n  - { subject: evidence, text: "исправление уже опубликовано в 0.13.0", decision: "только поднять зависимость", reason: "коммит d167700 есть в реестре" }\n'));
    expect(out.accepted).toBe(true);
    expect(out.next).toMatchObject({ kind: 'gate', gate: 'proposal' });
    change = loadChange(dir);
    expect(change.conflicts.map((c) => [c.id, c.kind, c.role])).toEqual([
      ['C1', 'противоречие', 'researcher'],
      ['C2', 'отступление', 'planner'],
    ]);
    expect(change.conflicts[1]).toMatchObject({ subject: 'evidence', decision: 'только поднять зависимость', run: 'r3' });
    expect(nextStep(change, config)).toMatchObject({ kind: 'gate', gate: 'proposal' });
    expect(out.summary).toContain('Расхождения: C1, C2. Дальше: гейт proposal.');
  });
});

describe('повторный и переписанный отчёт', () => {
  it('повторный report с тем же ответом не создаёт запуск', async () => {
    const { root, config, dir, report } = setup('dup');
    const md = RESEARCH('нужно обновить th-ui');
    const first = await report('researcher', 'research', md);
    expect(first.runId).toBe('r1');
    // Тот же файл сдаётся ещё раз: явно и без --file
    const explicit = resolveReportFile(dir, loadChange(dir), 'researcher', path.join(dir, 'runs/r1/result.md'));
    expect(explicit.applied?.id).toBe('r1');
    const implicit = resolveReportFile(dir, loadChange(dir), 'researcher');
    expect(implicit.applied?.id).toBe('r1');
    const again = appliedOutcome({ root, config, dir, change: loadChange(dir), run: implicit.applied! });
    expect(again.alreadyApplied).toBe(true);
    expect(again.runId).toBe('r1');
    expect(again.accepted).toBe(true);
    expect(again.diagnostics.map((d) => d.code)).toEqual(['REPORT_ALREADY_APPLIED']);
    expect(again.summary).toContain('ответ уже был принят');
    expect(again.next).toMatchObject({ kind: 'role', role: 'planner' });
    expect(loadChange(dir).runs).toHaveLength(1);
  });

  it('переписанный ответ последнего запуска принимается без --file, чужая роль получает путь следующего запуска', async () => {
    const { dir, rel, root, config, report } = setup('rw');
    const failed = await report('researcher', 'research', RESULT('готово'));
    expect(failed.accepted).toBe(false);
    // Повтор без правок: тот же отклонённый ответ, запуск не создаётся
    const same = resolveReportFile(dir, loadChange(dir), 'researcher');
    expect(same.applied?.id).toBe('r1');
    const repeated = appliedOutcome({ root, config, dir, change: loadChange(dir), run: same.applied! });
    expect(repeated.accepted).toBe(false);
    expect(repeated.diagnostics.map((d) => d.code)).toEqual(['REPORT_ALREADY_APPLIED', 'RUN_FAILED']);
    // Роль исправила ответ в своём resultFile
    write(root, `${rel}/runs/r1/result.md`, RESEARCH('нужно обновить th-ui'));
    const resolved = resolveReportFile(dir, loadChange(dir), 'researcher');
    expect(resolved.applied).toBeNull();
    expect(path.relative(dir, resolved.file)).toBe(path.join('runs', 'r1', 'result.md'));
    const other = resolveReportFile(dir, loadChange(dir), 'planner');
    expect(other.applied).toBeNull();
    expect(path.relative(dir, other.file)).toBe(path.join('runs', 'r2', 'result.md'));
  });
});
