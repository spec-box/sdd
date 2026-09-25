import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Command } from 'commander';
import { SboxError } from '../core/errors.js';
import { packageRoot } from '../core/paths.js';
import { emit, emitError } from '../cli/output.js';
import { sendCommand, spawnDaemon, stopSession } from './client.js';
import { startDaemon } from './daemon.js';
import { listCandidates, notFoundError, resolveExecutable } from './executable.js';
import { INSTALLABLE, installBrowser, isInstallable, listInstalled, uninstallBrowser } from './install.js';
import { browserHome, expandHome } from './paths.js';
import { assertSessionName, listSessions, readSession, type SessionInfo } from './session.js';
import { loadBrowserSettings, parseViewport, type BrowserSettings, type SettingsFlags } from './settings.js';
import type { LogEntry, NetEntry } from './commands.js';

interface Globals {
  json: boolean;
  session: string;
  cwd?: string;
  timeout?: number;
}

function globals(cmd: Command): Globals {
  const g = cmd.optsWithGlobals() as { json: boolean; session: string; cwd?: string; timeout?: number };
  return { json: Boolean(g.json), session: assertSessionName(g.session ?? 'default'), cwd: g.cwd, timeout: g.timeout };
}

function readVersion(): string {
  try {
    return (JSON.parse(fs.readFileSync(path.join(packageRoot(), 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

const int = (v: string): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new SboxError('BROWSER_BAD_ARGS', `Ожидалось число, получено «${v}».`);
  return n;
};

const note = (g: Globals, text: string): void => {
  if (!g.json) process.stderr.write(`${text}\n`);
};

/** Сессия: работающая или поднятая только что по настройкам (флаги → окружение → конфиг). */
async function ensureSession(g: Globals, flags: SettingsFlags = {}): Promise<{ info: SessionInfo; settings: BrowserSettings; started: boolean }> {
  const settings = loadBrowserSettings({ cwd: g.cwd, timeout: g.timeout, ...flags });
  const existing = readSession(g.session);
  if (existing) return { info: existing, settings, started: false };
  const exe = await resolveExecutable({ explicit: settings.executable, cacheDir: settings.cacheDir, headed: !settings.headless });
  if (!exe) throw notFoundError();
  const info = await spawnDaemon(g.session, {
    executable: exe.path,
    headless: settings.headless,
    profile: settings.profile,
    viewport: settings.viewport,
    idleMinutes: settings.idleMinutes,
    baseUrl: settings.baseUrl,
    timeoutMs: settings.timeoutMs,
    cwd: settings.projectRoot ?? process.cwd(),
  });
  note(g, `сессия ${g.session} запущена: ${settings.headless ? 'headless' : 'окно'}, ${exe.path}${settings.profile ? `, профиль ${settings.profile}` : ''}`);
  return { info, settings, started: true };
}

async function send<T = Record<string, unknown>>(g: Globals, cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  await ensureSession(g);
  const withTimeout = g.timeout !== undefined && args.timeout === undefined ? { ...args, timeout: g.timeout } : args;
  return sendCommand<T>(g.session, cmd, withTimeout);
}

/** Обёртка действия команды: единый вывод ошибок и код выхода. */
function action<A extends unknown[]>(fn: (g: Globals, ...args: A) => Promise<void>) {
  return async (...all: unknown[]): Promise<void> => {
    const cmd = all[all.length - 1] as Command;
    const g = globals(cmd);
    try {
      await fn(g, ...(all.slice(0, -1) as A));
    } catch (e) {
      emitError(g, e);
      process.exitCode = 1;
    }
  };
}

function describeSession(s: SessionInfo): string {
  return `${s.name}: pid ${s.pid}, ${s.headless ? 'headless' : 'окно'}, ${s.executable}${s.profile ? `, профиль ${s.profile}` : ''}, с ${s.startedAt}`;
}

function formatLog(e: LogEntry): string {
  return `[${e.kind === 'console' ? e.type : e.kind}] ${e.text}${e.location ? ` (${e.location})` : ''}`;
}

function formatNet(e: NetEntry): string {
  return `${e.method} ${e.status ?? 'FAILED'} ${e.url}${e.failure ? ` — ${e.failure}` : ''} [${e.resourceType}]`;
}

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin });
    rl.once('line', () => {
      rl.close();
      resolve();
    });
  });
}

export function buildBrowserProgram(): Command {
  const program = new Command();
  program
    .name('sbox-browser')
    .description('Браузер для проверки интерфейса: команды для агентов и людей поверх puppeteer-core')
    .version(readVersion())
    .option('--json', 'один JSON-документ в stdout', false)
    .option('--session <name>', 'имя сессии браузера', 'default')
    .option('--cwd <dir>', 'корень проекта или каталог внутри него (для browser в .sbox/config.yaml)')
    .option('--timeout <ms>', 'таймаут действий и ожиданий, мс', int);

  // --- браузеры ---
  program
    .command('install')
    .description('Скачать браузер в кэш инструмента (~/.sbox/browser/cache); повторный вызов ничего не качает')
    .option('--browser <name>', `какой: ${INSTALLABLE.join(' | ')}`, 'chrome')
    .option('--build <tag>', 'stable | beta | dev | canary | latest | точный buildId (по умолчанию stable, для chromium latest)')
    .option('--cache-dir <dir>', 'куда ставить (по умолчанию из настроек)')
    .action(
      action(async (g, o: { browser: string; build?: string; cacheDir?: string }) => {
        if (!isInstallable(o.browser)) throw new SboxError('BROWSER_BAD_ARGS', `Неизвестный браузер «${o.browser}»; доступны ${INSTALLABLE.join(', ')}.`);
        const settings = loadBrowserSettings({ cwd: g.cwd, cacheDir: o.cacheDir });
        let lastPercent = -1;
        const result = await installBrowser({
          browser: o.browser,
          tag: o.build,
          cacheDir: settings.cacheDir,
          onProgress: (done, total) => {
            if (g.json || !total) return;
            const percent = Math.floor((done / total) * 100);
            if (percent !== lastPercent) {
              lastPercent = percent;
              process.stderr.write(`\rзагрузка ${o.browser}: ${percent}% (${Math.round(done / 1_048_576)} МБ)`);
              if (percent === 100) process.stderr.write('\n');
            }
          },
        });
        emit(g, { ...result, cacheDir: settings.cacheDir }, (d) => `${d.alreadyInstalled ? 'Уже установлен' : 'Установлен'} ${d.browser} ${d.buildId} (${d.platform})\n  ${d.executablePath}\nДальше: \`sbox-browser doctor\` покажет, какой браузер будет использован.`);
      }),
    );

  program
    .command('installed')
    .description('Браузеры в кэше инструмента')
    .action(
      action(async (g) => {
        const settings = loadBrowserSettings({ cwd: g.cwd });
        const list = await listInstalled(settings.cacheDir);
        emit(g, { cacheDir: settings.cacheDir, browsers: list }, (d) => (d.browsers.length ? d.browsers.map((b) => `${b.browser} ${b.buildId} (${b.platform})\n  ${b.executablePath}`).join('\n') : `Кэш ${d.cacheDir} пуст: \`sbox-browser install\` скачает Chrome.`));
      }),
    );

  program
    .command('uninstall')
    .description('Удалить браузер из кэша инструмента')
    .requiredOption('--browser <name>', 'chrome | chrome-headless-shell | chromium')
    .requiredOption('--build <buildId>', 'точный buildId из `sbox-browser installed`')
    .action(
      action(async (g, o: { browser: string; build: string }) => {
        const settings = loadBrowserSettings({ cwd: g.cwd });
        await uninstallBrowser({ browser: o.browser, buildId: o.build, cacheDir: settings.cacheDir });
        emit(g, { browser: o.browser, buildId: o.build }, (d) => `Удалён ${d.browser} ${d.buildId}.`);
      }),
    );

  program
    .command('doctor')
    .description('Какой браузер будет использован, откуда он взят, какие сессии работают')
    .action(
      action(async (g) => {
        const settings = loadBrowserSettings({ cwd: g.cwd });
        let candidates: Awaited<ReturnType<typeof listCandidates>> = [];
        let explicitError: string | null = null;
        try {
          candidates = await listCandidates({ explicit: settings.executable, cacheDir: settings.cacheDir });
        } catch (e) {
          explicitError = (e as Error).message;
          candidates = await listCandidates({ cacheDir: settings.cacheDir });
        }
        const chosen = candidates[0] ?? null;
        emit(g, { chosen, candidates, explicitError, home: browserHome(), cacheDir: settings.cacheDir, headless: settings.headless, profile: settings.profile, baseUrl: settings.baseUrl, projectRoot: settings.projectRoot, sessions: listSessions() }, (d) => {
          const lines: string[] = [];
          if (d.explicitError) lines.push(`[E] ${d.explicitError}`);
          lines.push(d.chosen ? `Будет использован: ${d.chosen.path} (${d.chosen.source}, ${d.chosen.browser}${d.chosen.buildId ? ` ${d.chosen.buildId}` : ''})` : '[W] Браузер не найден: `sbox-browser install` скачает Chrome, либо укажите существующий через --executable, SBOX_BROWSER_EXECUTABLE или browser.executable в конфиге.');
          if (d.candidates.length > 1) lines.push('Другие найденные:', ...d.candidates.slice(1).map((c) => `  ${c.path} (${c.source})`));
          lines.push(`Каталог инструмента: ${d.home}`, `Режим: ${d.headless ? 'headless' : 'окно'}${d.profile ? `, профиль ${d.profile}` : ', профиль не задан'}${d.baseUrl ? `, базовый URL ${d.baseUrl}` : ''}${d.projectRoot ? `, проект ${d.projectRoot}` : ''}`);
          lines.push(d.sessions.length ? `Сессии:\n${d.sessions.map((s) => `  ${describeSession(s)}`).join('\n')}` : 'Сессии: нет');
          return lines.join('\n');
        });
        if (!chosen) process.exitCode = 1;
      }),
    );

  // --- сессии ---
  program
    .command('start')
    .description('Запустить сессию браузера в фоне (обычно не нужно: команды страницы делают это сами)')
    .option('--headed', 'с окном, а не headless')
    .option('--profile <name>', 'постоянный профиль (куки, вход) в ~/.sbox/browser/profiles или путь к каталогу')
    .option('--executable <path>', 'исполняемый файл браузера')
    .option('--viewport <WxH>', 'размер окна, например 1280x800')
    .option('--idle <min>', 'минут без команд до самозавершения; 0 — не завершаться', int)
    .option('--base-url <url>', 'базовый адрес для относительных URL')
    .action(
      action(async (g, o: { headed?: boolean; profile?: string; executable?: string; viewport?: string; idle?: number; baseUrl?: string }) => {
        const existing = readSession(g.session);
        if (existing) {
          emit(g, { started: false, session: existing }, (d) => `Сессия уже работает: ${describeSession(d.session)}`);
          return;
        }
        const { info, settings } = await ensureSession(g, { headed: o.headed, profile: o.profile, executable: o.executable, viewport: o.viewport, idle: o.idle, baseUrl: o.baseUrl });
        emit(g, { started: true, session: info, settings: { headless: settings.headless, profile: settings.profile, baseUrl: settings.baseUrl } }, (d) => `Запущена ${describeSession(d.session)}`);
      }),
    );

  program
    .command('stop')
    .description('Остановить сессию и закрыть браузер')
    .action(
      action(async (g) => {
        const result = await stopSession(g.session);
        emit(g, { session: g.session, ...result }, (d) => (d.stopped ? `Сессия ${d.session} остановлена (pid ${d.pid}).` : `Сессия ${d.session} не была запущена.`));
      }),
    );

  program
    .command('status')
    .description('Состояние сессии: страницы, текущий адрес, режим')
    .action(
      action(async (g) => {
        const info = readSession(g.session);
        if (!info) {
          emit(g, { running: false, session: g.session }, (d) => `Сессия ${d.session} не запущена.`);
          return;
        }
        const ping = await sendCommand<{ pages: number; current: number; url: string | null; uptimeMs: number }>(g.session, 'ping');
        emit(g, { running: true, session: info, pages: ping.pages, current: ping.current, url: ping.url, uptimeMs: ping.uptimeMs }, (d) => `${describeSession(d.session)}\nвкладок: ${d.pages}, текущая: ${d.current} ${d.url ?? ''}`);
      }),
    );

  program
    .command('sessions')
    .description('Все работающие сессии')
    .action(
      action(async (g) => {
        const sessions = listSessions();
        emit(g, { sessions }, (d) => (d.sessions.length ? d.sessions.map(describeSession).join('\n') : 'Сессий нет.'));
      }),
    );

  // Глобальные --session, --timeout и --cwd commander разбирает в любой позиции, поэтому serve их не переопределяет.
  program
    .command('serve', { hidden: true })
    .description('Процесс демона (запускается клиентом)')
    .requiredOption('--executable <path>')
    .option('--headless')
    .option('--headed')
    .option('--viewport <WxH>', '', '1280x800')
    .option('--idle <min>', '', int, 30)
    .option('--profile <name>')
    .option('--base-url <url>')
    .action(async (o: { executable: string; headless?: boolean; headed?: boolean; viewport: string; idle: number; profile?: string; baseUrl?: string }, cmd: Command) => {
      const g = globals(cmd);
      const handle = await startDaemon({
        session: g.session,
        executable: expandHome(o.executable),
        headless: !o.headed,
        profile: o.profile ?? null,
        viewport: parseViewport(o.viewport),
        idleMinutes: o.idle,
        baseUrl: o.baseUrl ?? null,
        timeoutMs: g.timeout ?? 15_000,
        cwd: g.cwd ?? process.cwd(),
      });
      const shutdown = (): void => void handle.stop();
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      await handle.done;
      process.exit(0);
    });

  // --- вход человеком и перенос состояния ---
  program
    .command('login <url>')
    .description('Открыть окно браузера, чтобы человек вошёл в приложение; вход остаётся в профиле для следующих команд и сессий')
    .option('--profile <name>', 'постоянный профиль для сохранения входа (рекомендуется)')
    .option('--until <target>', 'считать вход завершённым, когда появится элемент (селектор)')
    .option('--until-url <pattern>', 'считать вход завершённым, когда адрес совпадёт с шаблоном (подстрока или glob)')
    .option('--minutes <n>', 'сколько ждать входа', int, 10)
    .option('--executable <path>', 'исполняемый файл браузера')
    .action(
      action(async (g, url: string, o: { profile?: string; until?: string; untilUrl?: string; minutes: number; executable?: string }) => {
        const settings = loadBrowserSettings({ cwd: g.cwd, headed: true, profile: o.profile, executable: o.executable, timeout: g.timeout });
        const existing = readSession(g.session);
        if (existing?.headless) throw new SboxError('BROWSER_SESSION_HEADLESS', `Сессия ${g.session} уже работает без окна.`, `Остановите её: \`sbox-browser stop --session ${g.session}\`, либо укажите другую --session.`);
        if (existing && settings.profile && existing.profile !== settings.profile) throw new SboxError('BROWSER_SESSION_PROFILE', `Сессия ${g.session} открыта с профилем ${existing.profile ?? '(без профиля)'}, а нужен ${settings.profile}.`, 'Остановите сессию или выберите другое имя --session.');
        await ensureSession(g, { headed: true, profile: o.profile, executable: o.executable });
        const nav = await sendCommand<{ url: string; title: string }>(g.session, 'goto', { url, wait: 'load' });
        if (!settings.profile) note(g, 'Профиль не задан: вход сохранится только пока работает эта сессия. Для постоянного входа укажите --profile <имя>.');
        const timeout = o.minutes * 60_000;
        if (o.until || o.untilUrl) {
          note(g, `Ожидание входа до ${o.minutes} мин: ${o.until ? `элемент ${o.until}` : ''}${o.untilUrl ? `адрес ${o.untilUrl}` : ''}`);
          await sendCommand(g.session, 'wait', { ...(o.until ? { target: o.until } : {}), ...(o.untilUrl ? { url: o.untilUrl } : {}), timeout }, { timeoutMs: timeout + 10_000 });
        } else if (process.stdin.isTTY) {
          process.stderr.write(`Открыто ${nav.url}. Войдите в приложение в окне браузера и нажмите Enter здесь.\n`);
          await waitForEnter();
        } else {
          throw new SboxError('BROWSER_LOGIN_NEEDS_TTY', 'Нет терминала, чтобы дождаться подтверждения входа.', 'Укажите --until <селектор> или --until-url <шаблон>: вход завершится автоматически.');
        }
        const { url: current } = await sendCommand<{ url: string }>(g.session, 'url');
        const { cookies } = await sendCommand<{ cookies: { domain: string }[] }>(g.session, 'cookies', { action: 'list' });
        const host = new URL(current).hostname;
        const relevant = cookies.filter((c) => host === c.domain.replace(/^\./, '') || host.endsWith(c.domain.startsWith('.') ? c.domain : `.${c.domain}`)).length;
        emit(g, { url: current, profile: settings.profile, cookies: relevant, session: g.session }, (d) =>
          [
            `Вход завершён: ${d.url}, куки для этого хоста: ${d.cookies}${d.profile ? `, профиль ${d.profile}` : ''}.`,
            `Эта сессия остаётся открытой с окном: команды \`sbox-browser goto …\` продолжат работу под входом.`,
            ...(d.profile
              ? [`Headless-работа под этим профилем: \`sbox-browser stop\`, затем любая команда с \`--profile ${d.profile}\` или browser.profile: ${d.profile} в .sbox/config.yaml.`]
              : []),
            `Перенос входа в CI или на другую машину: \`sbox-browser state save auth.json\` (секрет, не коммитить) и там \`sbox-browser state load auth.json\`.`,
          ].join('\n'),
        );
      }),
    );

  const state = program.command('state').description('Куки и storage текущей сессии: сохранить в файл или восстановить');
  state
    .command('save <file>')
    .description('Сохранить куки браузера и storage текущей страницы в JSON (секрет)')
    .action(
      action(async (g, file: string) => {
        const { state: data } = await send<{ state: { cookies: unknown[]; origins: unknown[] } }>(g, 'state.export');
        const out = path.resolve(file);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
        emit(g, { file: out, cookies: data.cookies.length, origins: data.origins.length }, (d) => `Состояние сохранено: ${d.file} (куки: ${d.cookies}, origins со storage: ${d.origins}). Файл содержит секреты входа: не коммитьте его.`);
      }),
    );
  state
    .command('load <file>')
    .description('Восстановить куки и storage из файла в текущую сессию')
    .action(
      action(async (g, file: string) => {
        const data = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as unknown;
        const result = await send<{ cookies: number; origins: number }>(g, 'state.import', { state: data });
        emit(g, { file: path.resolve(file), ...result }, (d) => `Восстановлено: куки ${d.cookies}, origins со storage ${d.origins}.`);
      }),
    );

  // --- навигация ---
  program
    .command('goto <url>')
    .description('Открыть адрес (относительный — от базового URL)')
    .option('--wait <event>', 'load | domcontentloaded | networkidle', 'load')
    .action(action(async (g, url: string, o: { wait: string }) => emit(g, await send(g, 'goto', { url, wait: o.wait }), (d) => `${String(d.status ?? '—')} ${String(d.url)}\n${String(d.title)}`)));
  for (const name of ['back', 'forward', 'reload'] as const) {
    program
      .command(name)
      .description({ back: 'Назад по истории', forward: 'Вперёд по истории', reload: 'Перезагрузить страницу' }[name])
      .option('--wait <event>', 'load | domcontentloaded | networkidle', 'load')
      .action(action(async (g, o: { wait: string }) => emit(g, await send(g, name, { wait: o.wait }), (d) => `${String(d.url)}\n${String(d.title)}`)));
  }
  program.command('url').description('Текущий адрес').action(action(async (g) => emit(g, await send(g, 'url'), (d) => String(d.url))));
  program.command('title').description('Заголовок страницы').action(action(async (g) => emit(g, await send(g, 'title'), (d) => String(d.title))));

  program
    .command('pages')
    .description('Список вкладок')
    .action(action(async (g) => emit(g, await send<{ pages: { index: number; url: string; title: string; current: boolean }[] }>(g, 'pages'), (d) => d.pages.map((p) => `${p.current ? '*' : ' '} ${p.index}: ${p.url} — ${p.title}`).join('\n'))));
  const page = program.command('page').description('Вкладки: new, switch, close');
  page.command('new [url]').description('Открыть вкладку и сделать текущей').action(action(async (g, url?: string) => emit(g, await send(g, 'page.new', url ? { url } : {}), (d) => `вкладка ${String(d.index)}: ${String(d.url)}`)));
  page.command('switch <index>').description('Переключиться на вкладку').action(action(async (g, index: string) => emit(g, await send(g, 'page.switch', { index: int(index) }), (d) => `вкладка ${String(d.index)}: ${String(d.url)}`)));
  page.command('close [index]').description('Закрыть вкладку (по умолчанию текущую)').action(action(async (g, index?: string) => emit(g, await send(g, 'page.close', index !== undefined ? { index: int(index) } : {}), (d) => (d.closed ? `закрыта; вкладок: ${String(d.pages)}` : String(d.note)))));

  // --- действия ---
  program
    .command('click <target>')
    .description('Кликнуть по элементу: [eN] из снимка, CSS, text=…, aria=…, xpath=…')
    .option('--right', 'правой кнопкой')
    .option('--middle', 'средней кнопкой')
    .option('--double', 'двойной клик')
    .action(action(async (g, target: string, o: { right?: boolean; middle?: boolean; double?: boolean }) => emit(g, await send<{ clicked: { tag: string; text: string }; url: string }>(g, 'click', { target, button: o.right ? 'right' : o.middle ? 'middle' : 'left', count: o.double ? 2 : 1 }), (d) => `клик: <${d.clicked.tag}> «${d.clicked.text}» → ${d.url}`)));
  program.command('hover <target>').description('Навести курсор').action(action(async (g, target: string) => emit(g, await send<{ hovered: { tag: string; text: string } }>(g, 'hover', { target }), (d) => `наведено: <${d.hovered.tag}> «${d.hovered.text}»`)));
  program.command('focus <target>').description('Установить фокус').action(action(async (g, target: string) => emit(g, await send<{ focused: { tag: string; text: string } }>(g, 'focus', { target }), (d) => `фокус: <${d.focused.tag}> «${d.focused.text}»`)));
  program
    .command('type <target> <text>')
    .description('Напечатать текст в элемент (добавляя к имеющемуся)')
    .option('--delay <ms>', 'задержка между символами', int)
    .option('--clear', 'сначала очистить поле')
    .action(action(async (g, target: string, text: string, o: { delay?: number; clear?: boolean }) => emit(g, await send(g, 'type', { target, text, delay: o.delay, clear: o.clear }), (d) => `введено ${String(d.typed)} символов, значение: ${String(d.value)}`)));
  program.command('fill <target> <text>').description('Очистить поле и ввести текст').action(action(async (g, target: string, text: string) => emit(g, await send(g, 'type', { target, text, clear: true }), (d) => `значение: ${String(d.value)}`)));
  program
    .command('press <key>')
    .description('Нажать клавишу: Enter, Tab, Escape, ArrowDown, Control+a …')
    .option('--target <target>', 'сначала сфокусировать элемент')
    .action(action(async (g, key: string, o: { target?: string }) => emit(g, await send(g, 'press', { key, target: o.target }), (d) => `нажато ${String(d.pressed)} → ${String(d.url)}`)));
  program.command('select <target> <values...>').description('Выбрать значения в <select>').action(action(async (g, target: string, values: string[]) => emit(g, await send<{ selected: string[] }>(g, 'select', { target, values }), (d) => `выбрано: ${d.selected.join(', ')}`)));
  program.command('check <target>').description('Включить флажок или переключатель').action(action(async (g, target: string) => emit(g, await send(g, 'check', { target, checked: true }), (d) => `checked: ${String(d.checked)}`)));
  program.command('uncheck <target>').description('Снять флажок').action(action(async (g, target: string) => emit(g, await send(g, 'check', { target, checked: false }), (d) => `checked: ${String(d.checked)}`)));
  program.command('upload <target> <files...>').description('Загрузить файлы в <input type=file>').action(action(async (g, target: string, files: string[]) => emit(g, await send<{ uploaded: string[] }>(g, 'upload', { target, files: files.map((f) => path.resolve(f)) }), (d) => `загружено: ${d.uploaded.join(', ')}`)));
  program
    .command('scroll [target]')
    .description('Прокрутить к элементу или страницу на число пикселей')
    .option('--down <px>', 'вниз', int)
    .option('--up <px>', 'вверх', int)
    .action(action(async (g, target: string | undefined, o: { down?: number; up?: number }) => emit(g, await send(g, 'scroll', { target, dy: o.up !== undefined ? -o.up : (o.down ?? 600) }), (d) => (d.scrolledTo ? `прокручено к элементу` : `позиция: ${JSON.stringify(d.position)}`))));

  program
    .command('wait [target]')
    .description('Дождаться элемента, текста, адреса, условия или паузы')
    .option('--hidden', 'ждать исчезновения элемента')
    .option('--attached', 'достаточно присутствия в DOM, без видимости')
    .option('--text <text>', 'текст появился на странице')
    .option('--url <pattern>', 'адрес совпал: подстрока или glob')
    .option('--fn <js>', 'JS-выражение стало истинным')
    .option('--ms <n>', 'просто пауза', int)
    .action(action(async (g, target: string | undefined, o: { hidden?: boolean; attached?: boolean; text?: string; url?: string; fn?: string; ms?: number }) => emit(g, await send<{ waited: string[]; url: string }>(g, 'wait', { target, state: o.hidden ? 'hidden' : o.attached ? 'attached' : undefined, text: o.text, url: o.url, fn: o.fn, ms: o.ms }), (d) => `дождались: ${d.waited.join('; ')} → ${d.url}`)));

  // --- чтение ---
  program
    .command('text [target]')
    .description('Видимый текст страницы или элемента')
    .option('--limit <chars>', 'обрезать до N символов', int)
    .action(action(async (g, target: string | undefined, o: { limit?: number }) => emit(g, await send<{ text: string; truncated: boolean; length: number }>(g, 'text', { target, limit: o.limit }), (d) => `${d.text}${d.truncated ? `\n… (обрезано: всего ${d.length} символов)` : ''}`)));
  program
    .command('html [target]')
    .description('HTML страницы или элемента')
    .option('--inner', 'innerHTML вместо outerHTML')
    .option('--limit <chars>', 'обрезать до N символов', int)
    .action(action(async (g, target: string | undefined, o: { inner?: boolean; limit?: number }) => emit(g, await send<{ html: string; truncated: boolean; length: number }>(g, 'html', { target, outer: !o.inner, limit: o.limit }), (d) => `${d.html}${d.truncated ? `\n… (обрезано: всего ${d.length} символов)` : ''}`)));
  program.command('attr <target> <name>').description('Значение атрибута').action(action(async (g, target: string, name: string) => emit(g, await send(g, 'attr', { target, name }), (d) => String(d.value ?? ''))));
  program.command('value <target>').description('Значение поля ввода').action(action(async (g, target: string) => emit(g, await send(g, 'value', { target }), (d) => String(d.value ?? ''))));
  program.command('count <target>').description('Сколько элементов подходит под селектор').action(action(async (g, target: string) => emit(g, await send(g, 'count', { target }), (d) => String(d.count))));
  program.command('exists <target>').description('Есть ли элемент (без ожидания)').action(action(async (g, target: string) => emit(g, await send(g, 'exists', { target }), (d) => (d.exists ? `есть${d.visible ? ', видим' : ', скрыт'}` : 'нет'))));
  program.command('eval <code>').description('Выполнить JS на странице и вернуть результат (JSON)').action(action(async (g, code: string) => emit(g, await send(g, 'eval', { code }), (d) => JSON.stringify(d.result, null, 2))));
  program
    .command('snapshot')
    .description('Снимок дерева доступности со ссылками [eN] для click/type/fill')
    .option('--interactive', 'только элементы, с которыми можно взаимодействовать')
    .option('--root <target>', 'только поддерево элемента')
    .option('--max <chars>', 'предел размера', int)
    .action(action(async (g, o: { interactive?: boolean; root?: string; max?: number }) => emit(g, await send<{ url: string; title: string; count: number; text: string; truncated: boolean }>(g, 'snapshot', { interactive: o.interactive, root: o.root, maxChars: o.max }), (d) => `# ${d.url} — ${d.title} (${d.count} элементов)\n${d.text}`)));
  program
    .command('screenshot')
    .description('Снимок экрана в PNG; путь печатается')
    .option('--out <file>', 'куда сохранить (по умолчанию ~/.sbox/browser/shots)')
    .option('--full', 'вся страница, а не окно')
    .option('--target <target>', 'только элемент')
    .action(action(async (g, o: { out?: string; full?: boolean; target?: string }) => emit(g, await send(g, 'screenshot', { out: o.out ? path.resolve(o.out) : undefined, full: o.full, target: o.target }), (d) => String(d.path))));
  program
    .command('console')
    .description('Сообщения консоли и ошибки страницы с момента открытия (или последней очистки)')
    .option('--clear', 'очистить после чтения')
    .option('--errors', 'только ошибки')
    .action(action(async (g, o: { clear?: boolean; errors?: boolean }) => emit(g, await send<{ entries: LogEntry[] }>(g, 'console', { clear: o.clear, errors: o.errors }), (d) => (d.entries.length ? d.entries.map(formatLog).join('\n') : 'консоль пуста'))));
  program
    .command('requests')
    .description('Неудачные запросы и ответы 4xx/5xx')
    .option('--clear', 'очистить после чтения')
    .action(action(async (g, o: { clear?: boolean }) => emit(g, await send<{ entries: NetEntry[] }>(g, 'requests', { clear: o.clear }), (d) => (d.entries.length ? d.entries.map(formatNet).join('\n') : 'сетевых ошибок нет'))));

  // --- окружение страницы ---
  const cookies = program.command('cookies').description('Куки браузера: list, set, clear');
  cookies.command('list').description('Все куки').action(action(async (g) => emit(g, await send<{ cookies: { name: string; value: string; domain: string; path: string }[] }>(g, 'cookies', { action: 'list' }), (d) => (d.cookies.length ? d.cookies.map((c) => `${c.name}=${c.value.length > 40 ? `${c.value.slice(0, 40)}…` : c.value}; domain=${c.domain}; path=${c.path}`).join('\n') : 'кук нет'))));
  cookies.command('clear').description('Удалить все куки').action(action(async (g) => emit(g, await send(g, 'cookies', { action: 'clear' }), (d) => `удалено: ${String(d.cleared)}`)));
  cookies
    .command('set <name> <value>')
    .description('Поставить куку (домен текущей страницы, если не указан)')
    .option('--domain <domain>')
    .option('--url <url>')
    .option('--path <path>', '', '/')
    .option('--secure')
    .option('--http-only')
    .action(action(async (g, name: string, value: string, o: { domain?: string; url?: string; path: string; secure?: boolean; httpOnly?: boolean }) => emit(g, await send(g, 'cookies', { action: 'set', cookies: [{ name, value, domain: o.domain, url: o.url, path: o.path, secure: o.secure, httpOnly: o.httpOnly }] }), (d) => `установлено: ${String(d.set)}`)));
  program.command('viewport <WxH>').description('Размер окна, например 1280x800').action(action(async (g, size: string) => emit(g, await send(g, 'viewport', parseViewport(size)), (d) => JSON.stringify(d.viewport))));
  program
    .command('dialog [action]')
    .description('Политика для alert/confirm/prompt: accept | dismiss; без аргумента — показать текущую и последние диалоги')
    .option('--text <text>', 'ответ для prompt')
    .action(action(async (g, act: string | undefined, o: { text?: string }) => emit(g, await send<{ policy: { action: string; text?: string }; recent: LogEntry[] }>(g, 'dialog', { action: act, text: o.text }), (d) => `политика: ${d.policy.action}${d.policy.text !== undefined ? ` («${d.policy.text}»)` : ''}${d.recent.length ? `\nпоследние: ${d.recent.map((e) => `${e.type}: ${e.text}`).join('; ')}` : ''}`)));
  program.command('auth <user> <password>').description('HTTP Basic-аутентификация для текущей вкладки').action(action(async (g, user: string, password: string) => emit(g, await send(g, 'auth', { username: user, password }), (d) => `basic auth: ${String(d.auth)}`)));
  program.command('headers <json>').description('Дополнительные HTTP-заголовки для текущей вкладки, JSON-объект').action(action(async (g, json: string) => emit(g, await send<{ headers: string[] }>(g, 'headers', { headers: JSON.parse(json) as Record<string, string> }), (d) => `заголовки: ${d.headers.join(', ')}`)));

  return program;
}

export async function main(argv: string[]): Promise<void> {
  await buildBrowserProgram().parseAsync(argv);
}

const invokedDirectly = process.argv[1] && /browser[\\/]cli\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  main(process.argv).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
