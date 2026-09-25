import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendCommand, spawnDaemon, stopSession } from '../src/browser/client.js';
import { startDaemon, type DaemonHandle } from '../src/browser/daemon.js';
import { resolveExecutable } from '../src/browser/executable.js';
import { readSession } from '../src/browser/session.js';
import type { LogEntry, NetEntry } from '../src/browser/commands.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const exe = await resolveExecutable({ cacheDir: path.join(os.tmpdir(), 'sbox-no-cache') });
const distCli = path.join(here, '..', 'dist', 'browser', 'cli.js');

const PAGES: Record<string, string> = {
  '/': `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Главная</title></head><body>
<h1>Витрина</h1>
<nav><a href="/login">Вход</a> <a href="/app">Кабинет</a> <a href="/dialog">Диалоги</a></nav>
<label>Поиск <input id="q" type="text"></label>
<button id="counter" type="button" onclick="document.getElementById('count').textContent = String(Number(document.getElementById('count').textContent) + 1)">Счётчик</button>
<span id="count">0</span>
<label><input id="agree" type="checkbox"> Согласен</label>
<label>Сорт <select id="sort"><option value="asc">По возрастанию</option><option value="desc">По убыванию</option></select></label>
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

describe.skipIf(!exe)('browser: сквозной прогон на локальном сервере', () => {
  const env: NodeJS.ProcessEnv = { ...process.env, SBOX_BROWSER_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'sbox-browser-e2e-')) };
  const session = 'e2e';
  let server: Awaited<ReturnType<typeof startServer>>;
  let daemon: DaemonHandle;
  const send = <T = Record<string, unknown>>(cmd: string, args: Record<string, unknown> = {}) => sendCommand<T>(session, cmd, args, { env });

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
  });

  it('снимок даёт ссылки, по которым работают ввод и клик', async () => {
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
  });

  it('ждёт появления текста и сообщает об истечении таймаута кодом', async () => {
    const waited = await send<{ waited: string[] }>('wait', { text: 'Появилось позже' });
    expect(waited.waited[0]).toContain('Появилось позже');
    await expect(send('wait', { target: '#nope', timeout: 300 })).rejects.toMatchObject({ code: 'BROWSER_TIMEOUT' });
    await expect(send('click', { target: '#nope', timeout: 300 })).rejects.toMatchObject({ code: 'BROWSER_TARGET_NOT_FOUND' });
    await expect(send('click', { target: '@e999' })).rejects.toMatchObject({ code: 'BROWSER_REF_UNKNOWN' });
  });

  it('собирает консоль, ошибки страницы и неудачные запросы', async () => {
    const { entries } = await send<{ entries: LogEntry[] }>('console');
    expect(entries.map((e) => `${e.type}:${e.text}`)).toEqual(expect.arrayContaining(['log:hello', 'error:boom']));
    const errors = await send<{ entries: LogEntry[] }>('console', { errors: true, clear: true });
    expect(errors.entries.every((e) => e.type === 'error')).toBe(true);
    expect((await send<{ entries: LogEntry[] }>('console')).entries).toHaveLength(0);
    const net = await send<{ entries: NetEntry[] }>('requests');
    expect(net.entries.some((e) => e.status === 404 && e.url.endsWith('/api/missing'))).toBe(true);
    expect((await send<{ result: unknown }>('eval', { code: '1 + 2' })).result).toBe(3);
    expect((await send<{ result: unknown }>('eval', { code: 'const a = 2; return a * 21;' })).result).toBe(42);
  });

  it('вход через форму, куки, перенос состояния', async () => {
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
  });

  it('диалоги по политике, скриншот, вкладки', async () => {
    await send('goto', { url: '/dialog' });
    await send('dialog', { action: 'accept' });
    await send('click', { target: '#ask' });
    expect((await send<{ text: string }>('text', { target: '#answer' })).text).toBe('да');
    await send('dialog', { action: 'dismiss' });
    await send('click', { target: '#ask' });
    expect((await send<{ text: string }>('text', { target: '#answer' })).text).toBe('нет');
    const shot = await send<{ path: string }>('screenshot');
    expect(fs.readFileSync(shot.path).subarray(1, 4).toString()).toBe('PNG');
    await send('page.new', { url: '/' });
    expect((await send<{ pages: unknown[] }>('pages')).pages).toHaveLength(2);
    await send('page.close');
    expect((await send<{ pages: unknown[] }>('pages')).pages).toHaveLength(1);
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
});

describe.skipIf(!exe || !fs.existsSync(distCli))('browser: демон в фоне через собранный CLI', () => {
  const env: NodeJS.ProcessEnv = { ...process.env, SBOX_BROWSER_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'sbox-browser-spawn-')) };
  let server: Awaited<ReturnType<typeof startServer>>;

  beforeAll(async () => {
    server = await startServer();
  });
  afterAll(async () => {
    await stopSession('spawned', env);
    await stopSession('cli', env);
    await server?.close();
  });

  it('spawnDaemon поднимает процесс, ping отвечает, stop завершает', async () => {
    const info = await spawnDaemon('spawned', { executable: exe!.path, headless: true, profile: null, viewport: { width: 800, height: 600 }, idleMinutes: 1, baseUrl: null, timeoutMs: 5000, cwd: process.cwd() }, { env });
    expect(info.pid).not.toBe(process.pid);
    const ping = await sendCommand<{ pid: number; pages: number }>('spawned', 'ping', {}, { env });
    expect(ping.pid).toBe(info.pid);
    const result = await stopSession('spawned', env);
    expect(result.stopped).toBe(true);
    expect(readSession('spawned', env)).toBeNull();
  }, 60_000);

  it('bin/sbox-browser.js: автозапуск сессии и JSON-вывод', async () => {
    const bin = path.join(here, '..', 'bin', 'sbox-browser.js');
    // Сервер фикстуры живёт в этом же процессе, поэтому вызов CLI обязан быть асинхронным: синхронный exec заблокировал бы его.
    const run = async (...args: string[]): Promise<Record<string, unknown>> => {
      try {
        const { stdout } = await promisify(execFile)(process.execPath, [bin, '--json', '--session', 'cli', ...args], { env, encoding: 'utf8' });
        return JSON.parse(stdout) as Record<string, unknown>;
      } catch (e) {
        const err = e as { code?: number; stdout?: string; stderr?: string };
        throw new Error(`sbox-browser ${args.join(' ')} завершился с кодом ${err.code}\nstdout: ${err.stdout}\nstderr: ${err.stderr}`);
      }
    };
    const nav = await run('goto', `${server.url}/login`);
    expect(nav.ok).toBe(true);
    expect(nav.title).toBe('Вход');
    const snap = await run('snapshot', '--interactive');
    expect(String(snap.text)).toContain('button "Войти"');
    const status = await run('status');
    expect(status.running).toBe(true);
    const stopped = await run('stop');
    expect(stopped.stopped).toBe(true);
  }, 60_000);
});
