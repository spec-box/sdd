import fs from 'node:fs';
import path from 'node:path';
import { Command, CommanderError } from 'commander';
import { WikiStore, pageSummary } from './store.js';
import { findProjectRoot, packageVersion } from '../core/paths.js';
import { loadConfig } from '../core/config.js';
import { SboxError } from '../core/errors.js';
import { attachHelpCommand } from '../cli/help-command.js';

export function buildProgram(): Command {
  const program = new Command().name('sbox-wiki').description('Индекс, поиск и страницы локальной Markdown-wiki').version(packageVersion())
    .option('--cwd <dir>', 'каталог проекта', process.cwd()).option('--dir <dir>', 'папка wiki, относительно cwd; без SDD по умолчанию wiki/').option('--json', 'машиночитаемый JSON');
  const store = () => {
    const g = program.opts();
    const cwd = path.resolve(g.cwd);
    const root = findProjectRoot(cwd);
    const dir = g.dir ? path.resolve(cwd, g.dir) : root ? path.resolve(root, loadConfig(root).project.wiki) : path.join(cwd, 'wiki');
    return new WikiStore(dir, root ?? cwd);
  };
  const emit = (value: unknown) => {
    console.log(program.opts().json ? JSON.stringify({ ok: true, data: value }) : typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  };
  program.command('index').description('Компактный индекс без текста страниц').option('--rebuild', 'полностью перечитать Markdown')
    .action(opts => emit(store().pages(opts.rebuild).map(pageSummary)));
  program.command('search [query]').description('Поиск по тексту, метаданным и области кода').option('--path <path>', 'путь к коду относительно проекта').option('--limit <n>', 'максимум результатов', '5')
    .action((query, opts) => emit(store().search(query ?? '', opts.path, Number(opts.limit))));
  program.command('get <page>').description('Прочитать страницу по id или пути').option('--section <section>', 'заголовок или якорь раздела')
    .action((ref, opts) => { const result = store().get(ref, opts.section); emit(program.opts().json ? result : result.content); });
  program.command('put <page>').description('Создать или обновить полную страницу с фронтматтером').requiredOption('--file <file>', 'файл с новым содержимым, - для stdin')
    .option('--if-match <revision>', 'revision из get для обновления').option('--create', 'создать новый путь .md')
    .action((ref, opts) => emit(store().put(ref, fs.readFileSync(opts.file === '-' ? 0 : path.resolve(program.opts().cwd, opts.file), 'utf8'), { create: opts.create, ifMatch: opts.ifMatch })));
  program.command('backlinks <page>').description('Входящие ссылки, включая ссылки на разделы').action(ref => emit(store().backlinks(ref)));
  program.command('validate').description('Проверить метаданные, id, локальные ссылки и якоря').action(() => {
    const diagnostics = store().validate(); emit({ diagnostics });
    if (diagnostics.some(d => d.severity === 'error')) process.exitCode = 1;
  });
  attachHelpCommand(program, { topic: 'wiki', cwd: () => program.opts().cwd as string | undefined, emit: (payload, human) => emit(program.opts().json ? payload : human) });
  return program;
}
export async function main(argv: string[]): Promise<void> {
  const program = buildProgram();
  for (const command of [program, ...program.commands]) {
    command.exitOverride();
    if (argv.includes('--json')) command.configureOutput({ writeErr: () => {} });
  }
  try { await program.parseAsync(argv); }
  catch (e) {
    if (e instanceof CommanderError && e.exitCode === 0) return;
    const error = { code: e instanceof SboxError || e instanceof CommanderError ? e.code : 'WIKI_ERROR', message: e instanceof Error ? e.message : String(e) };
    if (argv.includes('--json')) console.log(JSON.stringify({ ok: false, error }));
    else console.error(`${error.code}: ${error.message}`);
    process.exitCode = 1;
  }
}
