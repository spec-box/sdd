import path from 'node:path';
import { assetsDir, sboxDir, exists, readText } from './paths.js';
import { SboxError } from './errors.js';
import { ROLES, type Role } from './phases.js';
import { parseDoc } from './project-docs.js';

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

function roleFile(root: string, role: Role): string {
  const override = path.join(sboxDir(root), 'roles', `${role}.md`);
  const builtin = path.join(assetsDir(), 'roles', `${role}.md`);
  if (exists(override)) return override;
  if (exists(builtin)) return builtin;
  throw new SboxError('NO_ROLE', `Не найдено определение роли ${role}`);
}

/** Текст роли без фронтматтера: встроенный из assets/roles, заменяется .sbox/roles/<role>.md, дополняется <role>.extra.md. */
export function loadRoleText(root: string, role: Role): string {
  const base = parseDoc(readText(roleFile(root, role))).body.replace(/^\s*\n/, '');
  const extra = path.join(sboxDir(root), 'roles', `${role}.extra.md`);
  return exists(extra) ? `${base.trimEnd()}\n\n${readText(extra)}` : base;
}

/** Описание роли для хоста (фронтматтер `description` файла роли); без него — общая формулировка. */
export function loadRoleDescription(root: string, role: Role): string {
  const fm = parseDoc(readText(roleFile(root, role))).frontmatter;
  return typeof fm.description === 'string' && fm.description.trim() ? fm.description.trim() : `Роль ${role} инструмента @spec-box/sdd. Вызывается только скиллом sbox-run.`;
}
