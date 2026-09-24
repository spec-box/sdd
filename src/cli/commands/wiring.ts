import path from 'node:path';
import type { Command } from 'commander';
import { SboxError } from '../../core/errors.js';
import { exists, readText } from '../../core/paths.js';
import { parseAnalogFromDesign, wiringGaps } from '../../core/wiring.js';
import { changeContext, projectContext } from '../context.js';
import { emit, emitError } from '../output.js';

export function registerWiring(program: Command): void {
  program
    .command('wiring')
    .description('Проверить, что новый модуль подключён везде, где подключён модуль-образец (по design.md или флагам)')
    .option('--change <id>')
    .option('--analog <id>', 'идентификатор образца, как он встречается в коде и конфигах')
    .option('--new <id>', 'идентификатор нового модуля')
    .option('--except <files...>', 'файлы, где регистрация не нужна')
    .action((opts: { change?: string; analog?: string; new?: string; except?: string[] }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as { json: boolean; cwd?: string };
      try {
        let analog = opts.analog;
        let fresh = opts.new;
        let exceptions = opts.except ?? [];
        let root: string;
        if (analog && fresh) root = projectContext(g.cwd).root;
        else {
          const ctx = changeContext(g.cwd, opts.change);
          root = ctx.root;
          const designFile = path.join(ctx.dir, 'design.md');
          const parsed = exists(designFile) ? parseAnalogFromDesign(readText(designFile)) : null;
          if (!parsed) throw new SboxError('NO_ANALOG', 'В design.md нет строк «Образец: `X`» и «Новый модуль: `Y`».', 'Укажите --analog и --new или добавьте строки в раздел «Единообразие».');
          analog = parsed.analog;
          fresh = parsed.fresh;
          exceptions = exceptions.length ? exceptions : parsed.exceptions;
        }
        const result = wiringGaps(root, analog!, fresh!, exceptions);
        emit(g, result, (d) => [
          `Образец ${d.analog} зарегистрирован в ${d.registrationFiles.length} файлах вне своего каталога:`,
          ...d.registrationFiles.map((f) => `  ${d.gaps.some((x) => x.file === f) ? '✗' : '✓'} ${f}`),
          d.gaps.length ? `Нет регистрации нового модуля ${d.fresh}: ${d.gaps.map((x) => x.file).join(', ')}` : `Новый модуль ${d.fresh} подключён везде.`,
        ].join('\n'));
        if (result.gaps.length > 0) process.exitCode = 1;
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });
}
