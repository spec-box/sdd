import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { loadChange, saveChange, TERMINAL_STATUSES } from '../../core/change.js';
import { readLock } from '../../core/lock.js';
import { nextStep } from '../../core/phases.js';
import { clearStop, requestStop, runChange } from '../../core/run.js';
import { createRunner } from '../../core/runner.js';
import { createRepoHost } from '../../core/repo-host.js';
import { pollPullRequestGate } from '../../core/gates.js';
import { changeContext } from '../context.js';
import { emit, emitError } from '../output.js';

type Globals = { json: boolean; cwd?: string };

const UNSUCCESSFUL = new Set(['parked', 'blocked', 'failed', 'stopped', 'delivery_unknown']);

export function registerRun(program: Command): void {
  program
    .command('run')
    .description('Headless: выполнять фазы через адаптер среды до гейта, блокера, точки ожидания, лимита или конца')
    .option('--change <id>')
    .option('--runner <name>', 'claude | codex (по умолчанию из конфига)')
    .option('--max-runs <n>', 'предел запусков ролей за вызов', (v: string) => Number.parseInt(v, 10))
    .option('--max-cost <usd>', 'предел стоимости за вызов', (v: string) => Number.parseFloat(v))
    .option('--detach', 'запустить в фоне и вернуть управление')
    .action(async (opts: { change?: string; runner?: string; maxRuns?: number; maxCost?: number; detach?: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as Globals;
      try {
        const ctx = changeContext(g.cwd, opts.change);
        if (opts.detach) {
          const logDir = path.join(ctx.dir, 'runs');
          fs.mkdirSync(logDir, { recursive: true });
          const logFile = path.join(logDir, 'run.log');
          const out = fs.openSync(logFile, 'a');
          const args = [process.argv[1]!, '--cwd', ctx.root, 'run', '--change', ctx.change.id, ...(opts.runner ? ['--runner', opts.runner] : []), ...(opts.maxRuns ? ['--max-runs', String(opts.maxRuns)] : [])];
          const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', out, out], cwd: ctx.root });
          child.unref();
          emit(g, { detached: true, pid: child.pid, log: path.relative(ctx.root, logFile) }, (d) => `Запущено в фоне (pid ${d.pid}). Журнал: ${d.log}. Следить: sbox watch --change ${ctx.change.id}`);
          return;
        }
        const runnerName = opts.runner ?? ctx.config.runner.default;
        const runner = createRunner(runnerName, ctx.root, ctx.config);
        const prGate = ctx.config.gates.channels.includes('pr-comments') && ctx.config.repo.adapter !== 'local'
          ? async () => {
              const host = createRepoHost(ctx.root, ctx.config);
              const branch = ctx.change.branch ?? `${ctx.config.repo.branchPrefix}${ctx.change.id}`;
              const pr = await host.findPullRequest(branch);
              if (!pr) return false;
              const outcome = await pollPullRequestGate(ctx.root, ctx.config, ctx.dir, host, pr);
              return outcome.applied !== null;
            }
          : undefined;
        const summary = await runChange({
          root: ctx.root,
          config: ctx.config,
          dir: ctx.dir,
          adapter: ctx.adapter,
          runner,
          maxRuns: opts.maxRuns,
          maxCostUsd: opts.maxCost,
          log: (line) => process.stderr.write(`${line}\n`),
          onGate: prGate,
        });
        emit(g, { reason: summary.reason, runs: summary.runs, cost_usd: summary.costUsd, status: summary.change.status, phase: summary.change.phase, next: summary.next }, (d) =>
          `Остановка: ${d.reason}. Запусков: ${d.runs}, стоимость: $${d.cost_usd.toFixed(2)}. Изменение: фаза ${d.phase}, статус ${d.status}. Дальше: ${JSON.stringify(d.next)}`,
        );
        if (UNSUCCESSFUL.has(summary.change.status) || summary.reason === 'failed') process.exitCode = 1;
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });

  program
    .command('stop')
    .description('Остановить запуск роли и запретить доставку; изменение получает статус stopped')
    .option('--change <id>')
    .option('--wait <seconds>', 'ждать завершения процесса', (v: string) => Number.parseInt(v, 10), 30)
    .action(async (opts: { change?: string; wait: number }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as Globals;
      try {
        const ctx = changeContext(g.cwd, opts.change);
        requestStop(ctx.dir);
        const lock = readLock(ctx.dir);
        if (!lock) {
          // Активного процесса нет: переводим сразу.
          const change = loadChange(ctx.dir);
          change.status = 'stopped';
          change.stop_requested = true;
          change.settled = true;
          change.active_run = null;
          saveChange(ctx.dir, change, { allowTerminalReopen: true });
          clearStop(ctx.dir);
          emit(g, { stopped: true, immediate: true }, () => 'Активного запуска не было; изменение переведено в stopped.');
          return;
        }
        const deadline = Date.now() + opts.wait * 1000;
        while (Date.now() < deadline) {
          const change = loadChange(ctx.dir);
          if (change.status === 'stopped' && change.settled) {
            emit(g, { stopped: true, pid: lock.pid }, (d) => `Запуск ${d.pid} остановлен, изменение в stopped.`);
            return;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
        emit(g, { stopped: false, pid: lock.pid }, (d) => `Запрос остановки записан, процесс ${d.pid} ещё не завершился. Проверьте: sbox watch`);
        process.exitCode = 1;
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });

  program
    .command('watch')
    .description('Ждать терминального статуса или остановки на гейте; выход 1 для parked, blocked, failed, stopped, delivery_unknown')
    .option('--change <id>')
    .option('--interval <seconds>', 'период опроса', (v: string) => Number.parseInt(v, 10), 5)
    .option('--timeout <minutes>', 'предел ожидания', (v: string) => Number.parseInt(v, 10), 240)
    .action(async (opts: { change?: string; interval: number; timeout: number }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as Globals;
      try {
        const ctx = changeContext(g.cwd, opts.change);
        const deadline = Date.now() + opts.timeout * 60_000;
        let lastLine = '';
        for (;;) {
          const change = loadChange(ctx.dir);
          const step = nextStep(change, ctx.config);
          const line = `${change.id}: фаза ${change.phase}, статус ${change.status}, запусков ${change.runs.length}${change.active_run ? `, активен ${change.active_run}` : ''}`;
          if (line !== lastLine && !g.json) process.stderr.write(`${line}\n`);
          lastLine = line;
          const noProcess = change.settled && !readLock(ctx.dir);
          if (noProcess && step.kind === 'role' && !TERMINAL_STATUSES.has(change.status)) {
            emit(g, { idle: true, id: change.id, phase: change.phase, status: change.status, next: step }, (d) => `Ничего не запущено: изменение ждёт роль ${JSON.stringify(d.next)}. Запустите sbox run.`);
            process.exitCode = 2;
            return;
          }
          const settledStop = noProcess && (step.kind !== 'role' || TERMINAL_STATUSES.has(change.status));
          if (settledStop) {
            emit(g, { id: change.id, revision: change.revision, phase: change.phase, status: change.status, settled: change.settled, next: step }, (d) => `Завершено: статус ${d.status}, дальше ${JSON.stringify(d.next)}`);
            if (UNSUCCESSFUL.has(change.status)) process.exitCode = 1;
            return;
          }
          if (Date.now() > deadline) {
            emit(g, { timeout: true, status: change.status }, () => 'Время ожидания истекло.');
            process.exitCode = 1;
            return;
          }
          await new Promise((r) => setTimeout(r, opts.interval * 1000));
        }
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });
}
