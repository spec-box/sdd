import path from 'node:path';
import { intOption } from '../args.js';
import type { Command } from 'commander';
import { createChange, listChanges, saveChange, type Size } from '../../core/change.js';
import { SboxError } from '../../core/errors.js';
import { exists, readText, writeText } from '../../core/paths.js';
import { nextStep, resumeChange } from '../../core/phases.js';
import { clearStop } from '../../core/run.js';
import { artifactStates, loadWorkflow } from '../../core/schema.js';
import { changeContext, projectContext } from '../context.js';
import { emit, emitError } from '../output.js';
import { registerRate } from './metrics.js';

export function registerChange(program: Command): void {
  const change = program.command('change').description('Жизненный цикл изменения');

  change
    .command('new <id>')
    .description('Создать изменение (фаза intake)')
    .requiredOption('--title <title>', 'название')
    .option('--request <text>', 'описание фичи текстом')
    .option('--file <path>', 'описание фичи из файла')
    .option('--tracker <key>', 'ключ тикета')
    .option('--size <size>', 'small | normal | large')
    .option('--autonomy <profile>', 'supervised | checkpoint | autonomous')
    .action((id: string, opts: { title: string; request?: string; file?: string; tracker?: string; size?: string; autonomy?: string }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as { json: boolean; cwd?: string };
      try {
        const ctx = projectContext(g.cwd);
        let request = opts.request ?? '';
        if (opts.file) {
          const file = path.resolve(opts.file);
          if (!exists(file)) throw new SboxError('NO_FILE', `Нет файла ${file}`);
          request = readText(file);
        }
        if (!request.trim()) throw new SboxError('NO_REQUEST', 'Нужно описание фичи: --request или --file.');
        const result = createChange(ctx.root, ctx.config, {
          id,
          title: opts.title,
          request,
          source: opts.tracker ? { kind: 'tracker', ref: opts.tracker } : opts.file ? { kind: 'file', ref: opts.file } : { kind: 'text' },
          ...(opts.size ? { size: opts.size as Size } : {}),
          ...(opts.autonomy ? { autonomy: opts.autonomy as 'supervised' | 'checkpoint' | 'autonomous' } : {}),
        });
        if (ctx.config.spec.adapter === 'openspec') {
          writeText(path.join(result.dir, '.openspec.yaml'), `schema: spec-driven\ncreated: ${result.change.created}\nskip_specs: false\n`);
        }
        emit(g, { id, dir: path.relative(ctx.root, result.dir), change: result.change }, (d) => `Создано изменение ${d.id} в ${d.dir}. Дальше: \`sbox next --change ${d.id}\`.`);
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });

  change
    .command('resume [id]')
    .description('Продолжить изменение после parked, blocked, stopped, delivery_unknown или waiting_user')
    .option('--returns <n>', 'новый лимит возвратов в фазу (для parked)', intOption)
    .option('--comment <text>', 'ответ человека на блокер; попадёт в фидбэк роли')
    .action((id: string | undefined, opts: { returns?: number; comment?: string }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as { json: boolean; cwd?: string };
      try {
        const ctx = changeContext(g.cwd, id);
        const phase = resumeChange(ctx.change, ctx.config, { returns: opts.returns, comment: opts.comment });
        saveChange(ctx.dir, ctx.change, { allowTerminalReopen: true });
        clearStop(ctx.dir);
        emit(g, { id: ctx.change.id, phase, status: ctx.change.status, returns_limit: ctx.change.returns_limit, next: nextStep(ctx.change, ctx.config) }, (d) => `Изменение ${d.id} продолжено: фаза ${d.phase}, статус ${d.status}${d.returns_limit ? `, лимит возвратов ${d.returns_limit}` : ''}.`);
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });

  registerRate(change);

  change
    .command('list')
    .description('Активные изменения')
    .action((_opts: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals() as { json: boolean; cwd?: string };
      try {
        const ctx = projectContext(g.cwd);
        const items = listChanges(ctx.root, ctx.config).map(({ id, change: c }) => ({ id, title: c.title, phase: c.phase, status: c.status, size: c.size }));
        emit(g, { changes: items }, (d) => (d.changes.length === 0 ? 'Активных изменений нет.' : d.changes.map((c) => `${c.id}\t${c.phase}\t${c.status}\t${c.title}`).join('\n')));
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });

  change
    .command('show [id]')
    .description('Состояние изменения и артефактов')
    .action((id: string | undefined, _opts: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals() as { json: boolean; cwd?: string };
      try {
        const ctx = changeContext(g.cwd, id);
        const states = artifactStates(loadWorkflow(ctx.root), ctx.change, ctx.dir).map((s) => ({ id: s.id, phase: s.phase, status: s.status, files: s.existing.map((f) => path.relative(ctx.root, f)) }));
        emit(g, { change: ctx.change, artifacts: states, next: nextStep(ctx.change, ctx.config) }, (d) =>
          [
            `${d.change.id}: ${d.change.title}`,
            `фаза ${d.change.phase}, статус ${d.change.status}, размер ${d.change.size}`,
            ...(d.change.blocker ? [`блокер: ${d.change.blocker.category} — ${d.change.blocker.message}`] : []),
            'артефакты:',
            ...d.artifacts.map((a) => `  ${a.id.padEnd(10)} ${a.status.padEnd(8)} ${a.files.join(', ')}`),
            `дальше: ${JSON.stringify(d.next)}`,
          ].join('\n'),
        );
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });
}
