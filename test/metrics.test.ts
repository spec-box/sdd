import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import '../src/adapters/spec/index.js';
import { createChange, loadChange, saveChange } from '../src/core/change.js';
import { loadConfig } from '../src/core/config.js';
import { changeMetrics } from '../src/core/metrics.js';
import { applyReport } from '../src/core/report.js';
import { createSpecAdapter } from '../src/core/spec-adapter.js';
import { RESULT, tempProject, write } from './helpers.js';

describe('метрики без папки runs', () => {
  it('запуски, время и стоимость берутся из change.yaml, когда runs/ удалён архивацией', () => {
    const root = tempProject('spec-box-project', { git: false });
    const config = loadConfig(root);
    const { dir } = createChange(root, config, { id: 'metrics-1', title: 'М', request: 'r' });
    const change = loadChange(dir);
    change.runs.push(
      { id: 'r1', role: 'researcher', phase: 'research', attempt: 1, status: 'done', dir: 'runs/r1', started: '2026-09-18T10:00:00.000Z', finished: '2026-09-18T10:06:00.000Z', cost_usd: 0.5 },
      { id: 'r2', role: 'planner', phase: 'propose', attempt: 1, status: 'done', dir: 'runs/r2', started: '2026-09-18T10:10:00.000Z', finished: '2026-09-18T10:13:00.000Z', cost_usd: 0.25 },
    );
    change.status = 'archived';
    saveChange(dir, change);
    fs.rmSync(path.join(dir, 'runs'), { recursive: true, force: true });
    const m = changeMetrics(dir, loadChange(dir));
    expect(m.runs).toBe(2);
    expect(m.agent_minutes).toBe(9);
    expect(m.cost_usd).toBe(0.75);
    expect(m.phases.research?.agent_minutes).toBe(6);
    expect(m.finished).toBe('2026-09-18T10:13:00.000Z');
  });

  it('report записывает время старта по пакету, чтобы метрики не зависели от receipt', async () => {
    const root = tempProject('spec-box-project', { git: false });
    const config = loadConfig(root);
    const adapter = createSpecAdapter(root, config);
    const { dir } = createChange(root, config, { id: 'st', title: 'С', request: 'r' });
    const rel = path.relative(root, dir);
    write(root, `${rel}/runs/r1/packet.json`, '{}');
    write(root, `${rel}/evidence/research.md`, '# Evidence\n');
    await applyReport({ root, config, dir, change: loadChange(dir), role: 'researcher', phase: 'research', markdown: RESULT('готово'), adapter });
    const run = loadChange(dir).runs[0];
    expect(run?.started).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(run?.finished).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
