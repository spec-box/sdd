import fs from 'node:fs';
import path from 'node:path';
import { SboxError } from './errors.js';

export const LOCK_FILE = '.lock';

interface LockRecord {
  pid: number;
  owner: string;
  started: string;
}

/** Жив ли процесс: EPERM означает, что процесс есть, но принадлежит другому пользователю. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readLock(dir: string): LockRecord | null {
  const file = path.join(dir, LOCK_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as LockRecord;
  } catch {
    return null;
  }
}

/**
 * Эксклюзивная блокировка папки изменения (docs/design.md, «Файл change.yaml»).
 * Мёртвый владелец (pid не жив) считается устаревшей блокировкой и снимается.
 */
export function acquireLock(dir: string, owner: string): () => void {
  const file = path.join(dir, LOCK_FILE);
  const existing = readLock(dir);
  if (existing && pidAlive(existing.pid)) {
    throw new SboxError('CHANGE_BUSY', `Изменение занято процессом ${existing.pid} (${existing.owner}) с ${existing.started}.`, 'Дождитесь завершения или остановите его командой `sbox stop`.');
  }
  if (existing) fs.rmSync(file, { force: true });
  const record: LockRecord = { pid: process.pid, owner, started: new Date().toISOString() };
  const fd = fs.openSync(file, 'wx');
  fs.writeSync(fd, JSON.stringify(record));
  fs.closeSync(fd);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = readLock(dir);
    if (current && current.pid === process.pid) fs.rmSync(file, { force: true });
  };
}

export function withLock<T>(dir: string, owner: string, fn: () => T | Promise<T>): Promise<T> {
  const release = acquireLock(dir, owner);
  return Promise.resolve()
    .then(fn)
    .finally(release);
}
