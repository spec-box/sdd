import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { SboxError } from '../core/errors.js';
import { packageRoot } from '../core/paths.js';
import { browserDirs, ensureDir } from './paths.js';
import { createLineParser, encodeMessage, type Request, type Response } from './protocol.js';
import { isPidAlive, readSession, removeSession, type SessionInfo } from './session.js';

export interface SendOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

let nextId = 1;

/** Отправляет одну команду демону и ждёт ответ. Мёртвый сокет удаляет след сессии. */
export async function sendCommand<T = unknown>(session: string, cmd: string, args: Record<string, unknown> = {}, opts: SendOptions = {}): Promise<T> {
  const env = opts.env ?? process.env;
  const info = readSession(session, env);
  if (!info) throw new SboxError('BROWSER_SESSION_NOT_RUNNING', `Сессия ${session} не запущена.`, 'Любая команда страницы поднимет её сама; явно: `sbox-browser start`.');
  return sendTo(info, cmd, args, opts.timeoutMs ?? (typeof args.timeout === 'number' ? args.timeout + 10_000 : 90_000), env);
}

export function sendTo<T = unknown>(info: SessionInfo, cmd: string, args: Record<string, unknown>, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = nextId++;
    const conn = net.createConnection(info.socket);
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new SboxError('BROWSER_CLIENT_TIMEOUT', `Демон сессии ${info.name} не ответил на ${cmd} за ${timeoutMs} мс.`, `Журнал: ${info.log}. Остановить: \`sbox-browser stop --session ${info.name}\`.`))), timeoutMs);
    conn.on('connect', () => conn.write(encodeMessage({ id, cmd, args } satisfies Request)));
    conn.on('data', createLineParser<Response>((res) => {
      if (res.id !== id) return;
      finish(() => (res.ok ? resolve(res.result as T) : reject(new SboxError(res.error?.code ?? 'BROWSER_COMMAND_FAILED', res.error?.message ?? 'ошибка без описания', res.error?.fix))));
    }));
    conn.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ECONNREFUSED' || e.code === 'ENOENT') {
        if (!isPidAlive(info.pid)) removeSession(info.name, env);
        finish(() => reject(new SboxError('BROWSER_SESSION_NOT_RUNNING', `Сокет сессии ${info.name} не отвечает (${e.code}).`, 'Повторите команду: сессия будет поднята заново.')));
      } else {
        finish(() => reject(new SboxError('BROWSER_CLIENT_ERROR', `Ошибка связи с демоном ${info.name}: ${e.message}`)));
      }
    });
    conn.on('close', () => finish(() => reject(new SboxError('BROWSER_CLIENT_ERROR', `Демон сессии ${info.name} закрыл соединение без ответа.`, `Журнал: ${info.log}.`))));
  });
}

export interface LaunchSpec {
  executable: string;
  headless: boolean;
  profile: string | null;
  viewport: { width: number; height: number };
  idleMinutes: number;
  baseUrl: string | null;
  timeoutMs: number;
  cwd: string;
}

/** Точка входа демона: собранный CLI в dist/ пакета (и при запуске из исходников через tsx). */
export function daemonEntry(): string {
  const entry = path.join(packageRoot(), 'dist', 'browser', 'cli.js');
  if (!fs.existsSync(entry)) {
    throw new SboxError('BROWSER_DAEMON_ENTRY', `Не найден файл демона ${entry}.`, 'Соберите проект (`pnpm build`): демон запускается из dist/.');
  }
  return entry;
}

/** Поднимает демон в фоне и ждёт, пока он ответит на ping. */
export async function spawnDaemon(session: string, spec: LaunchSpec, opts: { env?: NodeJS.ProcessEnv; startTimeoutMs?: number; log?: (s: string) => void } = {}): Promise<SessionInfo> {
  const env = opts.env ?? process.env;
  const logFile = path.join(ensureDir(browserDirs.logs(env)), `${session}.log`);
  const out = fs.openSync(logFile, 'a');
  const args = [
    daemonEntry(),
    'serve',
    '--session', session,
    '--executable', spec.executable,
    spec.headless ? '--headless' : '--headed',
    '--viewport', `${spec.viewport.width}x${spec.viewport.height}`,
    '--idle', String(spec.idleMinutes),
    '--timeout', String(spec.timeoutMs),
    '--cwd', spec.cwd,
    ...(spec.profile ? ['--profile', spec.profile] : []),
    ...(spec.baseUrl ? ['--base-url', spec.baseUrl] : []),
  ];
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', out, out], env, windowsHide: true });
  let exited: { code: number | null } | null = null;
  child.on('exit', (code) => {
    exited = { code };
  });
  child.unref();
  fs.closeSync(out);
  opts.log?.(`запуск демона ${session}, pid ${child.pid}, журнал ${logFile}`);
  const deadline = Date.now() + (opts.startTimeoutMs ?? 60_000);
  while (Date.now() < deadline) {
    if (exited) {
      const tail = tailOf(logFile);
      throw new SboxError('BROWSER_START_FAILED', `Демон сессии ${session} завершился с кодом ${(exited as { code: number | null }).code} до готовности.${tail ? `\n${tail}` : ''}`, `Полный журнал: ${logFile}`);
    }
    const info = readSession(session, env);
    if (info && info.pid === child.pid) {
      try {
        await sendTo(info, 'ping', {}, 5_000, env);
        return info;
      } catch {
        /* сокет ещё не готов */
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new SboxError('BROWSER_START_FAILED', `Демон сессии ${session} не ответил за ${opts.startTimeoutMs ?? 60_000} мс.`, `Журнал: ${logFile}`);
}

function tailOf(file: string, lines = 8): string {
  try {
    return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/** Останавливает демон и ждёт завершения процесса. */
export async function stopSession(session: string, env: NodeJS.ProcessEnv = process.env, waitMs = 15_000): Promise<{ stopped: boolean; pid: number | null }> {
  const info = readSession(session, env);
  if (!info) return { stopped: false, pid: null };
  try {
    await sendTo(info, 'stop', {}, 10_000, env);
  } catch {
    /* демон мог закрыть соединение, завершаясь */
  }
  const deadline = Date.now() + waitMs;
  while (isPidAlive(info.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  if (isPidAlive(info.pid)) {
    try {
      process.kill(info.pid, 'SIGTERM');
    } catch {
      /* уже завершился */
    }
  }
  removeSession(session, env);
  return { stopped: true, pid: info.pid };
}
