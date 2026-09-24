import path from 'node:path';
import type { Command } from 'commander';
import { hasErrors, type Diagnostic } from '../../core/diagnostics.js';
import { SboxError } from '../../core/errors.js';
import { exists, readText, toPosix } from '../../core/paths.js';
import { nextStep } from '../../core/phases.js';
import { artifactInstructions, artifactStates, loadWorkflow } from '../../core/schema.js';
import { taskProgress } from '../../core/tasks.js';
import { changeContext } from '../context.js';
import { emit, emitError, formatDiagnostics } from '../output.js';

type Globals = { json: boolean; cwd?: string };

export function registerArtifacts(program: Command): void {
  program
    .command('status')
    .description('Состояние изменения: фаза, гейты, артефакты, задачи')
    .option('--change <id>')
    .action((opts: { change?: string }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as Globals;
      try {
        const ctx = changeContext(g.cwd, opts.change);
        const states = artifactStates(loadWorkflow(ctx.root), ctx.change, ctx.dir).map((s) => ({ id: s.id, phase: s.phase, status: s.status, files: s.existing.map((f) => toPosix(path.relative(ctx.root, f))) }));
        const tasksFile = path.join(ctx.dir, 'tasks.md');
        const tasks = exists(tasksFile) ? taskProgress(readText(tasksFile)) : null;
        const c = ctx.change;
        emit(g, { id: c.id, revision: c.revision, phase: c.phase, status: c.status, settled: c.settled, active_run: c.active_run, size: c.size, gates: c.gates, blocker: c.blocker, protected: c.protected, changeset: c.changeset, reviewed_digest: c.reviewed_digest, verification: c.verification ? { run: c.verification.run, checks: c.verification.checks.length, failed: c.verification.checks.filter((x) => x.result === 'FAIL').length, gaps: c.verification.gaps.length } : null, delivery: c.delivery, returns: c.returns, runs: c.runs.length, artifacts: states, tasks, next: nextStep(c, ctx.config) }, (d) =>
          [`${d.id}: фаза ${d.phase}, статус ${d.status}, размер ${d.size}, ревизия ${d.revision}${d.settled ? '' : `, активен запуск ${d.active_run}`}`, ...d.artifacts.map((a) => `  ${a.id.padEnd(10)} ${a.status.padEnd(8)} ${a.files.join(', ')}`), d.tasks ? `задачи: ${d.tasks.done}/${d.tasks.total}` : 'задачи: нет tasks.md', d.changeset ? `change-set: ${d.changeset.paths} файлов, ${d.changeset.digest.slice(0, 23)}…${d.reviewed_digest === d.changeset.digest ? ' (ревью привязано)' : ''}` : 'change-set: не запечатан', ...(d.blocker ? [`блокер: ${d.blocker.category} — ${d.blocker.message}`] : []), `дальше: ${JSON.stringify(d.next)}`].join('\n'),
        );
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });

  program
    .command('instructions <artifact>')
    .description('Инструкция, шаблон и путь для артефакта изменения')
    .option('--change <id>')
    .action((artifact: string, opts: { change?: string }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as Globals;
      try {
        const ctx = changeContext(g.cwd, opts.change);
        const extra = artifact === 'specs' ? ctx.adapter.instructions() : undefined;
        const ins = artifactInstructions(ctx.root, ctx.config, loadWorkflow(ctx.root), ctx.change, ctx.dir, artifact, extra);
        if (!ins) throw new SboxError('NO_ARTIFACT', `Артефакт ${artifact} не описан в схеме`);
        emit(g, ins, (d) => [`# ${d.artifact} (фаза ${d.phase}, статус ${d.status})`, `Файл: ${d.resolvedOutputPath}`, '', d.instruction, '', d.template ? `## Шаблон\n\n${d.template}` : ''].join('\n'));
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });

  program
    .command('validate')
    .description('Проверить артефакты и дельты изменения')
    .option('--change <id>')
    .action(async (opts: { change?: string }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as Globals;
      try {
        const ctx = changeContext(g.cwd, opts.change);
        const diagnostics: Diagnostic[] = [];
        const states = artifactStates(loadWorkflow(ctx.root), ctx.change, ctx.dir);
        for (const s of states) {
          if (s.status === 'blocked') diagnostics.push({ severity: 'info', code: 'ARTIFACT_BLOCKED', message: `Артефакт ${s.id} ждёт: ${s.requires.join(', ')}`, target: s.id });
        }
        if (!ctx.change.skip_specs) {
          const truth = await ctx.adapter.readTruth();
          const deltas = await ctx.adapter.readDelta(path.join(ctx.dir, 'specs'));
          if (deltas.length === 0 && states.find((s) => s.id === 'proposal')?.status === 'done') {
            diagnostics.push({ severity: 'warning', code: 'DELTA_MISSING', message: 'Дельт в specs/ нет; если поведение не меняется, задайте skip_specs: true', target: 'specs' });
          }
          diagnostics.push(...ctx.adapter.validate(truth, deltas));
        }
        const tasksFile = path.join(ctx.dir, 'tasks.md');
        if (exists(tasksFile) && taskProgress(readText(tasksFile)).total === 0) {
          diagnostics.push({ severity: 'error', code: 'TASKS_EMPTY', message: 'В tasks.md нет ни одного флажка `- [ ]`', target: 'tasks.md' });
        }
        const ok = !hasErrors(diagnostics);
        emit(g, { valid: ok, diagnostics }, (d) => `${formatDiagnostics(d.diagnostics)}\n${d.valid ? 'Валидно.' : 'Есть ошибки.'}`);
        if (!ok) process.exitCode = 1;
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });
}
