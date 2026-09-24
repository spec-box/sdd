import path from 'node:path';
import type { Command } from 'commander';
import { deliverChange, readinessChecklist } from '../../core/deliver.js';
import { loadChange, saveChange } from '../../core/change.js';
import { pollPullRequestGate } from '../../core/gates.js';
import { createRepoHost } from '../../core/repo-host.js';
import { SboxError } from '../../core/errors.js';
import { changeContext } from '../context.js';
import { emit, emitError, formatDiagnostics } from '../output.js';

type Globals = { json: boolean; cwd?: string };

export function registerDeliver(program: Command): void {
  program
    .command('deliver')
    .description('Проверить готовность к влитию, заархивировать, закоммитить, запушить и открыть или обновить пул-реквест')
    .option('--change <id>')
    .option('--adapter <name>', 'адаптер репозитория: github | local (по умолчанию из конфига)')
    .option('--check', 'только показать чеклист готовности')
    .option('--keep-draft', 'оставить пул-реквест черновиком')
    .option('--force', 'доставить, даже если чеклист готовности не выполнен; невыполненные пункты останутся в описании пул-реквеста')
    .action(async (opts: { change?: string; adapter?: string; check?: boolean; keepDraft?: boolean; force?: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as Globals;
      try {
        const ctx = changeContext(g.cwd, opts.change);
        if (opts.check) {
          const { dod, diagnostics } = await readinessChecklist(ctx.root, ctx.config, ctx.dir, ctx.change, ctx.adapter);
          emit(g, { ready: diagnostics.length === 0, dod, diagnostics }, (d) => [...d.dod.map((i) => `[${i.ok ? 'x' : ' '}] ${i.id}. ${i.text}${i.detail ? ` (${i.detail})` : ''}`), d.ready ? 'Готово к доставке.' : formatDiagnostics(d.diagnostics)].join('\n'));
          if (diagnostics.length > 0) process.exitCode = 1;
          return;
        }
        const host = createRepoHost(ctx.root, ctx.config, opts.adapter);
        const result = await deliverChange({ ...ctx, host, keepDraft: opts.keepDraft, force: opts.force, log: (l) => process.stderr.write(`${l}\n`) });
        emit(g, { archivedTo: path.relative(ctx.root, result.archivedTo), commit: result.receipt.commit, pushed: result.receipt.pushed, pr: result.receipt.pr, reused: result.receipt.reused, dod: result.dod }, (d) => [`Архив: ${d.archivedTo}`, `Коммит: ${d.commit}${d.reused.commit ? ' (существующий)' : ''}`, d.pr ? `Пул-реквест: ${d.pr.url}${d.pr.draft ? ' (черновик)' : ''}` : 'Пул-реквест не создан (локальный адаптер)'].join('\n'));
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });

  const gates = program.command('gates').description('Каналы гейтов');
  gates
    .command('poll')
    .description('Опубликовать вопрос гейта в пул-реквесте и применить найденный ответ')
    .option('--change <id>')
    .action(async (opts: { change?: string }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as Globals;
      try {
        const ctx = changeContext(g.cwd, opts.change);
        if (!ctx.config.gates.channels.includes('pr-comments')) throw new SboxError('CHANNEL_DISABLED', 'Канал pr-comments не включён в gates.channels.');
        const host = createRepoHost(ctx.root, ctx.config);
        const branch = ctx.change.branch ?? `${ctx.config.repo.branchPrefix}${ctx.change.id}`;
        let pr = await host.findPullRequest(branch);
        if (!pr) {
          host.ensureBranch(branch, ctx.config.repo.baseBranch);
          host.commitAll(`sbox: черновик изменения ${ctx.change.id}`, `${ctx.change.id}:draft`);
          host.push(branch);
          pr = await host.openPullRequest({ branch, base: ctx.config.repo.baseBranch, title: `[sbox] ${ctx.change.title}`, body: `Черновик изменения \`${ctx.change.id}\`. Гейты решаются командами в комментариях.`, draft: true });
          const c = loadChange(ctx.dir);
          c.branch = branch;
          c.pr = { number: pr.number, url: pr.url, draft: true };
          saveChange(ctx.dir, c);
        }
        const outcome = await pollPullRequestGate(ctx.root, ctx.config, ctx.dir, host, pr);
        emit(g, { pr: pr.url, posted: outcome.posted, applied: outcome.applied }, (d) => `${d.pr}: ${d.posted ? 'вопрос опубликован; ' : ''}${d.applied ? `применено ${d.applied.action} ${d.applied.gate} от ${d.applied.author}` : 'ответа пока нет'}`);
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });
}
