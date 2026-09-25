/// <reference lib="dom" />
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Browser, CookieData, ElementHandle, Page, PuppeteerLifeCycleEvent, SerializedAXNode } from 'puppeteer-core';
import { SboxError } from '../core/errors.js';
import { browserDirs, ensureDir, timestampSlug } from './paths.js';
import { parseKeyCombo } from './keys.js';
import { normalizeUrl, parseTarget, urlMatches } from './selectors.js';
import { renderSnapshot } from './snapshot.js';

/** Состояние одной вкладки: буферы консоли и сети, последний снимок со ссылками. */
export interface LogEntry {
  ts: string;
  kind: 'console' | 'pageerror' | 'dialog';
  type: string;
  text: string;
  location?: string;
}

export interface NetEntry {
  ts: string;
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  failure?: string;
}

export interface PageState {
  page: Page;
  console: LogEntry[];
  network: NetEntry[];
  snapshot: { refs: Map<string, SerializedAXNode>; url: string; at: string } | null;
}

export interface DaemonContext {
  browser: Browser;
  session: string;
  env: NodeJS.ProcessEnv;
  settings: { headless: boolean; executable: string; profile: string | null; baseUrl: string | null; timeoutMs: number; viewport: { width: number; height: number }; cwd: string };
  pages: PageState[];
  currentIndex: number;
  current(): PageState;
  attach(page: Page): PageState;
  dialogPolicy: { action: 'accept' | 'dismiss'; text?: string };
  startedAt: number;
  requestStop(): void;
}

export type Handler = (ctx: DaemonContext, args: Record<string, unknown>) => Promise<unknown>;

const BUFFER_LIMIT = 500;

export function pushLimited<T>(list: T[], item: T): void {
  list.push(item);
  if (list.length > BUFFER_LIMIT) list.splice(0, list.length - BUFFER_LIMIT);
}

const timeoutField = z.number().int().positive().optional();
const target = z.string().min(1);
const waitUntil = z.enum(['load', 'domcontentloaded', 'networkidle']).optional();

function lifecycle(w: 'load' | 'domcontentloaded' | 'networkidle' | undefined): PuppeteerLifeCycleEvent {
  return w === 'networkidle' ? 'networkidle2' : (w ?? 'load');
}

function err(code: string, message: string, fix?: string): SboxError {
  return new SboxError(code, message, fix);
}

function resolveUrl(ctx: DaemonContext, url: string): string {
  const resolved = normalizeUrl(url, ctx.settings.baseUrl);
  if (!resolved) throw err('BROWSER_RELATIVE_URL', `Относительный адрес «${url}» требует базового URL.`, 'Укажите browser.baseUrl в .sbox/config.yaml, --base-url при старте или полный адрес.');
  return resolved;
}

async function resolveHandle(ctx: DaemonContext, raw: string, opts: { timeout?: number; visible?: boolean } = {}): Promise<ElementHandle<Element>> {
  const state = ctx.current();
  const t = parseTarget(raw);
  if (t.kind === 'ref') {
    if (!state.snapshot) throw err('BROWSER_NO_SNAPSHOT', 'Ссылки [eN] появляются после `sbox-browser snapshot`.', 'Сделайте snapshot и возьмите ссылку из него.');
    const node = state.snapshot.refs.get(t.ref);
    if (!node) throw err('BROWSER_REF_UNKNOWN', `В последнем снимке нет ссылки ${t.ref}.`, 'Сделайте snapshot заново: ссылки нумеруются при каждом снимке.');
    let handle: ElementHandle | null = null;
    try {
      handle = await node.elementHandle();
    } catch {
      handle = null;
    }
    if (!handle) throw err('BROWSER_REF_STALE', `Элемент ${t.ref} исчез со страницы (снимок от ${state.snapshot.at}, ${state.snapshot.url}).`, 'Сделайте snapshot заново после изменения страницы.');
    return handle as ElementHandle<Element>;
  }
  const timeout = opts.timeout ?? ctx.settings.timeoutMs;
  try {
    const handle = await state.page.waitForSelector(t.selector, { timeout, visible: opts.visible ?? true });
    if (!handle) throw new Error('пусто');
    return handle as ElementHandle<Element>;
  } catch (e) {
    throw err('BROWSER_TARGET_NOT_FOUND', `Элемент «${t.raw}» не найден за ${timeout} мс${opts.visible === false ? '' : ' (ожидался видимым)'}: ${(e as Error).message.split('\n')[0]}`, 'Сделайте `sbox-browser snapshot` и используйте ссылку [eN], либо проверьте селектор (text=, aria=, xpath=, css).');
  }
}

async function elementInfo(handle: ElementHandle<Element>): Promise<{ tag: string; text: string }> {
  return handle.evaluate((el) => ({ tag: el.tagName.toLowerCase(), text: ((el as HTMLElement).innerText ?? el.textContent ?? '').trim().slice(0, 80) }));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const handlers: Record<string, Handler> = {
  async ping(ctx) {
    const cur = ctx.pages.length ? ctx.current() : null;
    return {
      pid: process.pid,
      session: ctx.session,
      headless: ctx.settings.headless,
      executable: ctx.settings.executable,
      profile: ctx.settings.profile,
      pages: ctx.pages.length,
      current: ctx.currentIndex,
      url: cur?.page.url() ?? null,
      uptimeMs: Date.now() - ctx.startedAt,
    };
  },

  async stop(ctx) {
    ctx.requestStop();
    return { stopped: true };
  },

  async goto(ctx, raw) {
    const a = z.object({ url: z.string().min(1), wait: waitUntil, timeout: timeoutField }).parse(raw);
    const url = resolveUrl(ctx, a.url);
    const page = ctx.current().page;
    const response = await page.goto(url, { waitUntil: lifecycle(a.wait), timeout: a.timeout ?? ctx.settings.timeoutMs });
    return { url: page.url(), title: await page.title(), status: response?.status() ?? null };
  },

  async back(ctx, raw) {
    const a = z.object({ wait: waitUntil, timeout: timeoutField }).parse(raw);
    const page = ctx.current().page;
    await page.goBack({ waitUntil: lifecycle(a.wait), timeout: a.timeout ?? ctx.settings.timeoutMs });
    return { url: page.url(), title: await page.title() };
  },

  async forward(ctx, raw) {
    const a = z.object({ wait: waitUntil, timeout: timeoutField }).parse(raw);
    const page = ctx.current().page;
    await page.goForward({ waitUntil: lifecycle(a.wait), timeout: a.timeout ?? ctx.settings.timeoutMs });
    return { url: page.url(), title: await page.title() };
  },

  async reload(ctx, raw) {
    const a = z.object({ wait: waitUntil, timeout: timeoutField }).parse(raw);
    const page = ctx.current().page;
    const response = await page.reload({ waitUntil: lifecycle(a.wait), timeout: a.timeout ?? ctx.settings.timeoutMs });
    return { url: page.url(), title: await page.title(), status: response?.status() ?? null };
  },

  async url(ctx) {
    return { url: ctx.current().page.url() };
  },

  async title(ctx) {
    return { title: await ctx.current().page.title() };
  },

  async pages(ctx) {
    const list = await Promise.all(ctx.pages.map(async (s, index) => ({ index, url: s.page.url(), title: await s.page.title().catch(() => ''), current: index === ctx.currentIndex })));
    return { pages: list };
  },

  async 'page.new'(ctx, raw) {
    const a = z.object({ url: z.string().optional() }).parse(raw);
    const page = await ctx.browser.newPage();
    const state = ctx.pages.find((s) => s.page === page) ?? ctx.attach(page);
    ctx.currentIndex = ctx.pages.indexOf(state);
    if (a.url) await page.goto(resolveUrl(ctx, a.url), { waitUntil: 'load', timeout: ctx.settings.timeoutMs });
    return { index: ctx.currentIndex, url: page.url() };
  },

  async 'page.switch'(ctx, raw) {
    const a = z.object({ index: z.number().int().nonnegative() }).parse(raw);
    if (!ctx.pages[a.index]) throw err('BROWSER_PAGE_INDEX', `Нет вкладки с индексом ${a.index}; всего ${ctx.pages.length}.`);
    ctx.currentIndex = a.index;
    await ctx.current().page.bringToFront();
    return { index: a.index, url: ctx.current().page.url() };
  },

  async 'page.close'(ctx, raw) {
    const a = z.object({ index: z.number().int().nonnegative().optional() }).parse(raw);
    const index = a.index ?? ctx.currentIndex;
    const state = ctx.pages[index];
    if (!state) throw err('BROWSER_PAGE_INDEX', `Нет вкладки с индексом ${index}.`);
    if (ctx.pages.length === 1) {
      await state.page.goto('about:blank');
      return { closed: false, note: 'последняя вкладка очищена, а не закрыта' };
    }
    await state.page.close();
    return { closed: true, pages: ctx.pages.length };
  },

  async click(ctx, raw) {
    const a = z.object({ target, button: z.enum(['left', 'right', 'middle']).optional(), count: z.number().int().positive().optional(), timeout: timeoutField }).parse(raw);
    const handle = await resolveHandle(ctx, a.target, { timeout: a.timeout });
    const info = await elementInfo(handle);
    await handle.scrollIntoView().catch(() => {});
    await handle.click({ button: a.button ?? 'left', count: a.count ?? 1 });
    await sleep(50);
    return { clicked: info, url: ctx.current().page.url() };
  },

  async hover(ctx, raw) {
    const a = z.object({ target, timeout: timeoutField }).parse(raw);
    const handle = await resolveHandle(ctx, a.target, { timeout: a.timeout });
    await handle.hover();
    return { hovered: await elementInfo(handle) };
  },

  async focus(ctx, raw) {
    const a = z.object({ target, timeout: timeoutField }).parse(raw);
    const handle = await resolveHandle(ctx, a.target, { timeout: a.timeout });
    await handle.focus();
    return { focused: await elementInfo(handle) };
  },

  async type(ctx, raw) {
    const a = z.object({ target, text: z.string(), delay: z.number().nonnegative().optional(), clear: z.boolean().optional(), timeout: timeoutField }).parse(raw);
    const handle = await resolveHandle(ctx, a.target, { timeout: a.timeout });
    await handle.focus();
    if (a.clear) {
      await handle.evaluate((el) => {
        const input = el as HTMLInputElement | HTMLTextAreaElement;
        if (typeof input.select === 'function') input.select();
        else if ((el as HTMLElement).isContentEditable) {
          const range = document.createRange();
          range.selectNodeContents(el);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
      });
      await ctx.current().page.keyboard.press('Backspace');
    }
    await handle.type(a.text, { delay: a.delay ?? 0 });
    const value = await handle.evaluate((el) => (el as HTMLInputElement).value ?? (el as HTMLElement).innerText ?? '');
    return { typed: a.text.length, value: String(value).slice(0, 200) };
  },

  async press(ctx, raw) {
    const a = z.object({ key: z.string().min(1), target: z.string().optional(), timeout: timeoutField }).parse(raw);
    const page = ctx.current().page;
    if (a.target) await (await resolveHandle(ctx, a.target, { timeout: a.timeout })).focus();
    const { modifiers, key } = parseKeyCombo(a.key);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const m of modifiers) await page.keyboard.down(m as any);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await page.keyboard.press(key as any);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const m of [...modifiers].reverse()) await page.keyboard.up(m as any);
    }
    await sleep(50);
    return { pressed: a.key, url: page.url() };
  },

  async select(ctx, raw) {
    const a = z.object({ target, values: z.array(z.string()).min(1), timeout: timeoutField }).parse(raw);
    const handle = await resolveHandle(ctx, a.target, { timeout: a.timeout });
    const selected = await handle.select(...a.values);
    return { selected };
  },

  async check(ctx, raw) {
    const a = z.object({ target, checked: z.boolean(), timeout: timeoutField }).parse(raw);
    const handle = await resolveHandle(ctx, a.target, { timeout: a.timeout });
    const before = await handle.evaluate((el) => Boolean((el as HTMLInputElement).checked));
    if (before !== a.checked) await handle.click();
    const after = await handle.evaluate((el) => Boolean((el as HTMLInputElement).checked));
    return { checked: after, changed: before !== after };
  },

  async upload(ctx, raw) {
    const a = z.object({ target, files: z.array(z.string()).min(1), timeout: timeoutField }).parse(raw);
    for (const f of a.files) if (!fs.existsSync(f)) throw err('BROWSER_FILE_NOT_FOUND', `Файл для загрузки не найден: ${f}`);
    const handle = await resolveHandle(ctx, a.target, { timeout: a.timeout, visible: false });
    await (handle as ElementHandle<HTMLInputElement>).uploadFile(...a.files);
    return { uploaded: a.files.map((f) => path.basename(f)) };
  },

  async scroll(ctx, raw) {
    const a = z.object({ target: z.string().optional(), dx: z.number().optional(), dy: z.number().optional(), timeout: timeoutField }).parse(raw);
    const page = ctx.current().page;
    if (a.target) {
      const handle = await resolveHandle(ctx, a.target, { timeout: a.timeout, visible: false });
      await handle.scrollIntoView();
      return { scrolledTo: await elementInfo(handle) };
    }
    const pos = await page.evaluate((dx, dy) => {
      window.scrollBy(dx, dy);
      return { x: window.scrollX, y: window.scrollY };
    }, a.dx ?? 0, a.dy ?? 600);
    return { position: pos };
  },

  async wait(ctx, raw) {
    const a = z
      .object({ target: z.string().optional(), state: z.enum(['visible', 'hidden', 'attached']).optional(), text: z.string().optional(), url: z.string().optional(), fn: z.string().optional(), ms: z.number().nonnegative().optional(), timeout: timeoutField })
      .parse(raw);
    const page = ctx.current().page;
    const timeout = a.timeout ?? ctx.settings.timeoutMs;
    const done: string[] = [];
    if (a.ms !== undefined) {
      await sleep(a.ms);
      done.push(`пауза ${a.ms} мс`);
    }
    if (a.target) {
      const t = parseTarget(a.target);
      if (t.kind === 'ref') throw err('BROWSER_WAIT_REF', 'Ожидание по ссылке [eN] не поддерживается: укажите селектор.');
      const state = a.state ?? 'visible';
      try {
        await page.waitForSelector(t.selector, { timeout, visible: state === 'visible', hidden: state === 'hidden' });
      } catch (e) {
        throw err('BROWSER_TIMEOUT', `Элемент «${t.raw}» не стал ${state} за ${timeout} мс: ${(e as Error).message.split('\n')[0]}`);
      }
      done.push(`${t.raw}: ${state}`);
    }
    if (a.text !== undefined) {
      try {
        await page.waitForFunction((needle: string) => (document.body?.innerText ?? '').includes(needle), { timeout, polling: 200 }, a.text);
      } catch {
        throw err('BROWSER_TIMEOUT', `Текст «${a.text}» не появился за ${timeout} мс.`);
      }
      done.push(`текст «${a.text}»`);
    }
    if (a.url !== undefined) {
      const deadline = Date.now() + timeout;
      while (!urlMatches(page.url(), a.url)) {
        if (Date.now() > deadline) throw err('BROWSER_TIMEOUT', `Адрес не совпал с «${a.url}» за ${timeout} мс; сейчас ${page.url()}.`);
        await sleep(100);
      }
      done.push(`url ${a.url}`);
    }
    if (a.fn !== undefined) {
      try {
        await page.waitForFunction(a.fn, { timeout, polling: 200 });
      } catch (e) {
        throw err('BROWSER_TIMEOUT', `Условие «${a.fn}» не выполнилось за ${timeout} мс: ${(e as Error).message.split('\n')[0]}`);
      }
      done.push(`условие ${a.fn}`);
    }
    if (done.length === 0) throw err('BROWSER_WAIT_EMPTY', 'Укажите, чего ждать: элемент, --text, --url, --fn или --ms.');
    return { waited: done, url: page.url() };
  },

  async text(ctx, raw) {
    const a = z.object({ target: z.string().optional(), limit: z.number().int().positive().optional(), timeout: timeoutField }).parse(raw);
    const page = ctx.current().page;
    const limit = a.limit ?? 20_000;
    let text: string;
    if (a.target) {
      const handle = await resolveHandle(ctx, a.target, { timeout: a.timeout, visible: false });
      text = await handle.evaluate((el) => ((el as HTMLElement).innerText ?? el.textContent ?? '').trim());
    } else {
      text = await page.evaluate(() => (document.body?.innerText ?? '').trim());
    }
    const truncated = text.length > limit;
    return { text: truncated ? text.slice(0, limit) : text, truncated, length: text.length, url: page.url() };
  },

  async html(ctx, raw) {
    const a = z.object({ target: z.string().optional(), outer: z.boolean().optional(), limit: z.number().int().positive().optional(), timeout: timeoutField }).parse(raw);
    const page = ctx.current().page;
    const limit = a.limit ?? 50_000;
    let html: string;
    if (a.target) {
      const handle = await resolveHandle(ctx, a.target, { timeout: a.timeout, visible: false });
      html = await handle.evaluate((el, outer) => (outer ? el.outerHTML : el.innerHTML), a.outer ?? true);
    } else {
      html = await page.content();
    }
    const truncated = html.length > limit;
    return { html: truncated ? html.slice(0, limit) : html, truncated, length: html.length };
  },

  async attr(ctx, raw) {
    const a = z.object({ target, name: z.string().min(1), timeout: timeoutField }).parse(raw);
    const handle = await resolveHandle(ctx, a.target, { timeout: a.timeout, visible: false });
    const value = await handle.evaluate((el, name) => el.getAttribute(name), a.name);
    return { name: a.name, value };
  },

  async value(ctx, raw) {
    const a = z.object({ target, timeout: timeoutField }).parse(raw);
    const handle = await resolveHandle(ctx, a.target, { timeout: a.timeout, visible: false });
    const value = await handle.evaluate((el) => (el as HTMLInputElement).value ?? null);
    return { value };
  },

  async count(ctx, raw) {
    const a = z.object({ target }).parse(raw);
    const t = parseTarget(a.target);
    if (t.kind === 'ref') throw err('BROWSER_COUNT_REF', 'Подсчёт работает по селектору, а не по ссылке [eN].');
    const list = await ctx.current().page.$$(t.selector);
    return { count: list.length };
  },

  async exists(ctx, raw) {
    const a = z.object({ target }).parse(raw);
    const t = parseTarget(a.target);
    if (t.kind === 'ref') return { exists: Boolean(ctx.current().snapshot?.refs.get(t.ref)) };
    const handle = await ctx.current().page.$(t.selector);
    const visible = handle ? await handle.isVisible().catch(() => false) : false;
    return { exists: Boolean(handle), visible };
  },

  async eval(ctx, raw) {
    const a = z.object({ code: z.string().min(1) }).parse(raw);
    const code = /\breturn\b|;\s*\S/.test(a.code) && !/^\s*\(?\s*(async\s*)?(\(|function\b)/.test(a.code) ? `(async () => { ${a.code} })()` : a.code;
    const result: unknown = await ctx.current().page.evaluate(code);
    return { result: result === undefined ? null : result };
  },

  async snapshot(ctx, raw) {
    const a = z.object({ interactive: z.boolean().optional(), root: z.string().optional(), maxChars: z.number().int().positive().optional(), timeout: timeoutField }).parse(raw);
    const state = ctx.current();
    const root = a.root ? await resolveHandle(ctx, a.root, { timeout: a.timeout, visible: false }) : undefined;
    const tree = await state.page.accessibility.snapshot({ interestingOnly: true, includeIframes: true, ...(root ? { root } : {}) });
    const rendered = renderSnapshot(tree, { interactiveOnly: a.interactive, maxChars: a.maxChars });
    state.snapshot = { refs: rendered.refs as Map<string, SerializedAXNode>, url: state.page.url(), at: new Date().toISOString() };
    return { url: state.page.url(), title: await state.page.title(), count: rendered.count, truncated: rendered.truncated, text: rendered.text };
  },

  async screenshot(ctx, raw) {
    const a = z.object({ out: z.string().optional(), full: z.boolean().optional(), target: z.string().optional(), timeout: timeoutField }).parse(raw);
    const file = a.out ?? path.join(browserDirs.shots(ctx.env), `${ctx.session}-${timestampSlug()}.png`);
    ensureDir(path.dirname(file));
    const state = ctx.current();
    if (a.target) {
      const handle = await resolveHandle(ctx, a.target, { timeout: a.timeout });
      await handle.screenshot({ path: file as `${string}.png` });
    } else {
      await state.page.screenshot({ path: file as `${string}.png`, fullPage: a.full ?? false });
    }
    return { path: file, url: state.page.url() };
  },

  async console(ctx, raw) {
    const a = z.object({ clear: z.boolean().optional(), errors: z.boolean().optional() }).parse(raw);
    const state = ctx.current();
    const entries = a.errors ? state.console.filter((e) => e.kind === 'pageerror' || e.type === 'error' || e.type === 'assert') : [...state.console];
    if (a.clear) state.console.length = 0;
    return { entries, url: state.page.url() };
  },

  async requests(ctx, raw) {
    const a = z.object({ clear: z.boolean().optional() }).parse(raw);
    const state = ctx.current();
    const entries = [...state.network];
    if (a.clear) state.network.length = 0;
    return { entries, url: state.page.url() };
  },

  async cookies(ctx, raw) {
    const a = z
      .object({ action: z.enum(['list', 'set', 'clear']), cookies: z.array(z.object({ name: z.string(), value: z.string(), domain: z.string().optional(), url: z.string().optional(), path: z.string().optional(), secure: z.boolean().optional(), httpOnly: z.boolean().optional() })).optional() })
      .parse(raw);
    const page = ctx.current().page;
    if (a.action === 'list') return { cookies: await ctx.browser.cookies() };
    if (a.action === 'clear') {
      const all = await ctx.browser.cookies();
      if (all.length) await ctx.browser.deleteCookie(...all);
      return { cleared: all.length };
    }
    const list = a.cookies ?? [];
    for (const c of list) {
      const url = c.url ?? page.url();
      const domain = c.domain ?? new URL(url).hostname;
      await ctx.browser.setCookie({ name: c.name, value: c.value, domain, path: c.path ?? '/', secure: c.secure, httpOnly: c.httpOnly });
    }
    return { set: list.length };
  },

  async 'state.export'(ctx) {
    const page = ctx.current().page;
    const cookies = await ctx.browser.cookies();
    const origins: { origin: string; localStorage: Record<string, string>; sessionStorage: Record<string, string> }[] = [];
    const url = page.url();
    if (/^https?:/.test(url)) {
      const storage = await page.evaluate(() => {
        const dump = (s: Storage): Record<string, string> => Object.fromEntries(Array.from({ length: s.length }, (_, i) => s.key(i)!).map((k) => [k, s.getItem(k) ?? '']));
        return { origin: location.origin, localStorage: dump(localStorage), sessionStorage: dump(sessionStorage) };
      });
      origins.push(storage);
    }
    return { state: { version: 1, savedAt: new Date().toISOString(), cookies, origins } };
  },

  async 'state.import'(ctx, raw) {
    const a = z
      .object({
        state: z.object({
          cookies: z.array(z.record(z.string(), z.unknown())).default([]),
          origins: z.array(z.object({ origin: z.string(), localStorage: z.record(z.string(), z.string()).default({}), sessionStorage: z.record(z.string(), z.string()).default({}) })).default([]),
        }),
      })
      .parse(raw);
    const cookies: CookieData[] = a.state.cookies.map((c) => {
      const pick = (k: string) => c[k];
      const data: CookieData = { name: String(pick('name')), value: String(pick('value')), domain: String(pick('domain')) };
      if (typeof pick('path') === 'string') data.path = pick('path') as string;
      if (typeof pick('secure') === 'boolean') data.secure = pick('secure') as boolean;
      if (typeof pick('httpOnly') === 'boolean') data.httpOnly = pick('httpOnly') as boolean;
      if (typeof pick('sameSite') === 'string') data.sameSite = pick('sameSite') as CookieData['sameSite'];
      if (typeof pick('expires') === 'number' && (pick('expires') as number) > 0) data.expires = pick('expires') as number;
      return data;
    });
    if (cookies.length) await ctx.browser.setCookie(...cookies);
    const page = ctx.current().page;
    let storages = 0;
    for (const o of a.state.origins) {
      const entries = Object.entries(o.localStorage);
      const sessionEntries = Object.entries(o.sessionStorage);
      if (entries.length === 0 && sessionEntries.length === 0) continue;
      if (!page.url().startsWith(o.origin)) await page.goto(o.origin, { waitUntil: 'domcontentloaded', timeout: ctx.settings.timeoutMs });
      await page.evaluate((ls, ss) => {
        for (const [k, v] of ls) localStorage.setItem(k, v);
        for (const [k, v] of ss) sessionStorage.setItem(k, v);
      }, entries, sessionEntries);
      storages += 1;
    }
    return { cookies: cookies.length, origins: storages };
  },

  async viewport(ctx, raw) {
    const a = z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).parse(raw);
    ctx.settings.viewport = { width: a.width, height: a.height };
    await ctx.current().page.setViewport({ width: a.width, height: a.height });
    return { viewport: ctx.settings.viewport };
  },

  async dialog(ctx, raw) {
    const a = z.object({ action: z.enum(['accept', 'dismiss']).optional(), text: z.string().optional() }).parse(raw);
    if (a.action) ctx.dialogPolicy = { action: a.action, ...(a.text !== undefined ? { text: a.text } : {}) };
    return { policy: ctx.dialogPolicy, recent: ctx.current().console.filter((e) => e.kind === 'dialog').slice(-5) };
  },

  async auth(ctx, raw) {
    const a = z.object({ username: z.string(), password: z.string() }).parse(raw);
    await ctx.current().page.authenticate({ username: a.username, password: a.password });
    return { auth: a.username };
  },

  async headers(ctx, raw) {
    const a = z.object({ headers: z.record(z.string(), z.string()) }).parse(raw);
    await ctx.current().page.setExtraHTTPHeaders(a.headers);
    return { headers: Object.keys(a.headers) };
  },
};
