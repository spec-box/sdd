import path from 'node:path';
import type { Command } from 'commander';
import { appendLogEntry, formatLogEntry, LOG_TAGS, logFile, parseLog } from '../../core/log.js';
import { exists, readText, toPosix } from '../../core/paths.js';
import { changeContext } from '../context.js';
import { emit, emitError } from '../output.js';

type Globals = { json: boolean; cwd?: string };

export function registerLog(program: Command): void {
  const log = program.command('log').description('Журнал изменения: тегированные однострочные записи для следующих ролей и distiller');

  log
    .command('add <text>')
    .description(`Добавить запись; теги: ${LOG_TAGS.join(', ')}`)
    .requiredOption('--tag <tag>', 'CODE (факт о коде), RULE (правило), TASK (событие), HUMAN (предпочтение)')
    .option('--change <id>', 'идентификатор изменения')
    .option('--by <who>', 'автор; по умолчанию роль и запуск выданного пакета, иначе пользователь')
    .action((text: string, opts: { tag: string; change?: string; by?: string }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as Globals;
      try {
        const ctx = changeContext(g.cwd, opts.change);
        const res = appendLogEntry(ctx.dir, ctx.change, { tag: opts.tag, text, ...(opts.by ? { by: opts.by } : {}) });
        emit(g, { file: toPosix(path.relative(ctx.root, res.file)), line: res.line, entry: res.entry }, (d) => `${d.file}: ${d.line}`);
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });

  log
    .command('show')
    .description('Показать записи журнала')
    .option('--change <id>', 'идентификатор изменения')
    .option('--tag <tag>', 'только записи с этим тегом')
    .action((opts: { change?: string; tag?: string }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as Globals;
      try {
        const ctx = changeContext(g.cwd, opts.change);
        const file = logFile(ctx.dir);
        const entries = (exists(file) ? parseLog(readText(file)) : []).filter((e) => !opts.tag || e.tag === opts.tag.toUpperCase());
        emit(g, { file: toPosix(path.relative(ctx.root, file)), entries }, (d) => (d.entries.length ? d.entries.map(formatLogEntry).join('\n') : 'Журнал пуст'));
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });
}
