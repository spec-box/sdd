import path from 'node:path';
import type { Command } from 'commander';
import { archiveChange } from '../../core/archive.js';
import { SboxError } from '../../core/errors.js';
import { changeContext, projectContext } from '../context.js';
import { emit, emitError, formatDiagnostics } from '../output.js';

type Globals = { json: boolean; cwd?: string };

export function registerSpec(program: Command): void {
  const spec = program.command('spec').description('Истина спецификаций через адаптер');

  spec
    .command('list')
    .description('Список capability')
    .action(async (_opts: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals() as Globals;
      try {
        const ctx = projectContext(g.cwd);
        const truth = await ctx.adapter.readTruth();
        const items = truth.map((c) => ({ id: c.id, title: c.title, requirements: c.requirements.length, scenarios: c.requirements.reduce((n, r) => n + r.scenarios.length, 0), source: c.source }));
        emit(g, { adapter: ctx.adapter.name, capabilities: items }, (d) => d.capabilities.map((c) => `${c.id}\t${c.title}\t${c.requirements} групп, ${c.scenarios} утверждений\t${c.source ?? ''}`).join('\n') || 'Спецификаций нет.');
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });

  spec
    .command('show <id>')
    .description('Capability целиком')
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals() as Globals;
      try {
        const ctx = projectContext(g.cwd);
        const cap = (await ctx.adapter.readTruth()).find((c) => c.id === id);
        if (!cap) throw new SboxError('NO_CAPABILITY', `Capability ${id} не найдена`, 'Список: `sbox spec list`.');
        emit(g, { capability: cap }, (d) => [`# ${d.capability.title} (${d.capability.id})`, d.capability.purpose ?? '', ...d.capability.requirements.flatMap((r) => [`## ${r.title}`, ...r.scenarios.map((s) => `- ${s.title}${s.description ? `\n  ${s.description.replace(/\n/g, '\n  ')}` : ''}`)])].join('\n'));
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });

  spec
    .command('diff')
    .description('Дельты изменения относительно истины')
    .option('--change <id>')
    .action(async (opts: { change?: string }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as Globals;
      try {
        const ctx = changeContext(g.cwd, opts.change);
        const truth = await ctx.adapter.readTruth();
        const deltas = await ctx.adapter.readDelta(path.join(ctx.dir, 'specs'));
        const diagnostics = ctx.adapter.validate(truth, deltas);
        emit(g, { deltas, diagnostics }, (d) =>
          [
            ...d.deltas.map((delta) => [`# ${delta.capabilityId}${delta.isNew ? ' (новая)' : ''} — ${delta.source}`, ...delta.ops.map((op) => op.op === 'add-requirement' ? `+ ${op.requirement.title} (${op.requirement.scenarios.length})` : op.op === 'modify-requirement' ? `~ ${op.requirement.title} (${op.requirement.scenarios.length})` : op.op === 'remove-requirement' ? `- ${op.requirementTitle}${op.scenarios ? ` [${op.scenarios.length} утв.]` : ''}` : `→ ${op.from} ⇒ ${op.to}`)].join('\n')),
            '',
            formatDiagnostics(d.diagnostics),
          ].join('\n'),
        );
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });

  program
    .command('archive')
    .description('Применить дельты к истине и перенести изменение в архив')
    .option('--change <id>')
    .option('--force', 'применить несмотря на ошибки валидации')
    .action(async (opts: { change?: string; force?: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as Globals;
      try {
        const ctx = changeContext(g.cwd, opts.change);
        if (ctx.change.phase !== 'deliver' && !opts.force) {
          throw new SboxError('NOT_DELIVERABLE', `Изменение в фазе ${ctx.change.phase}, а не deliver.`, 'Доведите изменение до фазы deliver или используйте --force.');
        }
        const result = await archiveChange(ctx.root, ctx.config, ctx.adapter, ctx.dir, ctx.change, { force: opts.force });
        emit(g, { archivedTo: path.relative(ctx.root, result.archivedTo), appliedFiles: result.appliedFiles, diagnostics: result.diagnostics }, (d) => [`Архив: ${d.archivedTo}`, ...d.appliedFiles.map((f) => `  ~ ${f}`), formatDiagnostics(d.diagnostics)].join('\n'));
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });
}
