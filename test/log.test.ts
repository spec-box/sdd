import path from 'node:path';
import { describe, expect, it } from 'vitest';
import '../src/adapters/spec/index.js';
import { createChange, loadChange } from '../src/core/change.js';
import { loadConfig } from '../src/core/config.js';
import { appendLogEntry, LOG_ENTRY_MAX, parseLog } from '../src/core/log.js';
import { buildPacket } from '../src/core/packet.js';
import { createSpecAdapter } from '../src/contract/adapter.js';
import { read, tempProject, write } from './helpers.js';

describe('журнал изменения', () => {
  it('добавляет однострочную запись с тегом, датой и автором', () => {
    const root = tempProject();
    const config = loadConfig(root);
    const { dir } = createChange(root, config, { id: 'lg', title: 'Ж', request: 'r' });
    const rel = path.relative(root, dir);
    const res = appendLogEntry(dir, loadChange(dir), { tag: 'code', text: '  th-ui 0.13.0\n уже содержит исправление  (package.json) ', by: 'planner r2', date: '2026-09-28' });
    expect(res.line).toBe('- [CODE] 2026-09-28 planner r2: th-ui 0.13.0 уже содержит исправление (package.json)');
    const log = read(root, `${rel}/log.md`);
    expect(log).toMatch(/^---\nchange: lg\n---\n/);
    expect(log).toMatch(/\n- \[CODE\] 2026-09-28 planner r2: th-ui 0\.13\.0 уже содержит исправление \(package\.json\)\n$/);
    expect(parseLog(log)).toEqual([{ tag: 'CODE', date: '2026-09-28', by: 'planner r2', text: 'th-ui 0.13.0 уже содержит исправление (package.json)' }]);
    appendLogEntry(dir, loadChange(dir), { tag: 'RULE', text: 'второй', by: 'dima', date: '2026-09-28' });
    expect(parseLog(read(root, `${rel}/log.md`)).map((e) => e.tag)).toEqual(['CODE', 'RULE']);
  });

  it('автор по умолчанию: роль и номер выданного пакета, иначе пользователь; пакет несёт команду и правило', () => {
    const root = tempProject();
    const config = loadConfig(root);
    const adapter = createSpecAdapter(root, config);
    const { dir } = createChange(root, config, { id: 'au', title: 'А', request: 'r' });
    const rel = path.relative(root, dir);
    const human = appendLogEntry(dir, loadChange(dir), { tag: 'HUMAN', text: 'без пакета' });
    expect(human.entry.by).toBe(process.env.USER ?? 'human');
    const packet = buildPacket({ root, config, change: loadChange(dir), dir, role: 'researcher', phase: 'research', adapter, truthSources: [] });
    write(root, `${rel}/runs/${packet.runId}/packet.json`, JSON.stringify(packet));
    expect(packet.commands.log).toBe('sbox log add --change au --tag CODE "<факт с путём>"');
    expect(packet.commands.report).toBeUndefined();
    expect(packet.constraints.join(' ')).toContain('запись [CODE] сильнее');
    const role = appendLogEntry(dir, loadChange(dir), { tag: 'CODE', text: 'из пакета' });
    expect(role.entry.by).toBe('researcher r1');
  });

  it('отклоняет чужой тег, пустую и слишком длинную запись', () => {
    const root = tempProject();
    const config = loadConfig(root);
    const { dir } = createChange(root, config, { id: 'bad', title: 'Б', request: 'r' });
    const change = loadChange(dir);
    expect(() => appendLogEntry(dir, change, { tag: 'NOTE', text: 'x' })).toThrow(/Неизвестный тег/);
    expect(() => appendLogEntry(dir, change, { tag: 'CODE', text: '  \n ' })).toThrow(/Пустая/);
    expect(() => appendLogEntry(dir, change, { tag: 'CODE', text: 'x'.repeat(LOG_ENTRY_MAX + 1) })).toThrow(/длиннее/);
  });
});
