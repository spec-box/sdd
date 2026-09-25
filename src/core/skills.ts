import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { SboxError } from './errors.js';
import { assetsDir, exists, readText, sboxDir } from './paths.js';
import { isRoleName, type Role } from './phases.js';

/**
 * Скилл хоста как данные: файл `<имя>.md` с фронтматтером (`name`, `description`, `metadata.roles`) и телом.
 * Единый источник для всех хостов: адаптер хоста копирует файл в свою раскладку и подключает ролям из `metadata.roles`.
 */
export interface SkillDefinition {
  name: string;
  description: string;
  /** Роли, в контекст которых хост подставляет скилл при запуске агента. */
  roles: Role[];
  text: string;
  source: 'builtin' | 'project';
  file: string;
}

export function parseSkill(text: string, file: string, source: SkillDefinition['source']): SkillDefinition {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) throw new SboxError('BAD_SKILL', `Скилл ${file}: нет фронтматтера с name и description.`);
  let fm: Record<string, unknown>;
  try {
    fm = (YAML.parse(m[1]!) as Record<string, unknown>) ?? {};
  } catch (e) {
    throw new SboxError('BAD_SKILL', `Скилл ${file}: фронтматтер не разбирается: ${(e as Error).message}`);
  }
  const expected = path.basename(file, '.md');
  if (fm.name !== expected) throw new SboxError('BAD_SKILL', `Скилл ${file}: name «${String(fm.name ?? '')}» должен совпадать с именем файла «${expected}».`);
  if (typeof fm.description !== 'string' || !fm.description.trim()) throw new SboxError('BAD_SKILL', `Скилл ${file}: нужно непустое description.`);
  const metadata = (fm.metadata ?? {}) as Record<string, unknown>;
  const rawRoles = Array.isArray(metadata.roles) ? metadata.roles : [];
  const roles: Role[] = [];
  for (const r of rawRoles) {
    if (typeof r !== 'string' || !isRoleName(r)) throw new SboxError('BAD_SKILL', `Скилл ${file}: неизвестная роль «${String(r)}» в metadata.roles.`);
    roles.push(r);
  }
  return { name: expected, description: fm.description, roles, text, source, file };
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

export function skillsForRole(skills: SkillDefinition[], role: Role): string[] {
  return skills.filter((s) => s.roles.includes(role)).map((s) => s.name);
}
