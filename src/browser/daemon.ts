import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import puppeteer, { TimeoutError, type Browser, type Page } from 'puppeteer-core';
import { SboxError } from '../core/errors.js';
import { errorPayload } from '../cli/output.js';
import { handlers, pushLimited, type DaemonContext, type PageState } from './commands.js';
import { browserDirs, ensureDir, expandHome, profileDir } from './paths.js';
import { createLineParser, encodeMessage, type ErrorPayload, type Request, type Response } from './protocol.js';
import { sendTo } from './client.js';
import { acquireSessionLock, isPipe, readSession, removeSession, removeSessionIfOwned, socketPath, writeSession, type SessionInfo } from './session.js';

export interface DaemonOptions {
  session: string;
  executable: string;
  headless: boolean;
  /** Имя профиля в ~/.sbox/browser/profiles или путь к каталогу user-data-dir. */
  profile: string | null;
  viewport: { width: number; height: number };
  /** Минуты без команд до самозавершения; 0 — не завершаться. Считается только между командами, не во время них. */
  idleMinutes: number;
  baseUrl: string | null;
  timeoutMs: number;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  extraArgs?: string[];
}

export interface DaemonHandle {
  info: SessionInfo;
  stop(): Promise<void>;
  /** Разрешается, когда демон остановлен: по команде, по простою или из-за потери браузера. */
  done: Promise<string>;
}

/** Предел setTimeout в Node: больший интервал молча превращается в 1 мс. */
const MAX_TIMER_MS = 2_147_483_647;

/** Команды, которые отвечают немедленно, минуя очередь: ping должен работать и у занятого демона, stop — прерывать его. */
const IMMEDIATE = new Set(['ping', 'stop']);

export function isHeadlessShell(executable: string): boolean {
  return /chrome-headless-shell/i.test(executable);
}

export function resolveProfileDir(profile: string | null, env?: NodeJS.ProcessEnv): string | undefined {
  if (!profile) return undefined;
  return profile.includes('/') || profile.includes('\\') ? expandHome(profile) : profileDir(profile, env);
}

function toError(e: unknown, signal?: AbortSignal): ErrorPayload {
  if (e instanceof SboxError) return errorPayload(e);
  if (signal?.aborted) return { code: 'BROWSER_ABORTED', message: 'Клиент отключился, команда прервана.' };
  if (e instanceof TimeoutError) return { code: 'BROWSER_TIMEOUT', message: e.message.split('\n')[0] ?? e.message, fix: 'Увеличьте --timeout или дождитесь нужного состояния командой wait.' };
  if (e && typeof e === 'object' && 'issues' in e) return { code: 'BROWSER_BAD_ARGS', message: `Неверные аргументы команды: ${(e as { issues: { path: unknown[]; message: string }[] }).issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
  return { code: 'BROWSER_COMMAND_FAILED', message: e instanceof Error ? (e.message.split('\n')[0] ?? e.message) : String(e) };
}

/** Есть ли живой слушатель на сокете: ping вне очереди отвечает и у занятого демона. */
async function socketAlive(info: SessionInfo, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await sendTo(info, 'ping', {}, 3_000, env);
    return true;
  } catch {
    return false;
  }
}

/** Запускает браузер и локальный сокет команд; живёт, пока есть команды или пока не остановят. */
export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`));

  // 1. Живая сессия с этим именем: отказ. Мёртвый след: снимаем.
  const existing = readSession(opts.session, env);
  if (existing) {
    if (await socketAlive(existing, env)) throw new SboxError('BROWSER_SESSION_EXISTS', `Сессия ${opts.session} уже работает (pid ${existing.pid}).`, 'Используйте её или остановите: `sbox-browser stop`.');
    removeSession(opts.session, env);
  }
  // 2. Атомарная блокировка имени до запуска браузера: два одновременных автозапуска не дойдут до сокета оба.
  const releaseLock = acquireSessionLock(opts.session, env);

  const userDataDir = resolveProfileDir(opts.profile, env);
  if (userDataDir) ensureDir(userDataDir);
  const args = ['--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble', `--window-size=${opts.viewport.width},${opts.viewport.height + 88}`, ...(opts.extraArgs ?? [])];
  let browser: Browser;
  try {
    browser = await puppeteer.launch({
      executablePath: opts.executable,
      headless: opts.headless ? (isHeadlessShell(opts.executable) ? 'shell' : true) : false,
      defaultViewport: opts.viewport,
      userDataDir,
      args,
      timeout: 60_000,
    });
  } catch (e) {
    releaseLock();
    throw new SboxError('BROWSER_START_FAILED', `Браузер ${opts.executable} не запустился: ${(e as Error).message.split('\n')[0]}`, userDataDir ? 'Если профиль уже открыт другим Chrome, закройте его или используйте другой --profile.' : 'Проверьте исполняемый файл: `sbox-browser doctor`.');
  }

  const ctx: DaemonContext = {
    browser,
    session: opts.session,
    env,
    settings: { headless: opts.headless, executable: opts.executable, profile: opts.profile, baseUrl: opts.baseUrl, timeoutMs: opts.timeoutMs, viewport: { ...opts.viewport }, cwd: opts.cwd },
    pages: [],
    currentPage: null,
    viewportOverride: null,
    current() {
      const state = this.currentPage ?? this.pages[0];
      if (!state) throw new SboxError('BROWSER_NO_PAGE', 'В браузере нет открытых вкладок.', 'Выполните `sbox-browser page new`.');
      return state;
    },
    currentIndex() {
      const i = this.currentPage ? this.pages.indexOf(this.currentPage) : -1;
      return i >= 0 ? i : 0;
    },
    attach(page: Page) {
      return attachPage(this, page);
    },
    dialogPolicy: { action: 'dismiss' },
    startedAt: Date.now(),
  };

  function attachPage(context: DaemonContext, page: Page): PageState {
    const existingState = context.pages.find((s) => s.page === page);
    if (existingState) return existingState;
    const state: PageState = { page, console: [], network: [], snapshot: null };
    page.setDefaultTimeout(opts.timeoutMs);
    page.setDefaultNavigationTimeout(opts.timeoutMs);
    if (context.viewportOverride) void page.setViewport(context.viewportOverride).catch(() => {});
    page.on('console', (m) => {
      const loc = m.location();
      pushLimited(state.console, { ts: new Date().toISOString(), kind: 'console', type: m.type(), text: m.text(), ...(loc.url ? { location: `${loc.url}:${loc.lineNumber ?? 0}` } : {}) });
    });
    page.on('pageerror', (e: unknown) => pushLimited(state.console, { ts: new Date().toISOString(), kind: 'pageerror', type: 'error', text: e instanceof Error ? e.message : String(e) }));
    page.on('dialog', (d) => {
      pushLimited(state.console, { ts: new Date().toISOString(), kind: 'dialog', type: d.type(), text: d.message() });
      const policy = context.dialogPolicy;
      // beforeunload всегда подтверждается: иначе dismiss отменяет любую навигацию со страницы с несохранённой формой.
      const accept = d.type() === 'beforeunload' || policy.action === 'accept';
      void (accept ? d.accept(d.type() === 'prompt' ? policy.text : undefined) : d.dismiss()).catch(() => {});
    });
    page.on('requestfailed', (r) => pushLimited(state.network, { ts: new Date().toISOString(), method: r.method(), url: r.url(), resourceType: r.resourceType(), failure: r.failure()?.errorText ?? 'failed' }));
    page.on('response', (r) => {
      if (r.status() >= 400) pushLimited(state.network, { ts: new Date().toISOString(), method: r.request().method(), url: r.url(), resourceType: r.request().resourceType(), status: r.status() });
    });
    page.on('close', () => {
      const i = context.pages.indexOf(state);
      if (i >= 0) context.pages.splice(i, 1);
      if (context.currentPage === state) context.currentPage = context.pages[i] ?? context.pages[context.pages.length - 1] ?? null;
    });
    context.pages.push(state);
    if (!context.currentPage) context.currentPage = state;
    return state;
  }

  for (const page of await browser.pages()) attachPage(ctx, page);
  if (ctx.pages.length === 0) attachPage(ctx, await browser.newPage());
  browser.on('targetcreated', (t) => {
    if (t.type() !== 'page') return;
    void t
      .page()
      .then((p) => {
        if (p && !p.isClosed()) attachPage(ctx, p);
      })
      .catch(() => {});
  });

  const sock = socketPath(opts.session, env);
  if (!isPipe(sock)) {
    ensureDir(path.dirname(sock));
    fs.rmSync(sock, { force: true });
  }

  let queue: Promise<unknown> = Promise.resolve();
  let busy = 0;
  let idleTimer: NodeJS.Timeout | null = null;
  let stopping: Promise<void> | null = null;
  let listening = false;
  let resolveDone!: (reason: string) => void;
  const done = new Promise<string>((r) => {
    resolveDone = r;
  });

  const idleMs = opts.idleMinutes * 60_000;
  const idleEnabled = idleMs > 0 && idleMs <= MAX_TIMER_MS;
  if (idleMs > MAX_TIMER_MS) log(`простой ${opts.idleMinutes} мин больше предела таймера, самозавершение выключено`);
  const touch = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (!idleEnabled) return;
    idleTimer = setTimeout(() => {
      // Занятый демон не останавливаем: таймер отсчитывает простой между командами.
      if (busy > 0) touch();
      else void stop(`простой ${opts.idleMinutes} мин`);
    }, idleMs);
  };

  function reply(conn: net.Socket, req: Request, response: Response): void {
    if (conn.destroyed) return;
    let line: string;
    try {
      line = encodeMessage(response);
    } catch (e) {
      line = encodeMessage({ id: req.id, ok: false, error: { code: 'BROWSER_RESULT_UNSERIALIZABLE', message: `Результат команды ${req.cmd} не сериализуется в JSON: ${(e as Error).message}` } });
    }
    conn.write(line, () => {
      if (req.cmd === 'stop') {
        conn.end();
        void stop('команда stop');
      }
    });
  }

  async function execute(req: Request, signal: AbortSignal): Promise<Response> {
    const handler = Object.hasOwn(handlers, req.cmd) ? handlers[req.cmd] : undefined;
    if (!handler) return { id: req.id, ok: false, error: { code: 'BROWSER_UNKNOWN_COMMAND', message: `Неизвестная команда ${req.cmd}.` } };
    try {
      return { id: req.id, ok: true, result: await handler(ctx, req.args ?? {}, signal) };
    } catch (e) {
      const error = toError(e, signal);
      log(`✗ ${req.cmd}: ${error.code} ${error.message}`);
      return { id: req.id, ok: false, error };
    }
  }

  const sockets = new Set<net.Socket>();
  const server = net.createServer((conn) => {
    sockets.add(conn);
    conn.on('close', () => sockets.delete(conn));
    const parse = createLineParser<Request>(
      (req) => {
        if (IMMEDIATE.has(req.cmd)) {
          void execute(req, new AbortController().signal).then((response) => reply(conn, req, response));
          return;
        }
        touch();
        const ac = new AbortController();
        const onClose = (): void => ac.abort();
        conn.once('close', onClose);
        queue = queue.then(async () => {
          if (conn.destroyed) {
            log(`↷ ${req.cmd}: клиент отключился до выполнения`);
            return;
          }
          busy += 1;
          try {
            reply(conn, req, await execute(req, ac.signal));
          } finally {
            busy -= 1;
            conn.off('close', onClose);
            touch();
          }
        });
      },
      (e) => log(`битый запрос: ${e.message}`),
    );
    conn.on('data', parse);
    conn.on('error', () => {});
  });

  async function stop(reason: string): Promise<void> {
    if (stopping) return stopping;
    stopping = (async () => {
      if (idleTimer) clearTimeout(idleTimer);
      log(`■ остановка: ${reason}`);
      if (listening) {
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        for (const s of sockets) s.destroy();
        await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
      }
      try {
        if (browser.connected) await browser.close();
      } catch {
        /* браузер уже закрыт */
      }
      // Свой след снимаем, чужой (сессию, перезапущенную другим процессом) не трогаем.
      removeSessionIfOwned(opts.session, process.pid, env);
      releaseLock();
      resolveDone(reason);
    })();
    return stopping;
  }

  browser.on('disconnected', () => void stop('браузер закрылся'));

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(sock, () => {
        server.off('error', reject);
        listening = true;
        if (!isPipe(sock)) {
          try {
            fs.chmodSync(sock, 0o600);
          } catch {
            /* файловая система без прав */
          }
        }
        resolve();
      });
    });
  } catch (e) {
    await stop(`сокет не открылся: ${(e as Error).message}`);
    throw new SboxError('BROWSER_START_FAILED', `Не удалось открыть сокет ${sock}: ${(e as Error).message}`);
  }

  const info: SessionInfo = {
    name: opts.session,
    pid: process.pid,
    socket: sock,
    wsEndpoint: browser.wsEndpoint(),
    executable: opts.executable,
    headless: opts.headless,
    profile: opts.profile,
    viewport: opts.viewport,
    startedAt: new Date().toISOString(),
    cwd: opts.cwd,
    log: path.join(browserDirs.logs(env), `${opts.session}.log`),
  };
  writeSession(info, env);
  touch();
  log(`▶ сессия ${opts.session}: ${opts.headless ? 'headless' : 'окно'} ${opts.executable}${userDataDir ? ` профиль ${userDataDir}` : ''}`);

  return { info, stop: () => stop('запрос остановки'), done };
}
