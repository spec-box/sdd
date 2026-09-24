import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';

/**
 * Защита тестов (docs/design.md, «Тесты как критерий готовности»): при завершении фазы cover
 * снимается снимок содержимого файлов по защищённым шаблонам, а отчёт реализатора сверяется с ним
 * по хешам. Состояние git при этом не важно: тесты могут быть и untracked.
 */
export type ProtectedSnapshot = Record<string, string>;

const IGNORE = ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/coverage/**'];

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Текущие файлы по шаблонам и их хеши. */
export function snapshotProtected(root: string, globs: string[]): ProtectedSnapshot {
  if (globs.length === 0) return {};
  const files = fg.sync(globs, { cwd: root, onlyFiles: true, dot: true, ignore: IGNORE }).sort();
  const out: ProtectedSnapshot = {};
  for (const f of files) out[f] = sha256(path.join(root, f));
  return out;
}

export interface ProtectedViolation {
  path: string;
  kind: 'modified' | 'deleted' | 'added';
}

/** Расхождения текущей рабочей копии со снимком: изменён, удалён или добавлен файл под защитой. */
export function protectedViolations(root: string, globs: string[], snapshot: ProtectedSnapshot): ProtectedViolation[] {
  if (globs.length === 0) return [];
  const current = snapshotProtected(root, globs);
  const out: ProtectedViolation[] = [];
  for (const [p, sha] of Object.entries(snapshot)) {
    if (!(p in current)) out.push({ path: p, kind: 'deleted' });
    else if (current[p] !== sha) out.push({ path: p, kind: 'modified' });
  }
  for (const p of Object.keys(current)) if (!(p in snapshot)) out.push({ path: p, kind: 'added' });
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Изменённые относительно HEAD отслеживаемые файлы (без untracked): запасной путь для изменений без снимка. */
export function trackedChangedFiles(root: string): string[] {
  try {
    const out = execFileSync('git', ['diff', '--name-only', 'HEAD', '--'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
