import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadChange, runDir, saveChange, type Change } from './change.js';
import { computeChangeSet, isGitRepo } from './changeset.js';
import { acquireLock } from './lock.js';
import { buildPacket, renderPrompt } from './packet.js';
import { nextStep, type NextStep, type Role } from './phases.js';
import { applyReport, changesetExclude } from './report.js';
import { chooseModel, READ_ONLY_ROLES, transportRetryAllowed, type AgentRunner, type RunResponse } from './runner.js';
import { formatDiagnostics } from '../cli/output.js';
import { expandHome, toPosix, writeText } from './paths.js';
import type { Config } from './config.js';
import type { SpecAdapter } from './spec-adapter.js';

export const STOP_FILE = '.stop';

export interface RunOptions {
  root: string;
  config: Config;
  dir: string;
  adapter: SpecAdapter;
  runner: AgentRunner;
  maxRuns?: number;
  maxCostUsd?: number;
  log?: (line: string) => void;
  /** Внешний канал гейтов: вернуть true, если гейт решён и цикл может продолжаться. */
  onGate?: (change: Change) => Promise<boolean>;
}

export type RunEndReason = 'gate' | 'wait' | 'deliver' | 'done' | 'limit' | 'stopped' | 'failed';

export interface RunSummary {
  reason: RunEndReason;
  runs: number;
  costUsd: number;
  next: NextStep;
  change: Change;
}

export function stopRequested(dir: string): boolean {
  return fs.existsSync(path.join(dir, STOP_FILE));
}

export function requestStop(dir: string): void {
  fs.writeFileSync(path.join(dir, STOP_FILE), `${new Date().toISOString()}\n`);
}

export function clearStop(dir: string): void {
  fs.rmSync(path.join(dir, STOP_FILE), { force: true });
}

export function stateDirFor(config: Config, changeId: string, runId: string): string {
  const base = expandHome(config.runner.stateDir);
  return path.join(base, changeId, runId);
}

function workspaceFingerprint(root: string, change: Change, exclude: string[]): string | null {
  if (!isGitRepo(root) || !change.base_revision) return null;
  try {
    return computeChangeSet(root, change.base_revision, exclude).digest;
  } catch {
    return null;
  }
}

/**
 * Headless-цикл (docs/design.md, разделы 4 и 13): выполнять фазы через адаптер среды
 * до гейта, блокера, точки ожидания, лимита, остановки или конца.
 */
export async function runChange(opts: RunOptions): Promise<RunSummary> {
  const { root, config, dir, adapter, runner } = opts;
  const log = opts.log ?? (() => {});
  const maxRuns = opts.maxRuns ?? config.limits.maxRunsPerInvocation;
  const maxCost = opts.maxCostUsd ?? config.limits.maxCostUsdPerInvocation;
  const release = acquireLock(dir, `run:${runner.name}`);
  let runs = 0;
  let costUsd = 0;
  const changeDirRel = toPosix(path.relative(root, dir));
  try {
    for (;;) {
      let change = loadChange(dir);
      if (stopRequested(dir) || change.stop_requested) {
        change.status = 'stopped';
        change.stop_requested = true;
        change.settled = true;
        change.active_run = null;
        saveChange(dir, change, { allowTerminalReopen: true });
        clearStop(dir);
        return { reason: 'stopped', runs, costUsd, next: nextStep(change, config), change };
      }
      const step = nextStep(change, config);
      if (step.kind === 'gate' && opts.onGate) {
        const resolved = await opts.onGate(change);
        if (resolved) {
          log(`✓ гейт ${step.gate} решён через внешний канал`);
          continue;
        }
      }
      if (step.kind !== 'role') {
        const reason: RunEndReason = step.kind === 'gate' ? 'gate' : step.kind === 'wait' ? 'wait' : step.kind === 'deliver' ? 'deliver' : 'done';
        return { reason, runs, costUsd, next: step, change };
      }
      if (runs >= maxRuns) return { reason: 'limit', runs, costUsd, next: step, change };
      if (maxCost !== undefined && costUsd >= maxCost) return { reason: 'limit', runs, costUsd, next: step, change };

      const role: Role = step.role;
      const truthSources = (await adapter.readTruth()).map((c) => c.source ?? c.id);
      const packet = buildPacket({ root, config, change, dir, role, phase: step.phase, adapter, truthSources });
      const rdir = runDir(dir, packet.runId);
      fs.mkdirSync(rdir, { recursive: true });
      const packetJson = JSON.stringify(packet, null, 2);
      writeText(path.join(rdir, 'packet.json'), packetJson);
      const prompt = renderPrompt(packet);
      const { model } = chooseModel(config, runner.name, role, change.complexity);
      const previous = [...change.runs].reverse().find((r) => r.role === role && r.session);
      const resumeSession = runner.supportsResume && previous?.session ? previous.session : undefined;

      change.active_run = packet.runId;
      change.settled = false;
      saveChange(dir, change);
      log(`▶ ${packet.runId} ${role}/${step.phase} модель ${model}${resumeSession ? ' (продолжение сессии)' : ''}`);

      const exclude = changesetExclude(config, changeDirRel);
      const before = workspaceFingerprint(root, change, exclude);
      const abort = new AbortController();
      const stopWatcher = setInterval(() => {
        if (stopRequested(dir)) abort.abort();
      }, 2000);
      let response: RunResponse | null = null;
      let attempt = 0;
      try {
        for (attempt = 1; attempt <= 2; attempt += 1) {
          response = await runner.run({
            role,
            phase: step.phase,
            packet,
            prompt,
            cwd: root,
            model,
            effort: config.runner.efforts[role] ?? config.runner.defaultEffort,
            readOnly: READ_ONLY_ROLES.has(role),
            resumeSession,
            resultFile: path.join(rdir, 'result.md'),
            runDir: rdir,
            stateDir: stateDirFor(config, change.id, `${packet.runId}-${attempt}`),
            signal: abort.signal,
            timeoutMs: config.runner.timeoutMinutes * 60_000,
            idleTimeoutMs: config.runner.idleTimeoutMinutes * 60_000,
          });
          if (response.usable) break;
          const after = workspaceFingerprint(root, change, exclude);
          const unchanged = before === after;
          if (attempt === 1 && transportRetryAllowed(response.failure) && unchanged) {
            log(`↻ ${packet.runId} повтор после сбоя ${response.failure}: ${response.failureMessage ?? ''}`);
            continue;
          }
          break;
        }
      } finally {
        clearInterval(stopWatcher);
      }
      runs += 1;
      if (response?.costUsd) costUsd += response.costUsd;

      change = loadChange(dir);
      change.active_run = null;
      change.settled = true;
      const receipt = {
        runner: runner.name,
        model,
        session: response?.session,
        attempt,
        started: response?.started,
        exitCode: response?.exitCode ?? null,
        costUsd: response?.costUsd,
        promptSha256: createHash('sha256').update(prompt).digest('hex'),
        packetSha256: createHash('sha256').update(packetJson).digest('hex'),
        eventsPath: response?.eventsPath,
        eventsSha256: response?.eventsPath && fs.existsSync(response.eventsPath) ? createHash('sha256').update(fs.readFileSync(response.eventsPath)).digest('hex') : undefined,
        stderrSha256: response?.stderrPath && fs.existsSync(response.stderrPath) ? createHash('sha256').update(fs.readFileSync(response.stderrPath)).digest('hex') : undefined,
        failure: response?.failure,
      };

      if (!response || !response.usable) {
        const failure = response?.failure ?? 'unknown';
        if (failure === 'stopped') {
          change.status = 'stopped';
          change.stop_requested = true;
          change.runs.push({ id: packet.runId, role, phase: step.phase, attempt, status: 'stopped', dir: `runs/${packet.runId}`, runner: runner.name, model, failure });
          saveChange(dir, change, { allowTerminalReopen: true });
          clearStop(dir);
          return { reason: 'stopped', runs, costUsd, next: nextStep(change, config), change };
        }
        change.status = 'blocked';
        change.blocker = { category: 'внешний', message: `Среда ${runner.name} не вернула пригодный ответ (${failure}): ${response?.failureMessage ?? ''}`.trim(), role, phase: step.phase };
        change.runs.push({ id: packet.runId, role, phase: step.phase, attempt, status: 'failed', dir: `runs/${packet.runId}`, runner: runner.name, model, failure });
        writeText(path.join(rdir, 'receipt.json'), `${JSON.stringify({ id: packet.runId, role, phase: step.phase, status: 'failed', ...receipt }, null, 2)}\n`);
        saveChange(dir, change);
        log(`✖ ${packet.runId} сбой среды: ${failure}`);
        return { reason: 'failed', runs, costUsd, next: nextStep(change, config), change };
      }

      let outcome;
      try {
        outcome = await applyReport({ root, config, dir, change, role, phase: step.phase, markdown: response.markdown!, adapter, receipt });
      } catch (e) {
        // Ответ без пригодного блока sbox-result: одна попытка повторить роль с напоминанием о контракте.
        log(`✖ ${packet.runId} ответ не разобран: ${(e as Error).message}`);
        const fresh = loadChange(dir);
        const rejections = (fresh.returns[`${step.phase}:rejections`] ?? 0) + 1;
        fresh.returns[`${step.phase}:rejections`] = rejections;
        if (rejections > config.limits.rejectionsPerPhase) {
          fresh.status = 'parked';
          fresh.blocker = { category: 'внешний', message: `Роль ${role} трижды вернула ответ без блока sbox-result: ${(e as Error).message}`, role, phase: step.phase };
        } else {
          fresh.blocker = { category: 'проверка', message: `Ответ отклонён: ${(e as Error).message}. Заверши ответ блоком sbox-result.`, role, phase: step.phase };
        }
        saveChange(dir, fresh);
        if (fresh.status === 'parked') return { reason: 'wait', runs, costUsd, next: nextStep(fresh, config), change: fresh };
        continue;
      }
      log(`■ ${packet.runId} статус «${outcome.result.status}», ${outcome.phaseCompleted ? 'фаза завершена' : 'фаза не завершена'}`);
      if (outcome.diagnostics.length > 0) log(formatDiagnostics(outcome.diagnostics));

      if (!outcome.phaseCompleted && outcome.diagnostics.some((d) => d.severity === 'error')) {
        // Отчёт отклонён детерминированной проверкой: роль получает диагностику как фидбэк, лимит отклонений ограничен.
        const fresh = loadChange(dir);
        const rejections = (fresh.returns[`${step.phase}:rejections`] ?? 0) + 1;
        fresh.returns[`${step.phase}:rejections`] = rejections;
        const text = outcome.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code}: ${d.message}${d.fix ? ` (${d.fix})` : ''}`).join(' | ');
        if (rejections > config.limits.rejectionsPerPhase) {
          fresh.status = 'parked';
          fresh.blocker = { category: 'проверка', message: `Отчёт роли ${role} отклонён ${rejections} раз: ${text}`, role, phase: step.phase };
          saveChange(dir, fresh);
          return { reason: 'wait', runs, costUsd, next: nextStep(fresh, config), change: fresh };
        }
        fresh.blocker = { category: 'проверка', message: text, role, phase: step.phase };
        saveChange(dir, fresh);
        continue;
      }
    }
  } finally {
    release();
  }
}
