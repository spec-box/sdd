import path from 'node:path';
import { assetsDir, sboxDir, exists, readText } from './paths.js';
import { SboxError } from './errors.js';
import { ROLES, type Role } from './phases.js';

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** Текст роли: встроенный из assets/roles, заменяется .sbox/roles/<role>.md, дополняется <role>.extra.md. */
export function loadRoleText(root: string, role: Role): string {
  const override = path.join(sboxDir(root), 'roles', `${role}.md`);
  const builtin = path.join(assetsDir(), 'roles', `${role}.md`);
  const base = exists(override) ? readText(override) : exists(builtin) ? readText(builtin) : null;
  if (base === null) throw new SboxError('NO_ROLE', `Не найдено определение роли ${role}`);
  const extra = path.join(sboxDir(root), 'roles', `${role}.extra.md`);
  return exists(extra) ? `${base.trimEnd()}\n\n${readText(extra)}` : base;
}
