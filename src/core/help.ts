import fs from 'node:fs';
import path from 'node:path';
import { SboxError } from './errors.js';
import { assetsDir, exists, findProjectRoot, readText, sboxDir } from './paths.js';
import { parseDoc } from './project-docs.js';
import { loadSkills } from './skills.js';

/**
 * Справка по требованию для агентов и людей (docs/design.md, раздел 12). Тема это тело скилла инструмента
 * (`browser`, `contract`, `wiki`, `run`, `approve`) или файл `assets/help/<тема>.md`. Проект заменяет или добавляет
 * тему файлом `.sbox/help/<тема>.md`, скилл — файлом `.sbox/skills/<имя>.md`.
 */
export interface HelpTopic {
  topic: string;
  description: string;
  /** Markdown без фронтматтера. */
  text: string;
  source: 'builtin' | 'project';
  file: string;
}

const SKILL_PREFIX = 'sbox-';
/** Темы, у которых есть собственный бинарник с командой help. */
const TOOL_TOPICS = new Set(['browser', 'contract', 'wiki']);

/** Команда справки для скилла: у инструмента свой бинарник (`sbox-browser help`), у остальных тема sbox (`sbox help <тема>`). */
export function helpCommandFor(skillName: string): string {
  const topic = skillName.startsWith(SKILL_PREFIX) ? skillName.slice(SKILL_PREFIX.length) : skillName;
  return TOOL_TOPICS.has(topic) ? `${skillName} help` : `sbox help ${topic}`;
}

function firstHeading(body: string): string {
  const m = body.match(/^#\s+(.+)$/m);
  return m ? m[1]!.trim() : '';
}

function readHelpDir(dir: string, source: HelpTopic['source']): HelpTopic[] {
  if (!exists(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => {
      const file = path.join(dir, f);
      const doc = parseDoc(readText(file));
      const description = typeof doc.frontmatter.description === 'string' ? doc.frontmatter.description : firstHeading(doc.body);
      return { topic: path.basename(f, '.md'), description, text: doc.body.trim(), source, file };
    });
}

/** Темы справки: встроенные файлы и скиллы, поверх них темы и скиллы проекта, если команда вызвана внутри проекта. */
export function loadHelpTopics(cwd?: string): HelpTopic[] {
  const root = findProjectRoot(cwd ?? process.cwd());
  const byTopic = new Map<string, HelpTopic>();
  for (const t of readHelpDir(path.join(assetsDir(), 'help'), 'builtin')) byTopic.set(t.topic, t);
  for (const s of loadSkills(root)) {
    const topic = s.name.startsWith(SKILL_PREFIX) ? s.name.slice(SKILL_PREFIX.length) : s.name;
    byTopic.set(topic, { topic, description: s.description, text: parseDoc(s.text).body.trim(), source: s.source, file: s.file });
  }
  if (root) for (const t of readHelpDir(path.join(sboxDir(root), 'help'), 'project')) byTopic.set(t.topic, t);
  return [...byTopic.values()].sort((a, b) => a.topic.localeCompare(b.topic));
}

export function findHelpTopic(topics: HelpTopic[], name: string): HelpTopic | null {
  const key = name.startsWith(SKILL_PREFIX) ? name.slice(SKILL_PREFIX.length) : name;
  return topics.find((t) => t.topic === key) ?? null;
}

export function requireHelpTopic(topics: HelpTopic[], name: string): HelpTopic {
  const topic = findHelpTopic(topics, name);
  if (!topic) throw new SboxError('NO_HELP_TOPIC', `Нет темы справки «${name}»`, `Темы: ${topics.map((t) => t.topic).join(', ')}; список с описаниями: sbox help`);
  return topic;
}

/** Указатель тем: одна строка на тему; у инструментов та же справка доступна как `sbox-<тема> help`. */
export function renderHelpIndex(topics: HelpTopic[]): string {
  const lines = ['Справка sbox для агентов и людей. Руководство по теме: sbox help <тема>; опции команды: <инструмент> <команда> --help.', ''];
  for (const t of topics) lines.push(`- ${t.topic}${TOOL_TOPICS.has(t.topic) ? ` (sbox-${t.topic} help)` : ''} — ${t.description}`);
  return lines.join('\n');
}
