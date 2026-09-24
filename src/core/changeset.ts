import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { SboxError } from './errors.js';
import { toPosix } from './paths.js';

/** Запечатанный change-set (docs/design.md, раздел 6): реальные пути и дайджест рабочей копии относительно базы. */
export interface ChangeSetFile {
  path: string;
  status: 'A' | 'M' | 'D' | 'R' | 'U';
  sha256: string | null;
}

export interface ChangeSet {
  version: 1;
  base: string;
  sealed_at: string;
  sealed_after: string | null;
  digest: string;
  paths: number;
  files: ChangeSetFile[];
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

export function isGitRepo(root: string): boolean {
  try {
    git(root, ['rev-parse', '--is-inside-work-tree']);
    return true;
  } catch {
    return false;
  }
}

export function headRevision(root: string): string | null {
  try {
    return git(root, ['rev-parse', 'HEAD']).trim();
  } catch {
    return null;
  }
}

function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Изменённые файлы относительно базовой ревизии: закоммиченные в ветке, staged, unstaged и новые.
 * Папка самого изменения и другие пути из exclude не учитываются.
 */
export function computeChangeSet(root: string, base: string, exclude: string[] = []): Omit<ChangeSet, 'sealed_at' | 'sealed_after'> {
  if (!isGitRepo(root)) throw new SboxError('NO_GIT', 'Change-set требует git-репозитория.');
  const skip = exclude.length > 0 ? picomatch(exclude, { dot: true }) : () => false;
  const entries = new Map<string, ChangeSetFile['status']>();
  const diff = git(root, ['diff', '--name-status', '-M', base, '--']);
  for (const line of diff.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const code = parts[0]![0] as ChangeSetFile['status'];
    const file = parts[parts.length - 1]!;
    entries.set(file, code === 'R' ? 'R' : code);
  }
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard']);
  for (const line of untracked.split('\n')) {
    if (line.trim()) entries.set(line.trim(), 'A');
  }
  const files: ChangeSetFile[] = [...entries.entries()]
    .filter(([p]) => !skip(p))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([p, status]) => {
      const abs = path.join(root, p);
      const exists = fs.existsSync(abs) && fs.statSync(abs).isFile();
      return { path: toPosix(p), status: exists ? status : 'D', sha256: exists ? sha256File(abs) : null };
    });
  const digest = createHash('sha256');
  for (const f of files) digest.update(`${f.status} ${f.path} ${f.sha256 ?? '-'}\n`);
  return { version: 1, base, digest: `sha256:${digest.digest('hex')}`, paths: files.length, files };
}

export function sealChangeSet(root: string, base: string, exclude: string[], sealedAfter: string | null): ChangeSet {
  const computed = computeChangeSet(root, base, exclude);
  return { ...computed, sealed_at: new Date().toISOString(), sealed_after: sealedAfter };
}

export function writeChangeSet(dir: string, changeset: ChangeSet): string {
  const file = path.join(dir, 'changeset.json');
  fs.writeFileSync(file, `${JSON.stringify(changeset, null, 2)}\n`);
  return file;
}

export function readChangeSet(dir: string): ChangeSet | null {
  const file = path.join(dir, 'changeset.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as ChangeSet;
}

/** Сверка: совпадает ли текущая рабочая копия с запечатанным дайджестом. */
export function changeSetDrift(root: string, sealed: ChangeSet, exclude: string[]): { drifted: boolean; currentDigest: string; added: string[]; removed: string[]; modified: string[] } {
  const current = computeChangeSet(root, sealed.base, exclude);
  const before = new Map(sealed.files.map((f) => [f.path, f.sha256]));
  const after = new Map(current.files.map((f) => [f.path, f.sha256]));
  const added = [...after.keys()].filter((p) => !before.has(p));
  const removed = [...before.keys()].filter((p) => !after.has(p));
  const modified = [...after.keys()].filter((p) => before.has(p) && before.get(p) !== after.get(p));
  return { drifted: current.digest !== sealed.digest, currentDigest: current.digest, added, removed, modified };
}

export interface DriftClassification {
  invalidating: string[];
  benign: string[];
}

/** Делит дрейф на файлы, отменяющие вердикт, и безобидные (по шаблонам nonInvalidating). */
export function classifyDrift(drift: { added: string[]; removed: string[]; modified: string[] }, nonInvalidating: string[]): DriftClassification {
  const all = [...drift.added, ...drift.removed, ...drift.modified];
  const isBenign = nonInvalidating.length > 0 ? picomatch(nonInvalidating, { dot: true }) : () => false;
  return { invalidating: all.filter((p) => !isBenign(p)), benign: all.filter((p) => isBenign(p)) };
}
