import path from 'node:path';
import type { Command } from 'commander';
import { saveChange } from '../../core/change.js';
import { changeSetDrift, classifyDrift, isGitRepo, readChangeSet, sealChangeSet, writeChangeSet } from '../../core/changeset.js';
import { SboxError } from '../../core/errors.js';
import { toPosix } from '../../core/paths.js';
import { changesetExclude } from '../../core/report.js';
import { changeContext } from '../context.js';
import { emit, emitError } from '../output.js';

type Globals = { json: boolean; cwd?: string };

export function registerChangeset(program: Command): void {
  const cs = program.command('changeset').description('Запечатанный change-set изменения');

  cs.command('show')
    .description('Показать запечатанный change-set и текущий дрейф')
    .option('--change <id>')
    .action((opts: { change?: string }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as Globals;
      try {
        const ctx = changeContext(g.cwd, opts.change);
        const sealed = readChangeSet(ctx.dir);
        if (!sealed) throw new SboxError('NO_CHANGESET', 'Change-set ещё не запечатан: он создаётся после фазы implement или командой `sbox changeset seal`.');
        const drift = isGitRepo(ctx.root) ? changeSetDrift(ctx.root, sealed, changesetExclude(ctx.config, toPosix(path.relative(ctx.root, ctx.dir)))) : null;
        emit(g, { changeset: sealed, drift, reviewed_digest: ctx.change.reviewed_digest }, (d) => [
          `база ${d.changeset.base.slice(0, 12)}, запечатано после ${d.changeset.sealed_after ?? '—'} в ${d.changeset.sealed_at}`,
          `дайджест ${d.changeset.digest}`,
          ...d.changeset.files.map((f) => `  ${f.status} ${f.path}`),
          d.drift ? (d.drift.drifted ? `ДРЕЙФ: код ${classifyDrift(d.drift, ctx.config.changeset.nonInvalidating).invalidating.join(', ') || '—'}; безобидные ${classifyDrift(d.drift, ctx.config.changeset.nonInvalidating).benign.join(', ') || '—'}` : 'дрейфа нет') : 'дрейф не проверен (не git)',
          d.reviewed_digest === d.changeset.digest ? 'вердикты verify/review привязаны к этому дайджесту' : 'вердикты не привязаны',
        ].join('\n'));
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });

  cs.command('seal')
    .description('Запечатать текущую рабочую копию заново и вернуть изменение в фазу verify')
    .option('--change <id>')
    .action((opts: { change?: string }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as Globals;
      try {
        const ctx = changeContext(g.cwd, opts.change);
        if (!ctx.change.base_revision) throw new SboxError('NO_BASE', 'У изменения нет базовой ревизии.');
        const sealed = sealChangeSet(ctx.root, ctx.change.base_revision, changesetExclude(ctx.config, toPosix(path.relative(ctx.root, ctx.dir))), null);
        writeChangeSet(ctx.dir, sealed);
        ctx.change.changeset = { base: sealed.base, digest: sealed.digest, paths: sealed.paths, sealed_after: null, sealed_at: sealed.sealed_at, rebound: [] };
        ctx.change.reviewed_digest = null;
        if (['review', 'deliver'].includes(ctx.change.phase)) ctx.change.phase = 'verify';
        if (ctx.change.status === 'active' || ctx.change.status === 'blocked') ctx.change.status = 'active';
        saveChange(ctx.dir, ctx.change);
        emit(g, { digest: sealed.digest, paths: sealed.paths, phase: ctx.change.phase }, (d) => `Запечатано: ${d.paths} файлов, ${d.digest}. Фаза ${d.phase}.`);
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });

  cs.command('verify')
    .description('Проверить, что рабочая копия совпадает с запечатанным change-set; выход 1 при дрейфе')
    .option('--change <id>')
    .action((opts: { change?: string }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as Globals;
      try {
        const ctx = changeContext(g.cwd, opts.change);
        const sealed = readChangeSet(ctx.dir);
        if (!sealed) throw new SboxError('NO_CHANGESET', 'Change-set не запечатан.');
        const drift = changeSetDrift(ctx.root, sealed, changesetExclude(ctx.config, toPosix(path.relative(ctx.root, ctx.dir))));
        emit(g, { drifted: drift.drifted, current: drift.currentDigest, sealed: sealed.digest, added: drift.added, removed: drift.removed, modified: drift.modified }, (d) => (d.drifted ? `Дрейф: +${d.added.length} -${d.removed.length} ~${d.modified.length}` : 'Совпадает с запечатанным.'));
        if (drift.drifted) process.exitCode = 1;
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });
}
