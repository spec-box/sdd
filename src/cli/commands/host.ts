import path from 'node:path';
import type { Command } from 'commander';
import { installClaudeMaterials } from '../../adapters/host/claude/index.js';
import { SboxError } from '../../core/errors.js';
import { projectContext } from '../context.js';
import { emit, emitError } from '../output.js';

const CLAUDE_MD_SNIPPET = `## Изменения через @spec-box/sdd
Продуктовые изменения ведутся инструментом @spec-box/sdd: \`sbox change new <id> --title "..." --request "..."\`, затем скилл \`/sbox-run\`.
Не редактируй артефакты в .sbox/changes вручную и не меняй истину спецификаций напрямую: только дельты через роли.`;

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
        if (opts.target !== 'claude') throw new SboxError('HOST_NOT_READY', `Хост ${opts.target} ещё не поддержан; доступен claude.`);
        const files = installClaudeMaterials(ctx.root, ctx.config).map((f) => path.relative(ctx.root, f));
        emit(g, { target: opts.target, files, claudeMdSnippet: CLAUDE_MD_SNIPPET }, (d) => [`Материалы для ${d.target}:`, ...d.files.map((f) => `  + ${f}`), '', 'Откройте Claude Code в корне проекта и вызовите /sbox-run.', 'Рекомендуемая строка для CLAUDE.md или AGENTS.md проекта:', '', d.claudeMdSnippet].join('\n'));
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });
}
