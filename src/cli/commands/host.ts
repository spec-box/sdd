import { assetsDir, readText } from '../../core/paths.js';
import path from 'node:path';
import type { Command } from 'commander';
import { installHostMaterials } from '../../adapters/host/index.js';
import { projectContext } from '../context.js';
import { emit, emitError } from '../output.js';

export function registerHost(program: Command): void {
  const host = program.command('host').description('Материалы для хостов разработчика');
  host
    .command('install')
    .description('Сгенерировать скиллы и агентов для хоста')
    .requiredOption('--target <name>', 'claude | codex')
    .action((opts: { target: string }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as { json: boolean; cwd?: string };
      try {
        const ctx = projectContext(g.cwd);
        const result = installHostMaterials(ctx.root, opts.target, ctx.config);
        const files = result.files.map((f) => path.relative(ctx.root, f));
        const claudeMdSnippet = opts.target === 'claude' ? readText(path.join(assetsDir(), 'hosts', 'claude', 'project.md')).trim() : undefined;
        emit(g, { claudeMdSnippet, target: result.target, files, notes: result.notes, next: result.next }, (d) => [`Материалы для ${d.target}:`, ...d.files.map((f) => `  + ${f}`), ...d.notes.map((n) => `  ! ${n}`), '', d.next, ...(d.claudeMdSnippet ? ['Рекомендуемая строка для CLAUDE.md проекта:', '', d.claudeMdSnippet] : [])].join('\n'));
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });
}
