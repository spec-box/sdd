import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendCommand, spawnDaemon, stopSession } from '../src/browser/client.js';
import { startDaemon, type DaemonHandle } from '../src/browser/daemon.js';
import { resolveExecutable } from '../src/browser/executable.js';
import { readSession } from '../src/browser/session.js';
import { loadBrowserSettings } from '../src/browser/settings.js';
import type { LogEntry, NetEntry } from '../src/browser/commands.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Браузер ищется так же, как в CLI: SBOX_BROWSER_EXECUTABLE, кэш инструмента, кэш puppeteer, системный Chrome.
const gate = loadBrowserSettings({ cwd: os.tmpdir() });
const exe = await resolveExecutable({ explicit: gate.executable, cacheDir: gate.cacheDir }).catch(() => null);
const distCli = path.join(here, '..', 'dist', 'browser', 'cli.js');
const BIG_TEXT = 'Привет, мир! Ещё немного кириллицы для проверки склейки. '.repeat(1500);

const PAGES: Record<string, string> = {
  '/': `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Главная</title></head><body>
<h1>Витрина</h1>
<nav><a href="/login">Вход</a> <a href="/app">Кабинет</a> <a href="/dialog">Диалоги</a></nav>
<label>Поиск <input id="q" type="text"></label>
<button id="counter" type="button" onclick="document.getElementById('count').textContent = String(Number(document.getElementById('count').textContent) + 1)">Счётчик</button>
<span id="count">0</span>
<label><input id="agree" type="checkbox"> Согласен</label>
<label>Сорт <select id="sort"><option value="asc">По возрастанию</option><option value="desc">По убыванию</option></select></label>
<ul><li>a</li><li>b</li></ul><div data-x="a;b">Z</div>
<div id="late" hidden>Появилось позже</div>
<script>
console.log('hello');
console.error('boom');
fetch('/api/missing');
setTimeout(() => { document.getElementById('late').hidden = false; }, 400);
</script></body></html>`,
  '/login': `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Вход</title></head><body>
<h1>Вход в систему</h1>
<form method="post" action="/login">
<label>Логин <input name="user" type="text"></label>
<label>Пароль <input name="pass" type="password"></label>
<button type="submit">Войти</button>
</form></body></html>`,
  '/dialog': `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Диалог</title></head><body>
<button id="ask" type="button" onclick="document.getElementById('answer').textContent = confirm('Точно?') ? 'да' : 'нет'">Спросить</button>
<span id="answer"></span></body></html>`,
  '/unload': `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Форма</title></head><body>
<textarea id="draft">черновик</textarea>
<script>window.onbeforeunload = () => 'Есть несохранённые изменения';</script></body></html>`,
  '/big': `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Много текста</title></head><body><pre id="big">${BIG_TEXT}</pre></body></html>`,
};

function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const html = (body: string, status = 200, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(body);
    };
    if (req.method === 'POST' && url.pathname === '/login') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const form = new URLSearchParams(body);
        if (form.get('user') === 'ivan' && form.get('pass') === 'secret') html('', 302, { 'set-cookie': 'sid=abc; Path=/; HttpOnly', location: '/app' });
        else html('<title>Вход</title><p>Неверный пароль</p>');
      });
      return;
    }
    if (url.pathname === '/app') {
      if ((req.headers.cookie ?? '').includes('sid=abc')) return html('<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Кабинет</title></head><body><h1>Привет, ivan</h1><button type="button">Выйти</button></body></html>');
      return html('', 302, { location: '/login' });
    }
    if (url.pathname === '/api/missing') return html('nope', 404);
    const page = PAGES[url.pathname];
    if (page) return html(page);
    return html('нет такой страницы', 404);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

const homeEnv = (prefix: string): NodeJS.ProcessEnv => ({ ...process.env, SBOX_BROWSER_HOME: fs.mkdtempSync(path.join(os.tmpdir(), prefix)) });

describe.skipIf(!exe)('browser: сквозной прогон на локальном сервере', () => {
  const env = homeEnv('sbox-browser-e2e-');
  const session = 'e2e';
  let server: Awaited<ReturnType<typeof startServer>>;
  let daemon: DaemonHandle;
  const send = <T = Record<string, unknown>>(cmd: string, args: Record<string, unknown> = {}, timeoutMs?: number) => sendCommand<T>(session, cmd, args, { env, timeoutMs });

  beforeAll(async () => {
    server = await startServer();
    daemon = await startDaemon({ session, executable: exe!.path, headless: true, profile: null, viewport: { width: 1000, height: 700 }, idleMinutes: 0, baseUrl: server.url, timeoutMs: 5000, cwd: process.cwd(), env, log: () => {} });
  }, 60_000);

  afterAll(async () => {
    await daemon?.stop();
    await server?.close();
  });

  it('открывает страницу, читает заголовок и текст', async () => {
    const nav = await send<{ url: string; title: string; status: number }>('goto', { url: '/' });
    expect(nav.status).toBe(200);
    expect(nav.title).toBe('Главная');
    const { text } = await send<{ text: string }>('text');
    expect(text).toContain('Витрина');
    expect((await send<{ title: string }>('title')).title).toBe('Главная');
    expect(readSession(session, env)?.pid).toBe(process.pid);
    // Относительное имя файла разрешается от базового URL, а не превращается в домен.
    const rel = await send<{ url: string; status: number }>('goto', { url: 'index.html' });
    expect(rel.url).toBe(`${server.url}/index.html`);
    expect(rel.status).toBe(404);
    await send('goto', { url: '/' });
  });

  it('снимок даёт ссылки, по которым работают ввод и клик; exists проверяет живой элемент', async () => {
    const snap = await send<{ text: string; count: number }>('snapshot');
    expect(snap.count).toBeGreaterThanOrEqual(6);
    const search = snap.text.match(/\[(e\d+)\] textbox "Поиск"/)?.[1];
    expect(search).toBeDefined();
    await send('type', { target: `@${search}`, text: 'кофе' });
    expect((await send<{ value: string }>('value', { target: '#q' })).value).toBe('кофе');
    await send('type', { target: '#q', text: 'молотый', clear: true });
    expect((await send<{ value: string }>('value', { target: '#q' })).value).toBe('молотый');
    const counter = snap.text.match(/\[(e\d+)\] button "Счётчик"/)?.[1];
    await send('click', { target: `@${counter}` });
    await send('click', { target: 'text=Счётчик' });
    expect((await send<{ text: string }>('text', { target: '#count' })).text).toBe('2');
    expect((await send<{ checked: boolean }>('check', { target: 'aria=Согласен', checked: true })).checked).toBe(true);
    expect((await send<{ selected: string[] }>('select', { target: '#sort', values: ['desc'] })).selected).toEqual(['desc']);
    expect((await send<{ count: number }>('count', { target: 'a' })).count).toBe(3);
    expect(await send('exists', { target: `@${counter}` })).toEqual({ exists: true, visible: true });
    await send('eval', { code: "document.getElementById('counter').remove()" });
    expect((await send<{ exists: boolean }>('exists', { target: `@${counter}` })).exists).toBe(false);
    await expect(send('click', { target: `@${counter}` })).rejects.toMatchObject({ code: 'BROWSER_REF_STALE' });
    await send('goto', { url: '/' });
  });

  it('ждёт появления текста и сообщает об истечении таймаута кодом', async () => {
    const waited = await send<{ waited: string[] }>('wait', { text: 'Появилось позже' });
    expect(waited.waited[0]).toContain('Появилось позже');
    await expect(send('wait', { target: '#nope', timeout: 300 })).rejects.toMatchObject({ code: 'BROWSER_TIMEOUT' });
    await expect(send('click', { target: '#nope', timeout: 300 })).rejects.toMatchObject({ code: 'BROWSER_TARGET_NOT_FOUND' });
    await expect(send('click', { target: '@e999' })).rejects.toMatchObject({ code: 'BROWSER_REF_UNKNOWN' });
  });

  it('собирает консоль, ошибки страницы и неудачные запросы; eval исполняет выражения и тела функций', async () => {
    const { entries } = await send<{ entries: LogEntry[] }>('console');
    expect(entries.map((e) => `${e.type}:${e.text}`)).toEqual(expect.arrayContaining(['log:hello', 'error:boom']));
    const errors = await send<{ entries: LogEntry[] }>('console', { errors: true, clear: true });
    expect(errors.entries.length).toBeGreaterThan(0);
    expect(errors.entries.every((e) => e.type === 'error')).toBe(true);
    expect(errors.entries.map((e) => `${e.type}:${e.text}`)).toContain('error:boom');
    expect(errors.entries.some((e) => e.text === 'hello')).toBe(false);
    expect((await send<{ entries: LogEntry[] }>('console')).entries).toHaveLength(0);
    const net = await send<{ entries: NetEntry[] }>('requests');
    expect(net.entries.some((e) => e.status === 404 && e.url.endsWith('/api/missing'))).toBe(true);
    expect((await send<{ result: unknown }>('eval', { code: '1 + 2' })).result).toBe(3);
    expect((await send<{ result: unknown }>('eval', { code: 'const a = 2; return a * 21;' })).result).toBe(42);
    expect((await send<{ result: unknown }>('eval', { code: 'let x = 1; x + 1' })).result).toBe(2);
    expect((await send<{ result: unknown }>('eval', { code: "Array.from(document.querySelectorAll('li')).map(e => e.textContent).join('; ')" })).result).toBe('a; b');
    expect((await send<{ result: unknown }>('eval', { code: "document.querySelector('[data-x=\"a;b\"]').textContent" })).result).toBe('Z');
    expect((await send<{ result: unknown }>('eval', { code: 'await Promise.resolve(7); return 7 * 6;' })).result).toBe(42);
    // BigInt не роняет демон: результат приходит строкой.
    expect((await send<{ result: unknown }>('eval', { code: '10n ** 20n' })).result).toBe('100000000000000000000');
    expect((await send<{ pid: number }>('ping')).pid).toBe(process.pid);
  });

  it('вход через форму, куки, перенос состояния с проверкой origin', async () => {
    await send('goto', { url: '/login' });
    const snap = await send<{ text: string }>('snapshot', { interactive: true });
    const user = snap.text.match(/\[(e\d+)\] textbox "Логин"/)?.[1];
    const pass = snap.text.match(/\[(e\d+)\] textbox "Пароль"/)?.[1];
    const submit = snap.text.match(/\[(e\d+)\] button "Войти"/)?.[1];
    expect(user && pass && submit).toBeTruthy();
    await send('type', { target: `@${user}`, text: 'ivan' });
    await send('type', { target: `@${pass}`, text: 'secret' });
    await send('click', { target: `@${submit}` });
    const done = await send<{ url: string }>('wait', { url: '*/app' });
    expect(done.url).toContain('/app');
    expect((await send<{ text: string }>('text')).text).toContain('Привет, ivan');
    const { cookies } = await send<{ cookies: { name: string; value: string }[] }>('cookies', { action: 'list' });
    expect(cookies.find((c) => c.name === 'sid')?.value).toBe('abc');

    const { state } = await send<{ state: { cookies: unknown[]; origins: unknown[] } }>('state.export');
    expect(state.cookies).toHaveLength(1);
    await send('cookies', { action: 'clear' });
    await send('goto', { url: '/app' });
    expect((await send<{ url: string }>('url')).url).toContain('/login');
    const restored = await send<{ cookies: number }>('state.import', { state });
    expect(restored.cookies).toBe(1);
    await send('goto', { url: '/app' });
    expect((await send<{ text: string }>('text')).text).toContain('Привет, ivan');

    // origin сравнивается целиком: текстовый префикс адреса не считается тем же origin, идёт навигация (сюда — на недоступный порт).
    const prefixOrigin = server.url.slice(0, -1);
    await expect(send('state.import', { state: { cookies: [], origins: [{ origin: prefixOrigin, localStorage: { leaked: 'yes' }, sessionStorage: {} }] } })).rejects.toBeTruthy();
    await send('goto', { url: '/app' });
    expect((await send<{ result: unknown }>('eval', { code: "localStorage.getItem('leaked')" })).result).toBeNull();
  });

  it('диалоги по политике, beforeunload не блокирует навигацию, скриншот, вкладки, viewport новых вкладок', async () => {
    await send('goto', { url: '/dialog' });
    await send('dialog', { action: 'accept' });
    await send('click', { target: '#ask' });
    expect((await send<{ text: string }>('text', { target: '#answer' })).text).toBe('да');
    await send('dialog', { action: 'dismiss' });
    await send('click', { target: '#ask' });
    expect((await send<{ text: string }>('text', { target: '#answer' })).text).toBe('нет');
    await send('goto', { url: '/unload' });
    await send('type', { target: '#draft', text: '!' });
    const away = await send<{ status: number; url: string }>('goto', { url: '/' });
    expect(away.status).toBe(200);
    expect(away.url).toBe(`${server.url}/`);
    const shot = await send<{ path: string }>('screenshot');
    expect(fs.readFileSync(shot.path).subarray(1, 4).toString()).toBe('PNG');
    await send('viewport', { width: 375, height: 812 });
    await send('page.new', { url: '/' });
    expect((await send<{ pages: unknown[] }>('pages')).pages).toHaveLength(2);
    expect((await send<{ result: unknown }>('eval', { code: '[innerWidth, innerHeight]' })).result).toEqual([375, 812]);
    await send('page.close');
    expect((await send<{ pages: unknown[] }>('pages')).pages).toHaveLength(1);
    await send('viewport', { width: 1000, height: 700 });
  });

  it('закрытие не текущей вкладки не сдвигает текущую; второй демон той же сессии отклоняется', async () => {
    await send('goto', { url: '/' });
    await send('page.new', { url: '/login' });
    await send('page.new', { url: '/dialog' });
    expect((await send<{ pages: { index: number; current: boolean; url: string }[] }>('pages')).pages.find((p) => p.current)?.url).toContain('/dialog');
    await send('page.close', { index: 0 });
    const pages = (await send<{ pages: { index: number; current: boolean; url: string }[] }>('pages')).pages;
    expect(pages).toHaveLength(2);
    expect(pages.find((p) => p.current)?.url).toContain('/dialog');
    await send('page.close', { index: 0 });
    await expect(startDaemon({ session, executable: exe!.path, headless: true, profile: null, viewport: { width: 800, height: 600 }, idleMinutes: 0, baseUrl: null, timeoutMs: 5000, cwd: process.cwd(), env, log: () => {} })).rejects.toMatchObject({ code: 'BROWSER_SESSION_EXISTS' });
    expect((await send<{ result: unknown }>('eval', { code: 'document.title' })).result).toBe('Диалог');
  });

  it('большой кириллический текст доходит без порчи на границах чанков', async () => {
    await send('goto', { url: '/big' });
    const { text, length, truncated } = await send<{ text: string; length: number; truncated: boolean }>('text', { target: '#big', limit: 200_000 });
    expect(truncated).toBe(false);
    expect(length).toBe(BIG_TEXT.trim().length);
    expect(text).toBe(BIG_TEXT.trim());
    expect(text.includes('�')).toBe(false);
  });

  it('ping отвечает во время долгого ожидания; ушедший клиент не блокирует очередь', async () => {
    const long = send('wait', { ms: 3000 });
    const started = Date.now();
    await new Promise((r) => setTimeout(r, 200));
    expect((await send<{ pid: number }>('ping', {}, 2_000)).pid).toBe(process.pid);
    expect(Date.now() - started).toBeLessThan(2_000);
    await long;
    // Клиент отваливается по своему таймауту: демон прерывает его ожидание, следующая команда не ждёт полные 5 секунд.
    await expect(send('wait', { ms: 5000 }, 300)).rejects.toMatchObject({ code: 'BROWSER_CLIENT_TIMEOUT' });
    const t0 = Date.now();
    await send('url');
    expect(Date.now() - t0).toBeLessThan(2_500);
  });
});

describe.skipIf(!exe)('browser: жизненный цикл демона', () => {
  const env = homeEnv('sbox-browser-life-');
  const base = { executable: exe?.path ?? '', headless: true, profile: null, viewport: { width: 800, height: 600 }, baseUrl: null, timeoutMs: 5000, cwd: process.cwd(), env, log: () => {} };

  it('простой не прерывает долгую команду и завершает демон после неё', async () => {
    const daemon = await startDaemon({ ...base, session: 'idle', idleMinutes: 0.03 });
    const waited = await sendCommand<{ waited: string[] }>('idle', 'wait', { ms: 3000 }, { env, timeoutMs: 20_000 });
    expect(waited.waited[0]).toContain('3000');
    const reason = await Promise.race([daemon.done, new Promise<string>((r) => setTimeout(() => r('timeout'), 8_000))]);
    expect(reason).toContain('простой');
    expect(readSession('idle', env)).toBeNull();
  }, 30_000);

  it('слишком большой idleMinutes не останавливает демон сразу', async () => {
    const daemon = await startDaemon({ ...base, session: 'forever', idleMinutes: 99_999 });
    await new Promise((r) => setTimeout(r, 300));
    expect((await sendCommand<{ pid: number }>('forever', 'ping', {}, { env })).pid).toBe(process.pid);
    await daemon.stop();
  }, 30_000);

  it('два одновременных запуска одной сессии: поднимается ровно один демон', async () => {
    const results = await Promise.allSettled([startDaemon({ ...base, session: 'race', idleMinutes: 0 }), startDaemon({ ...base, session: 'race', idleMinutes: 0 })]);
    const ok = results.filter((r): r is PromiseFulfilledResult<DaemonHandle> => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toMatchObject({ code: 'BROWSER_SESSION_EXISTS' });
    expect(readSession('race', env)?.pid).toBe(process.pid);
    await ok[0]!.value.stop();
    expect(readSession('race', env)).toBeNull();
  }, 60_000);
});

describe.skipIf(!exe || !fs.existsSync(distCli))('browser: демон в фоне через собранный CLI', () => {
  const env = homeEnv('sbox-browser-spawn-');
  let server: Awaited<ReturnType<typeof startServer>>;
  const bin = path.join(here, '..', 'bin', 'sbox-browser.js');
  // Сервер фикстуры живёт в этом же процессе, поэтому вызов CLI обязан быть асинхронным: синхронный exec заблокировал бы его.
  const run = async (...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [bin, ...args], { env, encoding: 'utf8' });
      return { code: 0, stdout, stderr };
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }
  };
  const json = async (...args: string[]): Promise<Record<string, unknown>> => {
    const r = await run('--json', '--session', 'cli', ...args);
    return JSON.parse(r.stdout) as Record<string, unknown>;
  };

  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => {
    await stopSession('spawned', env);
    await stopSession('cli', env);
    await server?.close();
  });

  it('spawnDaemon поднимает процесс, ping отвечает, stop завершает', async () => {
    const info = await spawnDaemon({ session: 'spawned', executable: exe!.path, headless: true, profile: null, viewport: { width: 800, height: 600 }, idleMinutes: 1, baseUrl: null, timeoutMs: 5000, cwd: process.cwd() }, { env });
    expect(info.pid).not.toBe(process.pid);
    const ping = await sendCommand<{ pid: number; pages: number }>('spawned', 'ping', {}, { env });
    expect(ping.pid).toBe(info.pid);
    const result = await stopSession('spawned', env);
    expect(result.stopped).toBe(true);
    expect(result.reason).toBe('stopped');
    expect(readSession('spawned', env)).toBeNull();
  }, 60_000);

  it('bin/sbox-browser.js: автозапуск сессии, JSON-вывод, stop во время долгого ожидания', async () => {
    const nav = await json('goto', `${server.url}/login`);
    expect(nav.ok).toBe(true);
    expect(nav.title).toBe('Вход');
    const snap = await json('snapshot', '--interactive');
    expect(String(snap.text)).toContain('button "Войти"');
    expect((await json('status')).running).toBe(true);
    const pending = run('--session', 'cli', 'wait', '--ms', '20000');
    await new Promise((r) => setTimeout(r, 500));
    const t0 = Date.now();
    const stopped = await json('stop');
    expect(stopped.stopped).toBe(true);
    expect(Date.now() - t0).toBeLessThan(10_000);
    const waited = await pending;
    expect(waited.code).not.toBe(0);
    expect(readSession('cli', env)).toBeNull();
  }, 60_000);

  it('ошибки разбора аргументов приходят в JSON-конверте', async () => {
    for (const args of [['--json', '--session', 'My_Session', 'url'], ['--json', '--timeout', 'abc', 'url'], ['--json', 'nosuchcommand'], ['--json', 'goto']]) {
      const r = await run(...args);
      expect(r.code).toBe(1);
      const body = JSON.parse(r.stdout) as { ok: boolean; status: { code: string }[] };
      expect(body.ok).toBe(false);
      expect(body.status[0]?.code).toBe('BROWSER_BAD_ARGS');
    }
    const help = await run('--json', 'goto', '--help');
    expect(help.code).toBe(0);
  }, 60_000);
});
