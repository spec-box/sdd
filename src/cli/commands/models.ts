import { Option, type Command } from 'commander';
import { projectContext, changeContext } from '../context.js';
import { emit, emitError } from '../output.js';
import { ROLE_NAMES, resolveModel, type RunnerName } from '../../core/model-policy.js';

export function registerModels(program: Command): void {
  program.command('models').description('Показать выбранные профили, модели и effort для ролей')
    .addOption(new Option('--runner <name>', 'claude | codex; без флага оба').choices(['claude', 'codex']))
    .option('--change <id>', 'учесть сложность конкретного изменения')
    .action((opts: { runner?: RunnerName; change?: string }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as { json: boolean; cwd?: string };
      try {
        const active = opts.change ? changeContext(g.cwd, opts.change) : undefined;
        const ctx = active ?? projectContext(g.cwd);
        const complexity = active?.change.complexity;
        const runners: RunnerName[] = opts.runner ? [opts.runner] : ['claude', 'codex'];
        const rows = runners.flatMap(runner => ROLE_NAMES.map(role => ({ role, ...resolveModel(ctx.config, runner, role, complexity) })));
        emit(g, { complexity, rows }, d => d.rows.map(r => `${r.runner}\t${r.role}\t${r.profile}\t${r.model}\t${r.effort}`).join('\n'));
      } catch (e) { emitError(g, e); process.exitCode = 1; }
    });
}
