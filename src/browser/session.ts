import fs from 'node:fs';
import path from 'node:path';
import { SboxError } from '../core/errors.js';
import { pidAlive } from '../core/lock.js';
import { browserDirs, ensureDir } from './paths.js';

/** Запись о работающем демоне: по ней клиент находит сокет и проверяет, жив ли процесс. */
export interface SessionInfo {
  name: string;
  pid: number;
  socket: string;
  wsEndpoint: string;
  executable: string;
  headless: boolean;
  profile: string | null;
  viewport: { width: number; height: number };
  startedAt: string;
  cwd: string;
  log: string;
}

const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function assertSessionName(name: string): string {
  if (!NAME.test(name)) throw new SboxError('BROWSER_SESSION_NAME', `Имя сессии «${name}» должно быть из строчных букв, цифр и дефисов.`);
  return name;
}

export function sessionFile(name: string, env?: NodeJS.ProcessEnv): string {
  return path.join(browserDirs.sessions(env), `${name}.json`);
}

export function lockFile(name: string, env?: NodeJS.ProcessEnv): string {
  return path.join(browserDirs.sessions(env), `${name}.lock`);
}

/** Путь сокета: unix-сокет в каталоге сессий, на Windows именованный канал. */
export function socketPath(name: string, env?: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return `\\\\.\\pipe\\sbox-browser-${name}`;
  return path.join(browserDirs.sessions(env), `${name}.sock`);
}

export function isPipe(sock: string): boolean {
  return sock.startsWith('\\\\.\\pipe\\');
}

export const isPidAlive = pidAlive;

export function writeSession(info: SessionInfo, env?: NodeJS.ProcessEnv): string {
  const file = sessionFile(info.name, env);
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(info, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

/** Читает сессию; след мёртвого процесса удаляется, чтобы следующая команда подняла демон заново. */
export function readSession(name: string, env?: NodeJS.ProcessEnv): SessionInfo | null {
  const file = sessionFile(name, env);
  if (!fs.existsSync(file)) return null;
  let info: SessionInfo;
  try {
    info = JSON.parse(fs.readFileSync(file, 'utf8')) as SessionInfo;
  } catch {
    removeSession(name, env);
    return null;
  }
  if (!info.pid || !pidAlive(info.pid)) {
    removeSession(name, env);
    return null;
  }
  return info;
}

export function removeSession(name: string, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): void {
  fs.rmSync(sessionFile(name, env), { force: true });
  const sock = socketPath(name, env, platform);
  if (!isPipe(sock)) fs.rmSync(sock, { force: true });
}

/** Удаляет след сессии, только если он всё ещё принадлежит процессу pid: чужую живую сессию демон не трогает. */
export function removeSessionIfOwned(name: string, pid: number, env?: NodeJS.ProcessEnv): boolean {
  const file = sessionFile(name, env);
  if (fs.existsSync(file)) {
    try {
      const info = JSON.parse(fs.readFileSync(file, 'utf8')) as SessionInfo;
      if (info.pid !== pid) return false;
    } catch {
      /* битый файл: убираем */
    }
  }
  removeSession(name, env);
  return true;
}

export function listSessions(env?: NodeJS.ProcessEnv): SessionInfo[] {
  const dir = browserDirs.sessions(env);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readSession(f.slice(0, -'.json'.length), env))
    .filter((s): s is SessionInfo => s !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface SessionLock {
  pid: number;
  at: string;
}

export function readLock(name: string, env?: NodeJS.ProcessEnv): SessionLock | null {
  try {
    return JSON.parse(fs.readFileSync(lockFile(name, env), 'utf8')) as SessionLock;
  } catch {
    return null;
  }
}

/**
 * Эксклюзивное право поднимать демон с этим именем: файл создаётся атомарно (O_EXCL) до запуска браузера,
 * поэтому два одновременных автозапуска не могут оба дойти до сокета. Устаревшую блокировку (мёртвый владелец,
 * либо владелец без сессии дольше staleMs) забирает новый демон.
 */
export function acquireSessionLock(name: string, env?: NodeJS.ProcessEnv, opts: { staleMs?: number; liveCheck?: (lock: SessionLock) => boolean } = {}): () => void {
  const file = lockFile(name, env);
  ensureDir(path.dirname(file));
  const staleMs = opts.staleMs ?? 120_000;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() } satisfies SessionLock));
      fs.closeSync(fd);
      return () => {
        const current = readLock(name, env);
        if (current?.pid === process.pid) fs.rmSync(file, { force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const lock = readLock(name, env);
      const alive = lock !== null && pidAlive(lock.pid) && (opts.liveCheck ? opts.liveCheck(lock) : Date.now() - Date.parse(lock.at) < staleMs || fs.existsSync(sessionFile(name, env)));
      if (alive) throw new SboxError('BROWSER_SESSION_EXISTS', `Сессия ${name} уже поднимается или работает (pid ${lock?.pid}).`, 'Используйте её или остановите: `sbox-browser stop`.');
      fs.rmSync(file, { force: true });
    }
  }
  throw new SboxError('BROWSER_SESSION_EXISTS', `Не удалось занять блокировку сессии ${name}.`);
}
