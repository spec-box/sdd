import path from 'node:path';
import type { Command } from 'commander';
import { coverageSummary, matchCoverage, readCoverage } from '../../core/coverage.js';
import { readTestReport, type TestCase } from '../../core/test-reports.js';
import { changeContext } from '../context.js';
import { emit, emitError } from '../output.js';

type Globals = { json: boolean; cwd?: string };

export function registerCoverage(program: Command): void {
  program
    .command('coverage')
    .description('Покрытие утверждений дельт автотестами по coverage.yaml и отчётам тестов')
    .option('--change <id>')
    .option('--report <spec...>', 'отчёты вида kind=path: jest=reports/jest.json playwright=reports/pw.json')
    .option('--strict', 'выход 1, если есть red, missing или unlisted')
    .action(async (opts: { change?: string; report?: string[]; strict?: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as Globals;
      try {
        const ctx = changeContext(g.cwd, opts.change);
        const coverage = readCoverage(ctx.dir);
        const deltas = await ctx.adapter.readDelta(path.join(ctx.dir, 'specs'));
        let report: TestCase[] | null = null;
        if (opts.report && opts.report.length > 0) {
          report = [];
          for (const spec of opts.report) {
            const [kind, file] = spec.split('=');
            if (!kind || !file) throw new Error(`Ожидается kind=path, получено ${spec}`);
            report.push(...readTestReport(kind, path.resolve(ctx.root, file)));
          }
        }
        const rows = matchCoverage(coverage, deltas, report);
        const summary = coverageSummary(rows);
        const bad = summary.red + summary.missing + summary.unlisted;
        emit(g, { rows, summary, report: report ? report.length : null }, (d) =>
          [
            ...d.rows.map((r) => `${{ green: '✓', red: '✗', missing: '?', manual: 'M', unlisted: '!' }[r.state]} ${r.capability} › ${r.requirement} › ${r.scenario}${r.tests.length ? ` [${r.tests.map((t) => `${t.level ?? 'test'}:${t.status}`).join(', ')}]` : ''}${r.manual ? ` (manual: ${r.manual})` : ''}`),
            `итого: зелёных ${d.summary.green}, красных ${d.summary.red}, без теста в отчёте ${d.summary.missing}, ручных ${d.summary.manual}, не описано ${d.summary.unlisted}`,
          ].join('\n'),
        );
        if (opts.strict && bad > 0) process.exitCode = 1;
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });
}
