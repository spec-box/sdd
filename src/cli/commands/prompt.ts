import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { SboxError } from '../../core/errors.js';
import { assetsDir, readText } from '../../core/paths.js';
import { projectContext } from '../context.js';
import { emit, emitError } from '../output.js';

const PROMPTS: Record<string, { file: string; description: string }> = {
  'project-docs': { file: 'fill-project-docs.md', description: 'Заполнить .sbox/project/*.md по коду репозитория' },
};

/** Подстановки под адаптер спецификаций проекта. */
function substitutions(adapter: string): Record<string, string> {
  if (adapter === 'openspec') {
    return {
      SPEC_CHAIN: '«название capability › требование › сценарий» из `openspec/specs/<capability>/spec.md` (заголовки `# … Specification`, `### Requirement:`, `#### Scenario:`)',
      SPEC_TRUTH: 'формат OpenSpec, файлы `openspec/specs/<capability>/spec.md`',
    };
  }
  return {
    SPEC_CHAIN: '«название фичи › группа › утверждение» из YAML spec-box (поля `feature`, ключ группы в `specs-unit`, `assert`)',
    SPEC_TRUTH: 'формат spec-box, YAML-файлы по шаблонам из `.tms.json` или `spec.spec-box.files`',
  };
}

export function renderPrompt(name: string, adapter: string): string {
  const entry = PROMPTS[name];
  if (!entry) throw new SboxError('NO_PROMPT', `Нет промпта ${name}; доступны: ${Object.keys(PROMPTS).join(', ')}`);
  const subs = substitutions(adapter);
  return readText(path.join(assetsDir(), 'prompts', entry.file)).replace(/\{\{(\w+)\}\}/g, (_m, key: string) => subs[key] ?? `{{${key}}}`);
}

export function registerPrompt(program: Command): void {
  const prompt = program.command('prompt').description('Готовые промпты для хоста разработчика');
  prompt
    .command('list')
    .description('Список промптов')
    .action((_opts: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals() as { json: boolean };
      emit(g, { prompts: Object.entries(PROMPTS).map(([name, p]) => ({ name, description: p.description })) }, (d) => d.prompts.map((p) => `${p.name}\t${p.description}`).join('\n'));
    });
  prompt
    .command('show <name>')
    .description('Напечатать промпт с формулировками под адаптер проекта')
    .option('--adapter <name>', 'spec-box | openspec (по умолчанию из конфига проекта)')
    .action((name: string, opts: { adapter?: string }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as { json: boolean; cwd?: string };
      try {
        let adapter = opts.adapter;
        if (!adapter) {
          try {
            adapter = projectContext(g.cwd).config.spec.adapter;
          } catch {
            adapter = 'spec-box';
          }
        }
        const text = renderPrompt(name, adapter);
        if (g.json) emit(g, { name, adapter, text }, () => text);
        else process.stdout.write(`${text.trimEnd()}\n`);
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });
}

export { fs };
