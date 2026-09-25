import type { Command } from 'commander';
import { intOption } from '../args.js';
import { loadChange, saveChange } from '../../core/change.js';
import { SboxError } from '../../core/errors.js';
import { allChangeDirs, changeMetrics, findChangeDir, summarize } from '../../core/metrics.js';
import { projectContext } from '../context.js';
import { emit, emitError } from '../output.js';

type Globals = { json: boolean; cwd?: string };

export function registerMetrics(program: Command): void {
  program
    .command('metrics')
    .description('Метрики работы решателя: время, запуски, стоимость, возвраты, вмешательства, оценки')
    .option('--change <id>', 'одно изменение (активное или архивное)')
    .action((opts: { change?: string }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as Globals;
      try {
        const ctx = projectContext(g.cwd);
        const dirs = opts.change ? [findChangeDir(ctx.root, ctx.config, opts.change)].filter((d): d is string => Boolean(d)) : allChangeDirs(ctx.root, ctx.config);
        if (opts.change && dirs.length === 0) throw new SboxError('NO_CHANGE', `Изменение ${opts.change} не найдено ни среди активных, ни в архиве`);
        const all = dirs.map((d) => changeMetrics(d, loadChange(d)));
        const summary = summarize(all);
        emit(g, { changes: all, summary }, (d) =>
          [
            ...d.changes.map((m) => [
              `${m.id} (${m.status}, ${m.size}): запусков ${m.runs}, агенты ${m.agent_minutes} мин, стоимость ${m.cost_usd === null ? 'н/д' : `$${m.cost_usd}`}, вмешательств ${m.interventions.total}${m.autonomous ? ' (автономно)' : ''}${m.rating ? `, оценка ${m.rating.score}/5` : ''}`,
              ...Object.entries(m.phases).map(([ph, p]) => `    ${ph.padEnd(13)} запусков ${p.runs}, ${Math.round(p.agent_minutes)} мин${p.returns ? `, возвратов ${p.returns}` : ''}${p.rejections ? `, отклонений ${p.rejections}` : ''}`),
              ...Object.entries(m.gates).map(([gate, x]) => `    гейт ${gate.padEnd(9)} ${x.state}${x.wait_minutes !== null ? `, ожидание ${Math.round(x.wait_minutes)} мин` : ''}${x.rejected_times ? `, отклонён ${x.rejected_times} раз` : ''}`),
            ].join('\n')),
            '',
            `итого: изменений ${d.summary.changes}, завершено ${d.summary.finished}, автономно ${d.summary.autonomous_share === null ? 'н/д' : `${Math.round(d.summary.autonomous_share * 100)}%`}, медиана времени агентов ${d.summary.median_agent_minutes ?? 'н/д'} мин, медиана запусков ${d.summary.median_runs ?? 'н/д'}, стоимость ${d.summary.total_cost_usd === null ? 'н/д' : `$${d.summary.total_cost_usd}`}, средняя оценка ${d.summary.mean_rating ?? 'н/д'}, вмешательств на изменение ${d.summary.interventions_per_change ?? 'н/д'}`,
          ].join('\n'),
        );
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });
}

export function registerRate(change: Command): void {
  change
    .command('rate <id>')
    .description('Оценка результата человеком после проверки: 1–5 и комментарий')
    .requiredOption('--score <n>', '1 (переделывать) … 5 (принял без правок)', intOption)
    .option('--comment <text>')
    .action((id: string, opts: { score: number; comment?: string }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as Globals;
      try {
        const ctx = projectContext(g.cwd);
        const dir = findChangeDir(ctx.root, ctx.config, id);
        if (!dir) throw new SboxError('NO_CHANGE', `Изменение ${id} не найдено`);
        if (!(opts.score >= 1 && opts.score <= 5)) throw new SboxError('BAD_SCORE', 'Оценка от 1 до 5');
        const c = loadChange(dir);
        c.rating = { score: opts.score, at: new Date().toISOString(), ...(opts.comment ? { comment: opts.comment } : {}) };
        saveChange(dir, c, { allowTerminalReopen: true });
        emit(g, { id, rating: c.rating }, (d) => `Оценка ${d.rating.score}/5 записана для ${d.id}.`);
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });
}
