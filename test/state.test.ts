import path from 'node:path';
import { describe, expect, it } from 'vitest';
import '../src/adapters/spec/index.js';
import { createChange, loadChange, saveChange } from '../src/core/change.js';
import { computeChangeSet, changeSetDrift, sealChangeSet } from '../src/core/changeset.js';
import { loadConfig } from '../src/core/config.js';
import { acquireLock } from '../src/core/lock.js';
import { resumeChange, routeBlocker } from '../src/core/phases.js';
import { applyReport } from '../src/core/report.js';
import { createSpecAdapter } from '../src/core/spec-adapter.js';
import { BLOCKED, RESULT, git, tempProject, write } from './helpers.js';

async function report(root: string, dir: string, role: string, phase: string, md: string) {
  const config = loadConfig(root);
  const change = loadChange(dir);
  const adapter = createSpecAdapter(root, config);
  return applyReport({ root, config, dir, change, role: role as never, phase: phase as never, markdown: md, adapter });
}

describe('дисциплина состояния', () => {
  it('ревизия растёт при записи, устаревшая копия отклоняется', () => {
    const root = tempProject();
    const config = loadConfig(root);
    const { dir } = createChange(root, config, { id: 'rev', title: 't', request: 'r' });
    const a = loadChange(dir);
    const b = loadChange(dir);
    expect(a.revision).toBe(1);
    a.title = 'A';
    saveChange(dir, a);
    expect(loadChange(dir).revision).toBe(2);
    b.title = 'B';
    expect(() => saveChange(dir, b)).toThrow(/REVISION_CONFLICT|изменён другим процессом/);
  });

  it('терминальный статус не меняется без явного продолжения', () => {
    const root = tempProject();
    const config = loadConfig(root);
    const { dir } = createChange(root, config, { id: 'term', title: 't', request: 'r' });
    const c = loadChange(dir);
    c.status = 'stopped';
    saveChange(dir, c, { allowTerminalReopen: true });
    const d = loadChange(dir);
    d.status = 'active';
    expect(() => saveChange(dir, d)).toThrow(/терминальный/);
    const e = loadChange(dir);
    resumeChange(e, config);
    expect(e.status).toBe('active');
    expect(() => saveChange(dir, e, { allowTerminalReopen: true })).not.toThrow();
  });

  it('блокировка папки изменения не даёт второго запуска', () => {
    const root = tempProject();
    const config = loadConfig(root);
    const { dir } = createChange(root, config, { id: 'lock', title: 't', request: 'r' });
    const release = acquireLock(dir, 'test');
    expect(() => acquireLock(dir, 'other')).toThrow(/CHANGE_BUSY|занято/);
    release();
    expect(() => acquireLock(dir, 'other')).not.toThrow();
  });

  it('исчерпание возвратов паркует изменение, resume с большим лимитом продолжает', () => {
    const root = tempProject();
    const config = loadConfig(root);
    const { dir } = createChange(root, config, { id: 'park', title: 't', request: 'r' });
    const c = loadChange(dir);
    c.phase = 'review';
    for (let i = 0; i < 3; i += 1) {
      routeBlocker(c, config, { category: 'реализация', message: 'x', role: 'reviewer', phase: 'review' });
      c.phase = 'review';
    }
    routeBlocker(c, config, { category: 'реализация', message: 'y', role: 'reviewer', phase: 'review' });
    expect(c.status).toBe('parked');
    expect(() => resumeChange(c, config)).toThrow(/RETURNS_REQUIRED|исчерпан/);
    expect(() => resumeChange(c, config, { returns: 4 })).toThrow(/не больше/);
    const phase = resumeChange(c, config, { returns: 6, comment: 'попробуй ещё раз' });
    expect(phase).toBe('implement');
    expect(c.status).toBe('active');
    expect(c.blocker?.resolution).toBe('попробуй ещё раз');
  });
});

describe('change-set', () => {
  it('запечатывает реальные пути и замечает дрейф', () => {
    const root = tempProject();
    const config = loadConfig(root);
    const { dir, change } = createChange(root, config, { id: 'cs', title: 't', request: 'r' });
    expect(change.base_revision).toMatch(/^[0-9a-f]{40}$/);
    write(root, 'src/feature.ts', 'export const x = 1;\n');
    write(root, 'src/index.ts', 'export const app = "changed";\n');
    const sealed = sealChangeSet(root, change.base_revision!, ['.sbox/**'], 'r1');
    expect(sealed.files.map((f) => `${f.status} ${f.path}`)).toEqual(['A src/feature.ts', 'M src/index.ts']);
    expect(changeSetDrift(root, sealed, ['.sbox/**']).drifted).toBe(false);
    write(root, 'src/feature.ts', 'export const x = 2;\n');
    const drift = changeSetDrift(root, sealed, ['.sbox/**']);
    expect(drift.drifted).toBe(true);
    expect(drift.modified).toEqual(['src/feature.ts']);
    // коммит не меняет дайджест: сравнение с базой, а не с HEAD
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'wip']);
    expect(computeChangeSet(root, change.base_revision!, ['.sbox/**']).digest).toBe(drift.currentDigest);
    void dir;
  });

  it('implement запечатывает, дрейф до review отклоняет отчёт, archive требует привязки', async () => {
    const root = tempProject();
    const config = loadConfig(root);
    const { dir } = createChange(root, config, { id: 'seal', title: 't', request: 'r', autonomy: 'autonomous' });
    const rel = path.relative(root, dir);
    write(root, `${rel}/tasks.md`, '- [x] 1.1 done\n');
    const c = loadChange(dir);
    c.phase = 'implement';
    saveChange(dir, c);
    write(root, 'src/new.ts', 'export const n = 1;\n');
    let out = await report(root, dir, 'implementer', 'implement', RESULT('готово'));
    expect(out.diagnostics.map((d) => d.code)).toContain('CHANGESET_SEALED');
    expect(loadChange(dir).changeset?.paths).toBe(1);
    expect(loadChange(dir).phase).toBe('verify');
    write(root, 'src/new.ts', 'export const n = 2;\n');
    out = await report(root, dir, 'verifier', 'verify', RESULT('готово', 'checks:\n  - { id: V1, result: PASS }\n'));
    expect(out.diagnostics.map((d) => d.code)).toContain('CHANGESET_DRIFT');
    expect(out.phaseCompleted).toBe(false);
    write(root, 'src/new.ts', 'export const n = 1;\n');
    out = await report(root, dir, 'verifier', 'verify', RESULT('готово', 'checks:\n  - { id: V1, result: PASS }\n  - { id: V2, result: PARTIAL, evidence: "e2e недоступен" }\ngaps:\n  - { id: G1, environment: "стенд", oracle: "e2e", risk: "низкий" }\n'));
    expect(out.phaseCompleted).toBe(true);
    expect(loadChange(dir).reviewed_digest).toBe(loadChange(dir).changeset?.digest);
    expect(loadChange(dir).verification?.gaps).toHaveLength(1);
  });
});

describe('контракт верификатора и ревьюера', () => {
  async function toReview(root: string): Promise<string> {
    const config = loadConfig(root);
    const { dir } = createChange(root, config, { id: 'rv', title: 't', request: 'r', autonomy: 'autonomous' });
    const c = loadChange(dir);
    c.phase = 'verify';
    saveChange(dir, c);
    return dir;
  }

  it('FAIL у верификатора возвращает к реализации даже при статусе готово', async () => {
    const root = tempProject();
    const dir = await toReview(root);
    const out = await report(root, dir, 'verifier', 'verify', RESULT('готово', 'checks:\n  - { id: V1, result: FAIL, evidence: "тест падает" }\n'));
    expect(out.phaseCompleted).toBe(false);
    expect(loadChange(dir).phase).toBe('implement');
    expect(loadChange(dir).blocker?.category).toBe('реализация');
  });

  it('ревьюер обязан распорядиться каждым не-PASS пунктом и дать delivery_narrative', async () => {
    const root = tempProject();
    const dir = await toReview(root);
    await report(root, dir, 'verifier', 'verify', RESULT('готово', 'checks:\n  - { id: V1, result: PASS }\n  - { id: V2, result: NOT_RUN }\ngaps:\n  - { id: G1, environment: "браузер" }\n'));
    expect(loadChange(dir).phase).toBe('review');
    let out = await report(root, dir, 'reviewer', 'review', RESULT('готово', 'delivery_narrative: { title: "Поиск", delta: "поле", why: "работает" }\n'));
    expect(out.diagnostics.map((d) => d.code)).toContain('REVIEW_DISPOSITION_MISSING');
    out = await report(root, dir, 'reviewer', 'review', RESULT('готово', 'dispositions:\n  - { item: V2, disposition: satisfied, reason: "покрыто V1" }\n  - { item: G1, disposition: manual_gap_accepted, reason: "низкий риск" }\n'));
    expect(out.diagnostics.map((d) => d.code)).toContain('DELIVERY_NARRATIVE_MISSING');
    out = await report(root, dir, 'reviewer', 'review', RESULT('готово', 'dispositions:\n  - { item: V2, disposition: satisfied }\n  - { item: G1, disposition: manual_gap_accepted, reason: "низкий риск" }\ndelivery_narrative: { title: "Поиск", delta: "поле", why: "работает" }\n'));
    expect(out.phaseCompleted).toBe(true);
    expect(loadChange(dir).phase).toBe('deliver');
    expect(loadChange(dir).accepted_gaps).toEqual([{ item: 'G1', reason: 'низкий риск' }]);
  });

  it('disposition change_required возвращает к реализации', async () => {
    const root = tempProject();
    const dir = await toReview(root);
    await report(root, dir, 'verifier', 'verify', RESULT('готово', 'checks:\n  - { id: V1, result: PARTIAL }\n'));
    const out = await report(root, dir, 'reviewer', 'review', RESULT('готово', 'dispositions:\n  - { item: V1, disposition: change_required, reason: "добавить негативный тест" }\ndelivery_narrative: { title: "x", delta: "y", why: "z" }\n'));
    expect(out.phaseCompleted).toBe(false);
    expect(loadChange(dir).phase).toBe('implement');
    void BLOCKED;
  });
});
