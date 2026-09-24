import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import '../src/adapters/spec/index.js';
import { createChange, loadChange } from '../src/core/change.js';
import { loadConfig } from '../src/core/config.js';
import { requestStop, runChange } from '../src/core/run.js';
import { createSpecAdapter } from '../src/core/spec-adapter.js';
import type { AgentRunner, RunRequest, RunResponse } from '../src/core/runner.js';
import { RESULT, read, tempProject, write } from './helpers.js';

/** Фейковая среда: отвечает по сценарию, записывая ответ в resultFile. */
function fakeRunner(script: ((req: RunRequest) => Partial<RunResponse> & { markdown?: string | null })[]): AgentRunner & { calls: RunRequest[] } {
  const calls: RunRequest[] = [];
  return {
    name: 'fake',
    supportsResume: true,
    calls,
    async run(req) {
      calls.push(req);
      const step = script[Math.min(calls.length - 1, script.length - 1)]!(req);
      const started = new Date().toISOString();
      if (step.markdown) {
        fs.mkdirSync(path.dirname(req.resultFile), { recursive: true });
        fs.writeFileSync(req.resultFile, step.markdown);
      }
      return { usable: Boolean(step.markdown), markdown: step.markdown ?? null, started, finished: new Date().toISOString(), session: `s-${calls.length}`, costUsd: 0.1, ...step };
    },
  };
}

describe('headless-цикл', () => {
  it('прогоняет роли до гейта и записывает receipt', async () => {
    const root = tempProject();
    const config = loadConfig(root);
    const adapter = createSpecAdapter(root, config);
    const { dir } = createChange(root, config, { id: 'hl', title: 'Поиск', request: 'поиск' });
    const rel = path.relative(root, dir);
    const runner = fakeRunner([
      (req) => {
        write(root, `${rel}/evidence/research.md`, '# Evidence');
        expect(req.role).toBe('researcher');
        expect(req.readOnly).toBe(true);
        return { markdown: RESULT('готово') };
      },
      () => {
        write(root, `${rel}/proposal.md`, '## Зачем\nпоиск');
        return { markdown: RESULT('утверждение', 'size: normal\ncomplexity: { implementation: обычная, review: обычная }\n') };
      },
    ]);
    const log: string[] = [];
    const summary = await runChange({ root, config, dir, adapter, runner, log: (l) => log.push(l) });
    expect(summary.reason).toBe('gate');
    expect(summary.runs).toBe(2);
    expect(summary.next).toMatchObject({ kind: 'gate', gate: 'proposal' });
    const change = loadChange(dir);
    expect(change.runs.map((r) => r.role)).toEqual(['researcher', 'planner']);
    expect(change.settled).toBe(true);
    expect(fs.existsSync(path.join(dir, 'runs', 'r1', 'receipt.json'))).toBe(true);
    const receipt = JSON.parse(read(root, `${rel}/runs/r1/receipt.json`));
    expect(receipt.runner).toBe('fake');
    expect(receipt.packet_sha256).toHaveLength(64);
    expect(fs.existsSync(path.join(dir, '.lock'))).toBe(false);
  });

  it('повторяет один раз при транспортном сбое, а при втором блокирует', async () => {
    const root = tempProject();
    const config = loadConfig(root);
    const adapter = createSpecAdapter(root, config);
    const { dir } = createChange(root, config, { id: 'retry', title: 't', request: 'r' });
    const runner = fakeRunner([() => ({ markdown: null, failure: 'transport', failureMessage: 'ECONNRESET' }), () => ({ markdown: null, failure: 'transport', failureMessage: 'ECONNRESET' })]);
    const summary = await runChange({ root, config, dir, adapter, runner });
    expect(runner.calls).toHaveLength(2);
    expect(summary.reason).toBe('failed');
    expect(loadChange(dir).status).toBe('blocked');
    expect(loadChange(dir).blocker?.category).toBe('внешний');
  });

  it('отклонённый отчёт даёт роли фидбэк и повторный запуск, потом паркует', async () => {
    const root = tempProject();
    const config = loadConfig(root);
    const adapter = createSpecAdapter(root, config);
    const { dir } = createChange(root, config, { id: 'rej', title: 't', request: 'r' });
    const runner = fakeRunner([() => ({ markdown: RESULT('готово') })]); // researcher без evidence/research.md? файл создаёт CLI, значит отчёт примется
    // Сделаем planner без proposal.md: отчёт отклоняется ARTIFACT_MISSING
    write(root, `${path.relative(root, dir)}/evidence/research.md`, 'x');
    const r2 = fakeRunner([() => ({ markdown: RESULT('готово') }), () => ({ markdown: RESULT('утверждение') }), () => ({ markdown: RESULT('утверждение') }), () => ({ markdown: RESULT('утверждение') })]);
    const summary = await runChange({ root, config, dir, adapter, runner: r2, maxRuns: 10 });
    expect(summary.reason).toBe('wait');
    expect(loadChange(dir).status).toBe('parked');
    expect(r2.calls.length).toBe(4); // researcher + 3 planner (2 отклонения + третье паркует)
    expect(r2.calls[2]!.packet.feedback).toMatch(/ARTIFACT_MISSING/);
    void runner;
  });

  it('запрос остановки завершает цикл со статусом stopped', async () => {
    const root = tempProject();
    const config = loadConfig(root);
    const adapter = createSpecAdapter(root, config);
    const { dir } = createChange(root, config, { id: 'stop', title: 't', request: 'r' });
    requestStop(dir);
    const runner = fakeRunner([() => ({ markdown: RESULT('готово') })]);
    const summary = await runChange({ root, config, dir, adapter, runner });
    expect(summary.reason).toBe('stopped');
    expect(loadChange(dir).status).toBe('stopped');
    expect(runner.calls).toHaveLength(0);
  });
});
