import path from 'node:path';
import type { Command } from 'commander';
import { archiveChange } from '../../core/archive.js';
import { SboxError } from '../../core/errors.js';
import { changeContext } from '../context.js';
import { emit, emitError, formatDiagnostics } from '../output.js';

type Globals = { json: boolean; cwd?: string };

export function registerArchive(program: Command): void {
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
