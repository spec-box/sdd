import path from 'node:path';
import { SboxError } from './errors.js';
import { exists, readText, today, writeText } from './paths.js';
import type { Change } from './change.js';

/** Теги журнала изменения (docs/design.md, «Журналы»): [TASK] событие, [CODE] факт о коде, [RULE] правило, [HUMAN] предпочтение. */
export const LOG_TAGS = ['CODE', 'RULE', 'TASK', 'HUMAN'] as const;
export type LogTag = (typeof LOG_TAGS)[number];
/** Запись это один факт с путём, а не абзац: лимит держит журнал читаемым для каждой следующей роли. */
export const LOG_ENTRY_MAX = 300;

export interface LogEntry {
  tag: LogTag;
  date: string;
  by: string;
  text: string;
}

const ENTRY_RE = /^- \[(CODE|RULE|TASK|HUMAN)\] (\d{4}-\d{2}-\d{2}) ([^:]+): (.+)$/;

export function logHeader(changeId: string): string {
  return `---\nchange: ${changeId}\n---\n\n# Журнал — ${changeId}\n\n<!-- [TASK] событие | [CODE] факт о коде | [RULE] правило | [HUMAN] предпочтение -->\n`;
}

export function logFile(dir: string): string {
  return path.join(dir, 'log.md');
}

export function formatLogEntry(e: LogEntry): string {
  return `- [${e.tag}] ${e.date} ${e.by}: ${e.text}`;
}

export function parseLog(markdown: string): LogEntry[] {
  const out: LogEntry[] = [];
  for (const line of markdown.split('\n')) {
    const m = line.match(ENTRY_RE);
    if (m) out.push({ tag: m[1] as LogTag, date: m[2]!, by: m[3]!, text: m[4]! });
  }
  return out;
}

/** Автор записи по умолчанию: роль и номер выданного, но ещё не сданного пакета; без пакета — пользователь. */
export function defaultLogAuthor(dir: string, change: Change): string {
  const runId = `r${change.runs.length + 1}`;
  const packet = path.join(dir, 'runs', runId, 'packet.json');
  if (exists(packet)) {
    try {
      const role = (JSON.parse(readText(packet)) as { role?: string }).role;
      if (role) return `${role} ${runId}`;
    } catch {
      // пакет не разобран: автор ниже
    }
  }
  return process.env.USER ?? 'human';
}

export interface LogInput {
  tag: string;
  text: string;
  by?: string;
  date?: string;
}

/** Добавляет запись в log.md изменения: одна строка, схлопнутые пробелы, лимит длины; файл создаётся, если его нет. */
export function appendLogEntry(dir: string, change: Change, input: LogInput): { file: string; line: string; entry: LogEntry } {
  const tag = input.tag.toUpperCase();
  if (!(LOG_TAGS as readonly string[]).includes(tag)) throw new SboxError('BAD_LOG_TAG', `Неизвестный тег ${input.tag}; допустимы: ${LOG_TAGS.join(', ')}`);
  const text = input.text.replace(/\s+/g, ' ').trim();
  if (!text) throw new SboxError('LOG_EMPTY', 'Пустая запись журнала');
  if (text.length > LOG_ENTRY_MAX) {
    throw new SboxError('LOG_TOO_LONG', `Запись длиннее ${LOG_ENTRY_MAX} знаков (${text.length})`, 'Один факт с путём на запись; подробности остаются в артефакте или evidence.');
  }
  const by = (input.by ?? defaultLogAuthor(dir, change)).replace(/[\s:]+/g, ' ').trim() || 'human';
  const entry: LogEntry = { tag: tag as LogTag, date: input.date ?? today(), by, text };
  const line = formatLogEntry(entry);
  const file = logFile(dir);
  const current = exists(file) ? readText(file) : logHeader(change.id);
  writeText(file, `${current.replace(/\n*$/, '\n')}${line}\n`);
  return { file, line, entry };
}
