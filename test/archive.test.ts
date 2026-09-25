import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import '../src/adapters/spec/index.js';
import { applyOpenSpecDelta, checkOpenSpecTruth, parseOpenSpecDelta } from '../src/adapters/spec/openspec/delta.js';
import { parseSpecFile } from '../src/adapters/spec/openspec/parser.js';
import { archiveChange, isEmptyTree } from '../src/core/archive.js';
import { createChange, loadChange, saveChange } from '../src/core/change.js';
import { loadConfig } from '../src/core/config.js';
import { createSpecAdapter, type SpecAdapter } from '../src/core/spec-adapter.js';
import { read, tempProject, write } from './helpers.js';

const DELTA = '## ADDED Requirements\n\n### Requirement: Two-Factor Authentication\nThe system MUST support TOTP.\n\n#### Scenario: Enrollment\n- **WHEN** the user enables 2FA\n- **THEN** a QR code is displayed\n';

function deliverable(root: string, id = 'arch') {
  const config = loadConfig(root);
  const adapter = createSpecAdapter(root, config);
  const { dir } = createChange(root, config, { id, title: '2FA', request: 'r', autonomy: 'autonomous' });
  const rel = path.relative(root, dir);
  write(root, `${rel}/proposal.md`, '## Зачем\n2FA');
  write(root, `${rel}/specs/auth/spec.md`, DELTA);
  write(root, `${rel}/tasks.md`, '- [x] 1.1 x\n');
  const c = loadChange(dir);
  c.phase = 'deliver';
  saveChange(dir, c);
  return { config, adapter, dir };
}

describe('атомарная архивация', () => {
  it('пустой каталог архива от прерванной попытки удаляется, требования не задваиваются', async () => {
    const root = tempProject('openspec-project');
    const { config, adapter, dir } = deliverable(root);
    const stale = path.join(root, 'openspec/changes/archive/2026-09-18-arch/runs/r3');
    fs.mkdirSync(stale, { recursive: true });
    expect(isEmptyTree(path.join(root, 'openspec/changes/archive/2026-09-18-arch'))).toBe(true);
    const result = await archiveChange(root, config, adapter, dir, loadChange(dir), { date: '2026-09-18' });
    expect(result.cleanedStaleArchive).toBe(true);
    const spec = read(root, 'openspec/specs/auth/spec.md');
    expect(spec.split('### Requirement: Two-Factor Authentication').length - 1).toBe(1);
    expect(checkOpenSpecTruth([parseSpecFile(spec, 'auth', 'x')])).toEqual([]);
  });

  it('runs/ не переносится в архив, archive.runs: true оставляет', async () => {
    for (const keep of [false, true]) {
      const root = tempProject('openspec-project');
      const { config, adapter, dir } = deliverable(root, keep ? 'keep' : 'drop');
      config.archive.runs = keep;
      const rel = path.relative(root, dir);
      write(root, `${rel}/runs/r1/result.md`, 'ответ');
      write(root, `${rel}/runs/r1/receipt.json`, '{"id":"r1"}');
      const result = await archiveChange(root, config, adapter, dir, loadChange(dir), { date: '2026-09-18' });
      expect(fs.existsSync(path.join(result.archivedTo, 'runs'))).toBe(keep);
      expect(fs.existsSync(path.join(result.archivedTo, 'change.yaml'))).toBe(true);
    }
  });

  it('непустой каталог архива останавливает доставку до применения дельт: истина не тронута', async () => {
    const root = tempProject('openspec-project');
    const { config, adapter, dir } = deliverable(root);
    const before = read(root, 'openspec/specs/auth/spec.md');
    write(root, 'openspec/changes/archive/2026-09-18-arch/change.yaml', 'id: другое\n');
    await expect(archiveChange(root, config, adapter, dir, loadChange(dir), { date: '2026-09-18' })).rejects.toThrow(/ARCHIVE_EXISTS|не пуст/);
    expect(read(root, 'openspec/specs/auth/spec.md')).toBe(before);
    expect(fs.existsSync(dir)).toBe(true);
    expect(loadChange(dir).phase).toBe('deliver');
  });

  it('повторное применение ADDED идемпотентно, конфликт содержимого это ошибка', () => {
    const truth = read(path.join(import.meta.dirname, 'fixtures/openspec-project'), 'openspec/specs/auth/spec.md');
    const { delta } = parseOpenSpecDelta(DELTA, 'auth', 'd.md', new Set(['auth']));
    const once = applyOpenSpecDelta(truth, delta);
    const twice = applyOpenSpecDelta(once, delta);
    expect(twice).toBe(once);
    const conflict = parseOpenSpecDelta(DELTA.replace('support TOTP', 'support SMS'), 'auth', 'd.md', new Set(['auth']));
    expect(() => applyOpenSpecDelta(once, conflict.delta)).toThrow(/DELTA_ADD_CONFLICT/);
  });

  it('сбой после применения откатывает истину и оставляет изменение на месте', async () => {
    const root = tempProject('openspec-project');
    const { config, adapter, dir } = deliverable(root);
    const before = read(root, 'openspec/specs/auth/spec.md');
    const broken: SpecAdapter = {
      ...adapter,
      name: adapter.name,
      readTruth: () => adapter.readTruth(),
      readDelta: (d) => adapter.readDelta(d),
      validate: (t, d) => adapter.validate(t, d),
      targets: (t, d) => adapter.targets(t, d),
      checkTruth: (t) => adapter.checkTruth(t),
      instructions: () => adapter.instructions(),
      async apply(t, d) {
        const files = await adapter.apply(t, d);
        // Испорченный результат: блок продублирован, постусловие должно сработать.
        const file = path.join(root, 'openspec/specs/auth/spec.md');
        const text = fs.readFileSync(file, 'utf8');
        const dup = '### Requirement: Two-Factor Authentication\ndup\n\n#### Scenario: x\n- **WHEN** a\n- **THEN** b\n\n';
        fs.writeFileSync(file, text.replace('## Notes', `${dup}## Notes`));
        return files;
      },
    };
    await expect(archiveChange(root, config, broken, dir, loadChange(dir), { date: '2026-09-18' })).rejects.toThrow(/невалидна/);
    expect(read(root, 'openspec/specs/auth/spec.md')).toBe(before);
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(path.join(root, 'openspec/changes/archive/2026-09-18-arch'))).toBe(false);
  });

  it('checkTruth адаптера находит требования вне раздела Requirements', async () => {
    const root = tempProject('openspec-project');
    const adapter = createSpecAdapter(root, loadConfig(root));
    write(root, 'openspec/specs/auth/spec.md', `${read(root, 'openspec/specs/auth/spec.md')}\n### Requirement: Потерянное\nThe system SHALL y.\n\n#### Scenario: s\n- **WHEN** a\n- **THEN** b\n`);
    const codes = adapter.checkTruth(await adapter.readTruth()).map((d) => d.code);
    expect(codes).toContain('TRUTH_REQUIREMENT_OUTSIDE_SECTION');
  });

  it('checkTruth находит задвоенные требования', () => {
    const spec = '# A Specification\n\n## Requirements\n\n### Requirement: X\nThe system SHALL x.\n\n#### Scenario: s\n- **WHEN** a\n- **THEN** b\n\n### Requirement: X\nThe system SHALL x.\n\n#### Scenario: s\n- **WHEN** a\n- **THEN** b\n';
    const codes = checkOpenSpecTruth([parseSpecFile(spec, 'a', 'a/spec.md')]).map((d) => d.code);
    expect(codes).toContain('TRUTH_DUPLICATE_REQUIREMENT');
  });
});
