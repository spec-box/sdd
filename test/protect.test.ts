import path from 'node:path';
import { describe, expect, it } from 'vitest';
import '../src/adapters/spec/index.js';
import { createChange, loadChange, saveChange } from '../src/core/change.js';
import { loadConfig } from '../src/core/config.js';
import { protectedViolations, snapshotProtected } from '../src/core/protect.js';
import { applyReport } from '../src/core/report.js';
import { createSpecAdapter } from '../src/core/spec-adapter.js';
import { RESULT, tempProject, write } from './helpers.js';
import fs from 'node:fs';

describe('защита тестов', () => {
  it('снимок по содержимому: untracked тесты без правок не считаются изменёнными', async () => {
    const root = tempProject();
    const config = loadConfig(root);
    const adapter = createSpecAdapter(root, config);
    const { dir } = createChange(root, config, { id: 'prot', title: 't', request: 'r', autonomy: 'autonomous' });
    const rel = path.relative(root, dir);
    write(root, `${rel}/coverage.yaml`, 'home-page: {}\n');
    write(root, `${rel}/tasks.md`, '- [x] 1.1 x\n');
    // тестировщик создаёт новый (untracked) тест и защищает каталог
    write(root, 'src/search.test.ts', 'describe("Главная страница", () => {});\n');
    const c = loadChange(dir);
    c.phase = 'cover';
    saveChange(dir, c);
    const report = (role: string, phase: string, md: string) => applyReport({ root, config, dir, change: loadChange(dir), role: role as never, phase: phase as never, markdown: md, adapter });
    let out = await report('tester', 'cover', RESULT('готово', 'protected:\n  - "src/**/*.test.ts"\n'));
    expect(out.diagnostics.map((d) => d.code)).toContain('PROTECTED_SNAPSHOT');
    expect(Object.keys(loadChange(dir).protected_snapshot)).toEqual(['src/search.test.ts']);
    await report('reviewer', 'tests_review', RESULT('готово'));
    expect(loadChange(dir).phase).toBe('implement');
    // реализатор меняет только продуктовый код: тест остаётся untracked и нетронутым
    write(root, 'src/search.ts', 'export const s = 1;\n');
    out = await report('implementer', 'implement', RESULT('готово'));
    expect(out.diagnostics.map((d) => d.code)).not.toContain('PROTECTED_CHANGED');
    expect(out.phaseCompleted).toBe(true);
  });

  it('замечает изменение, удаление и добавление защищённых файлов', () => {
    const root = tempProject();
    write(root, 'src/a.test.ts', 'a');
    write(root, 'src/b.test.ts', 'b');
    const snapshot = snapshotProtected(root, ['src/**/*.test.ts']);
    expect(Object.keys(snapshot)).toEqual(['src/a.test.ts', 'src/b.test.ts']);
    expect(protectedViolations(root, ['src/**/*.test.ts'], snapshot)).toEqual([]);
    write(root, 'src/a.test.ts', 'a2');
    fs.rmSync(path.join(root, 'src/b.test.ts'));
    write(root, 'src/c.test.ts', 'c');
    expect(protectedViolations(root, ['src/**/*.test.ts'], snapshot)).toEqual([
      { path: 'src/a.test.ts', kind: 'modified' },
      { path: 'src/b.test.ts', kind: 'deleted' },
      { path: 'src/c.test.ts', kind: 'added' },
    ]);
  });
});
