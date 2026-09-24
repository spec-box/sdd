import path from 'node:path';
import type { Command } from 'commander';
import { SboxError } from '../../core/errors.js';
import { assetsDir, exists, readText, writeText } from '../../core/paths.js';
import { projectContext } from '../context.js';
import { emit, emitError } from '../output.js';

const TARGETS: Record<string, { source: string; target: string }[]> = {
  github: [
    { source: 'github-sbox-run.yml', target: '.github/workflows/sbox-run.yml' },
    { source: 'github-tests.yml', target: '.github/workflows/sbox-tests.yml' },
  ],
  docker: [{ source: 'Dockerfile', target: 'Dockerfile.sbox' }],
};

export function registerCi(program: Command): void {
  const ci = program.command('ci').description('Шаблоны запуска в нейтральной среде');
  ci.command('install')
    .description('Записать шаблоны: github (workflows) или docker (Dockerfile.sbox)')
    .requiredOption('--target <name>', 'github | docker')
    .option('--force', 'перезаписать существующие файлы')
    .action((opts: { target: string; force?: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as { json: boolean; cwd?: string };
      try {
        const ctx = projectContext(g.cwd);
        const files = TARGETS[opts.target];
        if (!files) throw new SboxError('CI_TARGET', `Неизвестная цель ${opts.target}; доступны: ${Object.keys(TARGETS).join(', ')}`);
        const written: string[] = [];
        const skipped: string[] = [];
        for (const f of files) {
          const target = path.join(ctx.root, f.target);
          if (exists(target) && !opts.force) {
            skipped.push(f.target);
            continue;
          }
          writeText(target, readText(path.join(assetsDir(), 'ci', f.source)));
          written.push(f.target);
        }
        emit(g, { target: opts.target, written, skipped }, (d) => [...d.written.map((f) => `  + ${f}`), ...d.skipped.map((f) => `  = ${f} (есть, пропущен)`), '', 'Секреты: ANTHROPIC_API_KEY (ключ Console, не подписка), при необходимости OPENAI_API_KEY.'].join('\n'));
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });
}
