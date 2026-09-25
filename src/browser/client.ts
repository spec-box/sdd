import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { sleep } from '../core/async.js';
import { SboxError } from '../core/errors.js';
import { pidAlive } from '../core/lock.js';
import { packageRoot } from '../core/paths.js';
import { browserDirs, ensureDir } from './paths.js';
import { createLineParser, encodeMessage, type Request, type Response } from './protocol.js';
import { readSession, removeSession, type SessionInfo } from './session.js';

export interface SendOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

let nextId = 1;

/**
 * Сколько клиент ждёт ответа: пауза --ms плюс таймаут на каждое условие ожидания плюс запас.
 * Демон исполняет условия wait последовательно, каждое со своим таймаутом.
 */
export function budgetFor(cmd: string, args: Record<string, unknown>, baseTimeoutMs: number): number {
  const base = typeof args.timeout === 'number' ? args.timeout : baseTimeoutMs;
  const pause = typeof args.ms === 'number' ? args.ms : 0;
  const conditions = cmd === 'wait' ? Math.max(1, ['target', 'text', 'url', 'fn'].filter((k) => args[k] !== undefined).length) : 1;
  return pause + base * conditions + 10_000;
}

/** Отправляет одну команду демону и ждёт ответ. Мёртвый сокет удаляет след сессии. */
export async function sendCommand<T = unknown>(session: string, cmd: string, args: Record<string, unknown> = {}, opts: SendOptions = {}): Promise<T> {
  const env = opts.env ?? process.env;
  const info = readSession(session, env);
  if (!info) throw new SboxError('BROWSER_SESSION_NOT_RUNNING', `Сессия ${session} не запущена.`, 'Любая команда страницы поднимет её сама; явно: `sbox-browser start`.');
  return sendTo(info, cmd, args, opts.timeoutMs ?? budgetFor(cmd, args, 15_000), env);
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
        // Сокет мёртв независимо от pid (после перезагрузки pid может принадлежать чужому процессу): след снимается, следующая команда поднимет сессию заново.
        removeSession(info.name, env);
        finish(() => reject(new SboxError('BROWSER_SESSION_NOT_RUNNING', `Сокет сессии ${info.name} не отвечает (${e.code}).`, 'Повторите команду: сессия будет поднята заново.')));
      } else {
        finish(() => reject(new SboxError('BROWSER_CLIENT_ERROR', `Ошибка связи с демоном ${info.name}: ${e.message}`)));
      }
    });
    conn.on('close', () => finish(() => reject(new SboxError('BROWSER_CLIENT_ERROR', `Демон сессии ${info.name} закрыл соединение без ответа.`, `Журнал: ${info.log}.`))));
  });
}

/** Параметры запуска демона: клиент разрешает их один раз и передаёт демону целиком. */
export interface LaunchSpec {
  session: string;
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
export async function spawnDaemon(spec: LaunchSpec, opts: { env?: NodeJS.ProcessEnv; startTimeoutMs?: number; log?: (s: string) => void } = {}): Promise<SessionInfo> {
  const env = opts.env ?? process.env;
  const session = spec.session;
  const logFile = path.join(ensureDir(browserDirs.logs(env)), `${session}.log`);
  const out = fs.openSync(logFile, 'a', 0o600);
  const child = spawn(process.execPath, [daemonEntry(), 'serve', '--spec', JSON.stringify(spec)], { detached: true, stdio: ['ignore', out, out], env, windowsHide: true });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  let exitCode: number | null | undefined;
  void exited.then((code) => {
    exitCode = code;
  });
  child.unref();
  fs.closeSync(out);
  opts.log?.(`запуск демона ${session}, pid ${child.pid}, журнал ${logFile}`);
  const deadline = Date.now() + (opts.startTimeoutMs ?? 60_000);
  while (Date.now() < deadline) {
    if (exitCode !== undefined) {
      // Гонка двух автозапусков: проигравший демон завершился, потому что сессию уже поднял другой процесс.
      const winner = readSession(session, env);
      if (winner && winner.pid !== child.pid) {
        try {
          await sendTo(winner, 'ping', {}, 5_000, env);
          return winner;
        } catch {
          /* и он мёртв: сообщаем об ошибке запуска */
        }
      }
      const tail = tailOf(logFile);
      throw new SboxError('BROWSER_START_FAILED', `Демон сессии ${session} завершился с кодом ${exitCode} до готовности.${tail ? `\n${tail}` : ''}`, `Полный журнал: ${logFile}`);
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
    await sleep(150);
  }
  throw new SboxError('BROWSER_START_FAILED', `Демон сессии ${session} не ответил за ${opts.startTimeoutMs ?? 60_000} мс.`, `Журнал: ${logFile}`);
}

/** Последние строки журнала: читается только хвост файла, журнал может быть большим. */
function tailOf(file: string, lines = 8, bytes = 8_192): string {
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try {
      const length = Math.min(size, bytes);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      return buffer.toString('utf8').trimEnd().split('\n').slice(-lines).join('\n');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** Принадлежит ли процесс демону этой сессии: по командной строке, а не по одному pid, который мог достаться чужому процессу. */
export function isOurDaemon(pid: number, session: string): boolean {
  if (process.platform === 'win32') return false;
  try {
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return command.includes('browser/cli.js') && command.includes(`"session":"${session}"`);
  } catch {
    return false;
  }
}

export interface StopResult {
  stopped: boolean;
  pid: number | null;
  /** not_running: сессии не было; stale: след был мёртвым и снят; killed: демон не вышел сам и получил SIGTERM. */
  reason: 'stopped' | 'not_running' | 'stale' | 'killed' | 'foreign_pid';
}

/** Останавливает демон и ждёт завершения процесса. Чужой процесс с тем же pid не трогает. */
export async function stopSession(session: string, env: NodeJS.ProcessEnv = process.env, waitMs = 15_000): Promise<StopResult> {
  const info = readSession(session, env);
  if (!info) return { stopped: false, pid: null, reason: 'not_running' };
  try {
    await sendTo(info, 'stop', {}, 10_000, env);
  } catch (e) {
    if (e instanceof SboxError && e.code === 'BROWSER_SESSION_NOT_RUNNING') return { stopped: false, pid: info.pid, reason: 'stale' };
    /* демон мог закрыть соединение, завершаясь: ждём выхода процесса */
  }
  const deadline = Date.now() + waitMs;
  while (pidAlive(info.pid) && Date.now() < deadline) await sleep(100);
  if (!pidAlive(info.pid)) {
    removeSession(session, env);
    return { stopped: true, pid: info.pid, reason: 'stopped' };
  }
  if (!isOurDaemon(info.pid, session)) {
    removeSession(session, env);
    return { stopped: false, pid: info.pid, reason: 'foreign_pid' };
  }
  try {
    process.kill(info.pid, 'SIGTERM');
  } catch {
    /* уже завершился */
  }
  removeSession(session, env);
  return { stopped: true, pid: info.pid, reason: 'killed' };
}
