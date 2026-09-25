import fs from 'node:fs';
import path from 'node:path';
import { SboxError } from './errors.js';
import { assetsDir, exists, readText, sboxDir } from './paths.js';
import { isRoleName, type Role } from './phases.js';
import { parseDoc } from './project-docs.js';

/**
 * Скилл хоста как данные: файл `<имя>.md` с фронтматтером (`name`, `description`, `metadata.roles`, `metadata.hosts`) и телом.
 * Единый источник для всех хостов: адаптер хоста копирует файл в свою раскладку и подключает ролям из `metadata.roles`.
 */
export interface SkillDefinition {
  name: string;
  description: string;
  /** Роли, в контекст которых хост подставляет скилл при запуске агента. */
  roles: Role[];
  /** Хосты, для которых скилл имеет смысл; пусто — для всех. */
  hosts: string[];
  text: string;
  source: 'builtin' | 'project';
  file: string;
}

function stringList(value: unknown, file: string, field: string): string[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : null;
  if (!list) throw new SboxError('BAD_SKILL', `Скилл ${file}: ${field} должен быть списком или строкой через запятую.`);
  return list.map((v) => String(v).trim()).filter(Boolean);
}

export function parseSkill(text: string, file: string, source: SkillDefinition['source']): SkillDefinition {
  const doc = parseDoc(text);
  if (doc.body === text) throw new SboxError('BAD_SKILL', `Скилл ${file}: нет фронтматтера с name и description.`);
  if (doc.frontmatter.__invalid) throw new SboxError('BAD_SKILL', `Скилл ${file}: фронтматтер не разбирается как YAML.`);
  const fm = doc.frontmatter;
  const expected = path.basename(file, '.md');
  if (fm.name !== expected) throw new SboxError('BAD_SKILL', `Скилл ${file}: name «${String(fm.name ?? '')}» должен совпадать с именем файла «${expected}».`);
  if (typeof fm.description !== 'string' || !fm.description.trim()) throw new SboxError('BAD_SKILL', `Скилл ${file}: нужно непустое description.`);
  const metadata = (fm.metadata && typeof fm.metadata === 'object' ? fm.metadata : {}) as Record<string, unknown>;
  const roles: Role[] = [];
  for (const r of stringList(metadata.roles, file, 'metadata.roles')) {
    if (!isRoleName(r)) throw new SboxError('BAD_SKILL', `Скилл ${file}: неизвестная роль «${r}» в metadata.roles.`);
    roles.push(r);
  }
  return { name: expected, description: fm.description, roles, hosts: stringList(metadata.hosts, file, 'metadata.hosts'), text, source, file };
}

function readDir(dir: string, source: SkillDefinition['source']): SkillDefinition[] {
  if (!exists(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => parseSkill(readText(path.join(dir, f)), path.join(dir, f), source));
}

/** Встроенные скиллы из assets/skills; файл .sbox/skills/<имя>.md заменяет встроенный или добавляет новый. */
export function loadSkills(root: string): SkillDefinition[] {
  const byName = new Map<string, SkillDefinition>();
  for (const s of readDir(path.join(assetsDir(), 'skills'), 'builtin')) byName.set(s.name, s);
  for (const s of readDir(path.join(sboxDir(root), 'skills'), 'project')) byName.set(s.name, s);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function skillsForHost(skills: SkillDefinition[], host: string): SkillDefinition[] {
  return skills.filter((s) => s.hosts.length === 0 || s.hosts.includes(host));
}

export function skillsForRole(skills: SkillDefinition[], role: Role): string[] {
  return skills.filter((s) => s.roles.includes(role)).map((s) => s.name);
}
