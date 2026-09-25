import path from 'node:path';
import type { Command } from 'commander';
import { installHostMaterials } from '../../adapters/host/index.js';
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
        const result = installHostMaterials(ctx.root, opts.target, ctx.config);
        const files = result.files.map((f) => path.relative(ctx.root, f));
        emit(g, { target: result.target, files, notes: result.notes, claudeMdSnippet: CLAUDE_MD_SNIPPET }, (d) => [`Материалы для ${d.target}:`, ...d.files.map((f) => `  + ${f}`), ...d.notes.map((n) => `  ! ${n}`), '', d.target === 'claude' ? 'Откройте Claude Code в корне проекта и вызовите /sbox-run.' : 'Откройте Codex в корне проекта: скиллы доступны из .agents/skills.', 'Рекомендуемая строка для CLAUDE.md или AGENTS.md проекта:', '', d.claudeMdSnippet].join('\n'));
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });
}
