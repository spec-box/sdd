import type { Command } from 'commander';
import { findHelpTopic, loadHelpTopics, renderHelpIndex, requireHelpTopic } from '../core/help.js';

export interface HelpCommandOptions {
  /** Тема инструмента для вызова без аргумента (`sbox-browser help`); у sbox без аргумента печатается указатель тем. */
  topic?: string;
  cwd: () => string | undefined;
  emit: (payload: Record<string, unknown>, human: string) => void;
}

/**
 * Команда `help [тема|команда]` вместо встроенной commander: без аргумента руководство инструмента (у sbox указатель тем),
 * с темой — руководство, с именем подкоманды без такой темы — её опции. Один текст для Claude Code, Codex и человека.
 */
export function attachHelpCommand(program: Command, opts: HelpCommandOptions): void {
  program.helpCommand(false);
  program
    .command('help [topic]')
    .description(opts.topic ? 'Справка для агентов: руководство по инструменту; help <команда> покажет опции команды, sbox help — все темы' : 'Справка для агентов и людей: указатель тем; help <тема> покажет руководство, help <команда> — опции команды')
    .action((topic: string | undefined) => {
      const topics = loadHelpTopics(opts.cwd());
      if (topic && !findHelpTopic(topics, topic)) {
        const sub = program.commands.find((c) => c.name() === topic || c.aliases().includes(topic));
        if (sub) {
          sub.outputHelp();
          return;
        }
      }
      const name = topic ?? opts.topic;
      if (!name) {
        opts.emit({ topics: topics.map((t) => ({ topic: t.topic, description: t.description, source: t.source })) }, renderHelpIndex(topics));
        return;
      }
      const t = requireHelpTopic(topics, name);
      opts.emit({ topic: t.topic, description: t.description, source: t.source, file: t.file, text: t.text }, `${t.text}\n\nОпции команд: ${program.name()} <команда> --help. Все темы: sbox help.`);
    });
}
