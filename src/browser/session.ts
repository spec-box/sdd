import fs from 'node:fs';
import path from 'node:path';
import { SboxError } from '../core/errors.js';
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

/** Путь сокета: unix-сокет в каталоге сессий, на Windows именованный канал. */
export function socketPath(name: string, env?: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return `\\\\.\\pipe\\sbox-browser-${name}`;
  return path.join(browserDirs.sessions(env), `${name}.sock`);
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function writeSession(info: SessionInfo, env?: NodeJS.ProcessEnv): string {
  const file = sessionFile(info.name, env);
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
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
  if (!info.pid || !isPidAlive(info.pid)) {
    removeSession(name, env);
    return null;
  }
  return info;
}

export function removeSession(name: string, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): void {
  fs.rmSync(sessionFile(name, env), { force: true });
  const sock = socketPath(name, env, platform);
  if (!sock.startsWith('\\\\.\\pipe\\')) fs.rmSync(sock, { force: true });
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
