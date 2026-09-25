import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import puppeteer, { TimeoutError, type Browser, type Page } from 'puppeteer-core';
import { SboxError } from '../core/errors.js';
import { handlers, pushLimited, type DaemonContext, type PageState } from './commands.js';
import { browserDirs, ensureDir, expandHome, profileDir } from './paths.js';
import { createLineParser, encodeMessage, type ErrorPayload, type Request, type Response } from './protocol.js';
import { removeSession, socketPath, writeSession, type SessionInfo } from './session.js';

export interface DaemonOptions {
  session: string;
  executable: string;
  headless: boolean;
  /** Имя профиля в ~/.sbox/browser/profiles или путь к каталогу user-data-dir. */
  profile: string | null;
  viewport: { width: number; height: number };
  /** Минуты без команд до самозавершения; 0 — не завершаться. */
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

export function isHeadlessShell(executable: string): boolean {
  return /chrome-headless-shell/i.test(executable);
}

export function resolveProfileDir(profile: string | null, env?: NodeJS.ProcessEnv): string | undefined {
  if (!profile) return undefined;
  return profile.includes('/') || profile.includes('\\') ? expandHome(profile) : profileDir(profile, env);
}

function toError(e: unknown): ErrorPayload {
  if (e instanceof SboxError) return { code: e.code, message: e.message, ...(e.fix ? { fix: e.fix } : {}) };
  if (e instanceof TimeoutError) return { code: 'BROWSER_TIMEOUT', message: e.message.split('\n')[0] ?? e.message, fix: 'Увеличьте --timeout или дождитесь нужного состояния командой wait.' };
  if (e && typeof e === 'object' && 'issues' in e) return { code: 'BROWSER_BAD_ARGS', message: `Неверные аргументы команды: ${(e as { issues: { path: unknown[]; message: string }[] }).issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
  return { code: 'BROWSER_COMMAND_FAILED', message: e instanceof Error ? (e.message.split('\n')[0] ?? e.message) : String(e) };
}

/** Запускает браузер и локальный сокет команд; живёт, пока есть команды или пока не остановят. */
export async function startDaemon(opts: DaemonOptions): Promise<DaemonHandle> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`));
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
    throw new SboxError('BROWSER_START_FAILED', `Браузер ${opts.executable} не запустился: ${(e as Error).message.split('\n')[0]}`, userDataDir ? 'Если профиль уже открыт другим Chrome, закройте его или используйте другой --profile.' : 'Проверьте исполняемый файл: `sbox-browser doctor`.');
  }

  const ctx: DaemonContext = {
    browser,
    session: opts.session,
    env,
    settings: { headless: opts.headless, executable: opts.executable, profile: opts.profile, baseUrl: opts.baseUrl, timeoutMs: opts.timeoutMs, viewport: { ...opts.viewport }, cwd: opts.cwd },
    pages: [],
    currentIndex: 0,
    current() {
      const state = this.pages[this.currentIndex] ?? this.pages[0];
      if (!state) throw new SboxError('BROWSER_NO_PAGE', 'В браузере нет открытых вкладок.', 'Выполните `sbox-browser page new`.');
      return state;
    },
    attach(page: Page) {
      return attachPage(this, page);
    },
    dialogPolicy: { action: 'dismiss' },
    startedAt: Date.now(),
    requestStop() {
      void stop('команда stop');
    },
  };

  function attachPage(context: DaemonContext, page: Page): PageState {
    const existing = context.pages.find((s) => s.page === page);
    if (existing) return existing;
    const state: PageState = { page, console: [], network: [], snapshot: null };
    page.setDefaultTimeout(opts.timeoutMs);
    page.setDefaultNavigationTimeout(opts.timeoutMs);
    page.on('console', (m) => {
      const loc = m.location();
      pushLimited(state.console, { ts: new Date().toISOString(), kind: 'console', type: m.type(), text: m.text(), ...(loc.url ? { location: `${loc.url}:${loc.lineNumber ?? 0}` } : {}) });
    });
    page.on('pageerror', (e: unknown) => pushLimited(state.console, { ts: new Date().toISOString(), kind: 'pageerror', type: 'error', text: e instanceof Error ? e.message : String(e) }));
    page.on('dialog', (d) => {
      pushLimited(state.console, { ts: new Date().toISOString(), kind: 'dialog', type: d.type(), text: d.message() });
      const policy = context.dialogPolicy;
      void (policy.action === 'accept' ? d.accept(policy.text) : d.dismiss()).catch(() => {});
    });
    page.on('requestfailed', (r) => pushLimited(state.network, { ts: new Date().toISOString(), method: r.method(), url: r.url(), resourceType: r.resourceType(), failure: r.failure()?.errorText ?? 'failed' }));
    page.on('response', (r) => {
      if (r.status() >= 400) pushLimited(state.network, { ts: new Date().toISOString(), method: r.request().method(), url: r.url(), resourceType: r.request().resourceType(), status: r.status() });
    });
    page.on('close', () => {
      const i = context.pages.indexOf(state);
      if (i >= 0) context.pages.splice(i, 1);
      if (context.currentIndex >= context.pages.length) context.currentIndex = Math.max(0, context.pages.length - 1);
    });
    context.pages.push(state);
    return state;
  }

  for (const page of await browser.pages()) attachPage(ctx, page);
  if (ctx.pages.length === 0) attachPage(ctx, await browser.newPage());
  browser.on('targetcreated', (t) => {
    if (t.type() !== 'page') return;
    void t.page().then((p) => {
      if (p) attachPage(ctx, p);
    }).catch(() => {});
  });

  const sock = socketPath(opts.session, env);
  if (!sock.startsWith('\\\\.\\pipe\\')) {
    ensureDir(path.dirname(sock));
    fs.rmSync(sock, { force: true });
  }

  let queue: Promise<unknown> = Promise.resolve();
  let idleTimer: NodeJS.Timeout | null = null;
  let stopping: Promise<void> | null = null;
  let resolveDone!: (reason: string) => void;
  const done = new Promise<string>((r) => {
    resolveDone = r;
  });

  const touch = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (opts.idleMinutes > 0) idleTimer = setTimeout(() => void stop(`простой ${opts.idleMinutes} мин`), opts.idleMinutes * 60_000);
  };

  const server = net.createServer((conn) => {
    const parse = createLineParser<Request>(
      (req) => {
        touch();
        queue = queue.then(async () => {
          let response: Response;
          const handler = handlers[req.cmd];
          if (!handler) {
            response = { id: req.id, ok: false, error: { code: 'BROWSER_UNKNOWN_COMMAND', message: `Неизвестная команда ${req.cmd}.` } };
          } else {
            try {
              const result = await handler(ctx, req.args ?? {});
              response = { id: req.id, ok: true, result };
            } catch (e) {
              response = { id: req.id, ok: false, error: toError(e) };
              log(`✗ ${req.cmd}: ${response.error?.code} ${response.error?.message}`);
            }
          }
          if (!conn.destroyed) conn.write(encodeMessage(response));
        });
      },
      (e) => log(`битый запрос: ${e.message}`),
    );
    conn.on('data', parse);
    conn.on('error', () => {});
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(sock, () => {
      server.off('error', reject);
      resolve();
    });
  });

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

  async function stop(reason: string): Promise<void> {
    if (stopping) return stopping;
    stopping = (async () => {
      if (idleTimer) clearTimeout(idleTimer);
      log(`■ остановка: ${reason}`);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        if (browser.connected) await browser.close();
      } catch {
        /* браузер уже закрыт */
      }
      removeSession(opts.session, env);
      resolveDone(reason);
    })();
    return stopping;
  }

  browser.on('disconnected', () => void stop('браузер закрылся'));

  return { info, stop: () => stop('запрос остановки'), done };
}
