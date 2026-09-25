import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { z } from 'zod';
import type { Browser, CookieData, ElementHandle, HTTPResponse, Page, PuppeteerLifeCycleEvent, SerializedAXNode, WaitForOptions } from 'puppeteer-core';
import { sleep } from '../core/async.js';
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
  /** Текущая вкладка по ссылке: закрытие соседних вкладок её не сдвигает. */
  currentPage: PageState | null;
  /** Размер окна, заданный командой viewport: применяется и к вкладкам, открытым позже. */
  viewportOverride: { width: number; height: number } | null;
  current(): PageState;
  currentIndex(): number;
  attach(page: Page): PageState;
  dialogPolicy: { action: 'accept' | 'dismiss'; text?: string };
  startedAt: number;
}

/** Обработчик команды: сигнал отменяется, когда клиент закрыл соединение, чтобы долгое ожидание не держало очередь. */
export type Handler = (ctx: DaemonContext, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;

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

/** Разбирается ли код как обычный скрипт: проверка синтаксиса в Node, без отправки в страницу. */
function isScript(code: string): boolean {
  try {
    new vm.Script(code);
    return true;
  } catch (e) {
    return !(e instanceof SyntaxError);
  }
}

function pageOrigin(page: Page): string | null {
  try {
    return new URL(page.url()).origin;
  } catch {
    return null;
  }
}

/** Ссылка из снимка → живой ElementHandle; отсоединённый узел это BROWSER_REF_STALE, а не ошибка протокола. */
async function refHandle(state: PageState, ref: string): Promise<ElementHandle<Element>> {
  if (!state.snapshot) throw err('BROWSER_NO_SNAPSHOT', 'Ссылки [eN] появляются после `sbox-browser snapshot`.', 'Сделайте snapshot и возьмите ссылку из него.');
  const node = state.snapshot.refs.get(ref);
  if (!node) throw err('BROWSER_REF_UNKNOWN', `В последнем снимке нет ссылки ${ref}.`, 'Сделайте snapshot заново: ссылки нумеруются при каждом снимке.');
  let handle: ElementHandle | null = null;
  try {
    handle = await node.elementHandle();
  } catch {
    handle = null;
  }
  const connected = handle ? await handle.evaluate((el) => (el as Node).isConnected).catch(() => false) : false;
  if (!handle || !connected) {
    await handle?.dispose().catch(() => {});
    throw err('BROWSER_REF_STALE', `Элемент ${ref} исчез со страницы (снимок от ${state.snapshot.at}, ${state.snapshot.url}).`, 'Сделайте snapshot заново после изменения страницы.');
  }
  return handle as ElementHandle<Element>;
}

async function resolveHandle(ctx: DaemonContext, raw: string, opts: { timeout?: number; visible?: boolean; signal?: AbortSignal } = {}): Promise<ElementHandle<Element>> {
  const state = ctx.current();
  const t = parseTarget(raw);
  if (t.kind === 'ref') return refHandle(state, t.ref);
  const timeout = opts.timeout ?? ctx.settings.timeoutMs;
  try {
    const handle = await state.page.waitForSelector(t.selector, { timeout, visible: opts.visible ?? true, signal: opts.signal });
    if (!handle) throw new Error('пусто');
    return handle as ElementHandle<Element>;
  } catch (e) {
    throw err('BROWSER_TARGET_NOT_FOUND', `Элемент «${t.raw}» не найден за ${timeout} мс${opts.visible === false ? '' : ' (ожидался видимым)'}: ${(e as Error).message.split('\n')[0]}`, 'Сделайте `sbox-browser snapshot` и используйте ссылку [eN], либо проверьте селектор (text=, aria=, xpath=, css).');
  }
}

/** Handle живёт ровно на время действия: иначе Chrome держит элемент до навигации, а демон живёт часами. */
async function withHandle<T>(ctx: DaemonContext, raw: string, opts: { timeout?: number; visible?: boolean; signal?: AbortSignal }, fn: (handle: ElementHandle<Element>) => Promise<T>): Promise<T> {
  const handle = await resolveHandle(ctx, raw, opts);
  try {
    return await fn(handle);
  } finally {
    await handle.dispose().catch(() => {});
  }
}

async function elementInfo(handle: ElementHandle<Element>): Promise<{ tag: string; text: string }> {
  return handle.evaluate((el) => ({ tag: el.tagName.toLowerCase(), text: ((el as HTMLElement).innerText ?? el.textContent ?? '').trim().slice(0, 80) }));
}

function navigation(run: (page: Page, options: WaitForOptions) => Promise<HTTPResponse | null>): Handler {
  return async (ctx, raw, signal) => {
    const a = z.object({ wait: waitUntil, timeout: timeoutField }).parse(raw);
    const page = ctx.current().page;
    const response = await run(page, { waitUntil: lifecycle(a.wait), timeout: a.timeout ?? ctx.settings.timeoutMs, signal });
    return { url: page.url(), title: await page.title(), status: response?.status() ?? null };
  };
}

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
      current: ctx.currentIndex(),
      url: cur?.page.url() ?? null,
      uptimeMs: Date.now() - ctx.startedAt,
    };
  },

  /** Остановку выполняет демон после отправки ответа: обработчик только подтверждает команду. */
  async stop() {
    return { stopped: true };
  },

  async goto(ctx, raw, signal) {
    const a = z.object({ url: z.string().min(1), wait: waitUntil, timeout: timeoutField }).parse(raw);
    const url = resolveUrl(ctx, a.url);
    const page = ctx.current().page;
    const response = await page.goto(url, { waitUntil: lifecycle(a.wait), timeout: a.timeout ?? ctx.settings.timeoutMs, signal });
    return { url: page.url(), title: await page.title(), status: response?.status() ?? null };
  },

  back: navigation((page, o) => page.goBack(o)),
  forward: navigation((page, o) => page.goForward(o)),
  reload: navigation((page, o) => page.reload(o)),

  async url(ctx) {
    return { url: ctx.current().page.url() };
  },

  async title(ctx) {
    return { title: await ctx.current().page.title() };
  },

  async pages(ctx) {
    const list = await Promise.all(ctx.pages.map(async (s, index) => ({ index, url: s.page.url(), title: await s.page.title().catch(() => ''), current: s === ctx.currentPage })));
    return { pages: list };
  },

  async 'page.new'(ctx, raw) {
    const a = z.object({ url: z.string().optional() }).parse(raw);
    const page = await ctx.browser.newPage();
    const state = ctx.attach(page);
    ctx.currentPage = state;
    if (a.url) await page.goto(resolveUrl(ctx, a.url), { waitUntil: 'load', timeout: ctx.settings.timeoutMs });
    return { index: ctx.currentIndex(), url: page.url() };
  },

  async 'page.switch'(ctx, raw) {
    const a = z.object({ index: z.number().int().nonnegative() }).parse(raw);
    const state = ctx.pages[a.index];
    if (!state) throw err('BROWSER_PAGE_INDEX', `Нет вкладки с индексом ${a.index}; всего ${ctx.pages.length}.`);
    ctx.currentPage = state;
    await state.page.bringToFront();
    return { index: a.index, url: state.page.url() };
  },

  async 'page.close'(ctx, raw) {
    const a = z.object({ index: z.number().int().nonnegative().optional() }).parse(raw);
    const state = a.index === undefined ? ctx.current() : ctx.pages[a.index];
    if (!state) throw err('BROWSER_PAGE_INDEX', `Нет вкладки с индексом ${a.index}.`);
    if (ctx.pages.length === 1) {
      await state.page.goto('about:blank');
      return { closed: false, note: 'последняя вкладка очищена, а не закрыта' };
    }
    await state.page.close();
    return { closed: true, pages: ctx.pages.length };
  },

  async click(ctx, raw, signal) {
    const a = z.object({ target, button: z.enum(['left', 'right', 'middle']).optional(), count: z.number().int().positive().optional(), timeout: timeoutField }).parse(raw);
    return withHandle(ctx, a.target, { timeout: a.timeout, signal }, async (handle) => {
      const info = await elementInfo(handle);
      await handle.scrollIntoView().catch(() => {});
      await handle.click({ button: a.button ?? 'left', count: a.count ?? 1 });
      await sleep(50);
      return { clicked: info, url: ctx.current().page.url() };
    });
  },

  async hover(ctx, raw, signal) {
    const a = z.object({ target, timeout: timeoutField }).parse(raw);
    return withHandle(ctx, a.target, { timeout: a.timeout, signal }, async (handle) => {
      await handle.hover();
      return { hovered: await elementInfo(handle) };
    });
  },

  async focus(ctx, raw, signal) {
    const a = z.object({ target, timeout: timeoutField }).parse(raw);
    return withHandle(ctx, a.target, { timeout: a.timeout, signal }, async (handle) => {
      await handle.focus();
      return { focused: await elementInfo(handle) };
    });
  },

  async type(ctx, raw, signal) {
    const a = z.object({ target, text: z.string(), delay: z.number().nonnegative().optional(), clear: z.boolean().optional(), timeout: timeoutField }).parse(raw);
    return withHandle(ctx, a.target, { timeout: a.timeout, signal }, async (handle) => {
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
    });
  },

  async press(ctx, raw, signal) {
    const a = z.object({ key: z.string().min(1), target: z.string().optional(), timeout: timeoutField }).parse(raw);
    const page = ctx.current().page;
    if (a.target) await withHandle(ctx, a.target, { timeout: a.timeout, signal }, (handle) => handle.focus());
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

  async select(ctx, raw, signal) {
    const a = z.object({ target, values: z.array(z.string()).min(1), timeout: timeoutField }).parse(raw);
    return withHandle(ctx, a.target, { timeout: a.timeout, signal }, async (handle) => ({ selected: await handle.select(...a.values) }));
  },

  async check(ctx, raw, signal) {
    const a = z.object({ target, checked: z.boolean(), timeout: timeoutField }).parse(raw);
    return withHandle(ctx, a.target, { timeout: a.timeout, signal }, async (handle) => {
      const before = await handle.evaluate((el) => Boolean((el as HTMLInputElement).checked));
      if (before !== a.checked) await handle.click();
      const after = await handle.evaluate((el) => Boolean((el as HTMLInputElement).checked));
      return { checked: after, changed: before !== after };
    });
  },

  async upload(ctx, raw, signal) {
    const a = z.object({ target, files: z.array(z.string()).min(1), timeout: timeoutField }).parse(raw);
    for (const f of a.files) if (!fs.existsSync(f)) throw err('BROWSER_FILE_NOT_FOUND', `Файл для загрузки не найден: ${f}`);
    return withHandle(ctx, a.target, { timeout: a.timeout, visible: false, signal }, async (handle) => {
      await (handle as ElementHandle<HTMLInputElement>).uploadFile(...a.files);
      return { uploaded: a.files.map((f) => path.basename(f)) };
    });
  },

  async scroll(ctx, raw, signal) {
    const a = z.object({ target: z.string().optional(), dx: z.number().optional(), dy: z.number().optional(), timeout: timeoutField }).parse(raw);
    const page = ctx.current().page;
    if (a.target) {
      return withHandle(ctx, a.target, { timeout: a.timeout, visible: false, signal }, async (handle) => {
        await handle.scrollIntoView();
        return { scrolledTo: await elementInfo(handle) };
      });
    }
    const pos = await page.evaluate((dx, dy) => {
      window.scrollBy(dx, dy);
      return { x: window.scrollX, y: window.scrollY };
    }, a.dx ?? 0, a.dy ?? 600);
    return { position: pos };
  },

  async wait(ctx, raw, signal) {
    const a = z
      .object({ target: z.string().optional(), state: z.enum(['visible', 'hidden', 'attached']).optional(), text: z.string().optional(), url: z.string().optional(), fn: z.string().optional(), ms: z.number().nonnegative().optional(), timeout: timeoutField })
      .parse(raw);
    const page = ctx.current().page;
    const timeout = a.timeout ?? ctx.settings.timeoutMs;
    const done: string[] = [];
    if (a.ms !== undefined) {
      await sleep(a.ms, signal);
      done.push(`пауза ${a.ms} мс`);
    }
    if (a.target) {
      const t = parseTarget(a.target);
      if (t.kind === 'ref') throw err('BROWSER_WAIT_REF', 'Ожидание по ссылке [eN] не поддерживается: укажите селектор.');
      const state = a.state ?? 'visible';
      try {
        const handle = await page.waitForSelector(t.selector, { timeout, visible: state === 'visible', hidden: state === 'hidden', signal });
        await handle?.dispose().catch(() => {});
      } catch (e) {
        if (signal.aborted) throw err('BROWSER_ABORTED', 'Клиент отключился, ожидание прервано.');
        throw err('BROWSER_TIMEOUT', `Элемент «${t.raw}» не стал ${state} за ${timeout} мс: ${(e as Error).message.split('\n')[0]}`);
      }
      done.push(`${t.raw}: ${state}`);
    }
    if (a.text !== undefined) {
      try {
        const handle = await page.waitForFunction((needle: string) => (document.body?.innerText ?? '').includes(needle), { timeout, polling: 200, signal }, a.text);
        await handle.dispose().catch(() => {});
      } catch {
        if (signal.aborted) throw err('BROWSER_ABORTED', 'Клиент отключился, ожидание прервано.');
        throw err('BROWSER_TIMEOUT', `Текст «${a.text}» не появился за ${timeout} мс.`);
      }
      done.push(`текст «${a.text}»`);
    }
    if (a.url !== undefined) {
      const deadline = Date.now() + timeout;
      while (!urlMatches(page.url(), a.url)) {
        if (signal.aborted) throw err('BROWSER_ABORTED', 'Клиент отключился, ожидание прервано.');
        if (Date.now() > deadline) throw err('BROWSER_TIMEOUT', `Адрес не совпал с «${a.url}» за ${timeout} мс; сейчас ${page.url()}.`);
        await sleep(100, signal);
      }
      done.push(`url ${a.url}`);
    }
    if (a.fn !== undefined) {
      try {
        const handle = await page.waitForFunction(a.fn, { timeout, polling: 200, signal });
        await handle.dispose().catch(() => {});
      } catch (e) {
        if (signal.aborted) throw err('BROWSER_ABORTED', 'Клиент отключился, ожидание прервано.');
        throw err('BROWSER_TIMEOUT', `Условие «${a.fn}» не выполнилось за ${timeout} мс: ${(e as Error).message.split('\n')[0]}`);
      }
      done.push(`условие ${a.fn}`);
    }
    if (done.length === 0) throw err('BROWSER_WAIT_EMPTY', 'Укажите, чего ждать: элемент, --text, --url, --fn или --ms.');
    return { waited: done, url: page.url() };
  },

  async text(ctx, raw, signal) {
    const a = z.object({ target: z.string().optional(), limit: z.number().int().positive().optional(), timeout: timeoutField }).parse(raw);
    const page = ctx.current().page;
    const limit = a.limit ?? 20_000;
    // Обрезка внутри страницы: через CDP уходит только нужный кусок, а не мегабайты текста.
    const cut = a.target
      ? await withHandle(ctx, a.target, { timeout: a.timeout, visible: false, signal }, (handle) =>
          handle.evaluate((el, max) => {
            const s = ((el as HTMLElement).innerText ?? el.textContent ?? '').trim();
            return { text: s.slice(0, max), length: s.length };
          }, limit),
        )
      : await page.evaluate((max) => {
          const s = (document.body?.innerText ?? '').trim();
          return { text: s.slice(0, max), length: s.length };
        }, limit);
    return { text: cut.text, truncated: cut.length > limit, length: cut.length, url: page.url() };
  },

  async html(ctx, raw, signal) {
    const a = z.object({ target: z.string().optional(), outer: z.boolean().optional(), limit: z.number().int().positive().optional(), timeout: timeoutField }).parse(raw);
    const page = ctx.current().page;
    const limit = a.limit ?? 50_000;
    const cut = a.target
      ? await withHandle(ctx, a.target, { timeout: a.timeout, visible: false, signal }, (handle) =>
          handle.evaluate((el, outer, max) => {
            const s = outer ? el.outerHTML : el.innerHTML;
            return { html: s.slice(0, max), length: s.length };
          }, a.outer ?? true, limit),
        )
      : await page.evaluate((max) => {
          const s = document.documentElement?.outerHTML ?? '';
          return { html: s.slice(0, max), length: s.length };
        }, limit);
    return { html: cut.html, truncated: cut.length > limit, length: cut.length };
  },

  async attr(ctx, raw, signal) {
    const a = z.object({ target, name: z.string().min(1), timeout: timeoutField }).parse(raw);
    return withHandle(ctx, a.target, { timeout: a.timeout, visible: false, signal }, async (handle) => ({ name: a.name, value: await handle.evaluate((el, name) => el.getAttribute(name), a.name) }));
  },

  async value(ctx, raw, signal) {
    const a = z.object({ target, timeout: timeoutField }).parse(raw);
    return withHandle(ctx, a.target, { timeout: a.timeout, visible: false, signal }, async (handle) => ({ value: await handle.evaluate((el) => (el as HTMLInputElement).value ?? null) }));
  },

  async count(ctx, raw) {
    const a = z.object({ target }).parse(raw);
    const t = parseTarget(a.target);
    if (t.kind === 'ref') throw err('BROWSER_COUNT_REF', 'Подсчёт работает по селектору, а не по ссылке [eN].');
    // Считаем внутри страницы: без N remote-объектов на каждый вызов.
    const count = await ctx.current().page.$$eval(t.selector, (els) => els.length);
    return { count };
  },

  async exists(ctx, raw) {
    const a = z.object({ target }).parse(raw);
    const t = parseTarget(a.target);
    const state = ctx.current();
    if (t.kind === 'ref') {
      const node = state.snapshot?.refs.get(t.ref);
      if (!node) return { exists: false, visible: false };
      let handle: ElementHandle | null = null;
      try {
        handle = await node.elementHandle();
      } catch {
        handle = null;
      }
      if (!handle) return { exists: false, visible: false };
      try {
        const connected = await handle.evaluate((el) => (el as Node).isConnected).catch(() => false);
        const visible = connected ? await handle.isVisible().catch(() => false) : false;
        return { exists: connected, visible };
      } finally {
        await handle.dispose().catch(() => {});
      }
    }
    const handle = await state.page.$(t.selector);
    if (!handle) return { exists: false, visible: false };
    try {
      return { exists: true, visible: await handle.isVisible().catch(() => false) };
    } finally {
      await handle.dispose().catch(() => {});
    }
  },

  async eval(ctx, raw) {
    const a = z.object({ code: z.string().min(1) }).parse(raw);
    const page = ctx.current().page;
    // Валидный скрипт (выражение или список инструкций: значение последнего) исполняется как есть;
    // код с return или await на верхнем уровне синтаксически не скрипт, поэтому идёт как тело async-функции.
    const code = isScript(a.code) ? a.code : `(async () => { ${a.code} })()`;
    const result: unknown = await page.evaluate(code);
    return { result: result === undefined ? null : result };
  },

  async snapshot(ctx, raw, signal) {
    const a = z.object({ interactive: z.boolean().optional(), root: z.string().optional(), maxChars: z.number().int().positive().optional(), timeout: timeoutField }).parse(raw);
    const state = ctx.current();
    const root = a.root ? await resolveHandle(ctx, a.root, { timeout: a.timeout, visible: false, signal }) : undefined;
    try {
      const tree = await state.page.accessibility.snapshot({ interestingOnly: true, includeIframes: true, ...(root ? { root } : {}) });
      const rendered = renderSnapshot(tree, { interactiveOnly: a.interactive, maxChars: a.maxChars });
      state.snapshot = { refs: rendered.refs as Map<string, SerializedAXNode>, url: state.page.url(), at: new Date().toISOString() };
      return { url: state.page.url(), title: await state.page.title(), count: rendered.count, truncated: rendered.truncated, text: rendered.text };
    } finally {
      await root?.dispose().catch(() => {});
    }
  },

  async screenshot(ctx, raw, signal) {
    const a = z.object({ out: z.string().optional(), full: z.boolean().optional(), target: z.string().optional(), timeout: timeoutField }).parse(raw);
    const file = a.out ?? path.join(browserDirs.shots(ctx.env), `${ctx.session}-${timestampSlug()}.png`);
    ensureDir(path.dirname(file));
    const state = ctx.current();
    if (a.target) {
      await withHandle(ctx, a.target, { timeout: a.timeout, signal }, (handle) => handle.screenshot({ path: file as `${string}.png` }));
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
    if (/^https?:/.test(page.url())) {
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
      let wanted: string;
      try {
        wanted = new URL(o.origin).origin;
      } catch {
        throw err('BROWSER_BAD_ARGS', `Некорректный origin в файле состояния: ${o.origin}`);
      }
      // Сравнение origin целиком: префикс строки принял бы localhost:30001 за localhost:3000.
      if (pageOrigin(page) !== wanted) await page.goto(wanted, { waitUntil: 'domcontentloaded', timeout: ctx.settings.timeoutMs });
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
    ctx.viewportOverride = { width: a.width, height: a.height };
    ctx.settings.viewport = { ...ctx.viewportOverride };
    await ctx.current().page.setViewport(ctx.viewportOverride);
    return { viewport: ctx.viewportOverride };
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
