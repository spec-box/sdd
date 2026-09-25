import fs from 'node:fs';
import path from 'node:path';
import { Browser, ChromeReleaseChannel, computeSystemExecutablePath, getInstalledBrowsers, type InstalledBrowser } from '@puppeteer/browsers';
import { SboxError } from '../core/errors.js';
import { puppeteerDefaultCache } from './paths.js';

export type ExecutableSource = 'flag' | 'env' | 'config' | 'cache' | 'puppeteer-cache' | 'system' | 'path';

export interface ResolvedExecutable {
  path: string;
  source: ExecutableSource;
  browser: string;
  buildId?: string;
}

export interface ResolveOptions {
  /** Явно заданный путь: флаг, переменная окружения или конфиг. Отсутствие файла это ошибка, а не переход к поиску. */
  explicit?: { path: string; source: ExecutableSource } | null;
  cacheDir: string;
  /** Кэш puppeteer других проектов; null отключает. */
  puppeteerCacheDir?: string | null;
  /** Для видимого окна chrome-headless-shell не годится. */
  headed?: boolean;
  /** Искать системные браузеры (каналы Chrome, известные пути). */
  system?: boolean;
  /** PATH для поиска по именам команд; null отключает. */
  pathEnv?: string | null;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

const CACHE_ORDER_HEADLESS = ['chrome', 'chrome-headless-shell', 'chromium'];
const CACHE_ORDER_HEADED = ['chrome', 'chromium'];
const PATH_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome', 'microsoft-edge', 'brave-browser'];

function knownPaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): { path: string; browser: string }[] {
  switch (platform) {
    case 'darwin':
      return [
        { path: '/Applications/Chromium.app/Contents/MacOS/Chromium', browser: 'chromium' },
        { path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', browser: 'edge' },
        { path: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', browser: 'brave' },
      ];
    case 'linux':
      return [
        { path: '/usr/bin/chromium', browser: 'chromium' },
        { path: '/usr/bin/chromium-browser', browser: 'chromium' },
        { path: '/snap/bin/chromium', browser: 'chromium' },
        { path: '/usr/bin/microsoft-edge', browser: 'edge' },
        { path: '/usr/bin/brave-browser', browser: 'brave' },
      ];
    case 'win32': {
      const pf = env.ProgramFiles ?? 'C:\\Program Files';
      const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
      const local = env.LOCALAPPDATA ?? '';
      return [
        { path: path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), browser: 'edge' },
        { path: path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), browser: 'edge' },
        { path: path.join(local, 'Chromium', 'Application', 'chrome.exe'), browser: 'chromium' },
        { path: path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'), browser: 'brave' },
      ];
    }
    default:
      return [];
  }
}

function compareBuild(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function fromCache(cacheDir: string, source: ExecutableSource, headed: boolean): Promise<ResolvedExecutable[]> {
  if (!fs.existsSync(cacheDir)) return [];
  let installed: InstalledBrowser[];
  try {
    installed = await getInstalledBrowsers({ cacheDir });
  } catch {
    return [];
  }
  const order = headed ? CACHE_ORDER_HEADED : CACHE_ORDER_HEADLESS;
  return installed
    .filter((b) => order.includes(b.browser) && fs.existsSync(b.executablePath))
    .sort((a, b) => order.indexOf(a.browser) - order.indexOf(b.browser) || compareBuild(b.buildId, a.buildId))
    .map((b) => ({ path: b.executablePath, source, browser: b.browser, buildId: b.buildId }));
}

function findInPath(name: string, pathEnv: string, platform: NodeJS.Platform): string | null {
  const names = platform === 'win32' ? [`${name}.exe`, name] : [name];
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    for (const n of names) {
      const candidate = path.join(dir, n);
      try {
        const st = fs.statSync(candidate);
        if (st.isFile()) return candidate;
      } catch {
        /* нет файла */
      }
    }
  }
  return null;
}

function fromSystem(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): ResolvedExecutable[] {
  const out: ResolvedExecutable[] = [];
  for (const channel of [ChromeReleaseChannel.STABLE, ChromeReleaseChannel.BETA, ChromeReleaseChannel.DEV, ChromeReleaseChannel.CANARY]) {
    try {
      const p = computeSystemExecutablePath({ browser: Browser.CHROME, channel });
      if (fs.existsSync(p)) out.push({ path: p, source: 'system', browser: channel === ChromeReleaseChannel.STABLE ? 'chrome' : `chrome-${channel}` });
    } catch {
      /* канал не установлен */
    }
  }
  for (const k of knownPaths(platform, env)) if (fs.existsSync(k.path)) out.push({ path: k.path, source: 'system', browser: k.browser });
  return out;
}

/** Все найденные браузеры в порядке предпочтения; для doctor и выбора. */
export async function listCandidates(opts: ResolveOptions): Promise<ResolvedExecutable[]> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const headed = opts.headed ?? false;
  const out: ResolvedExecutable[] = [];
  if (opts.explicit) {
    if (!fs.existsSync(opts.explicit.path)) {
      throw new SboxError('BROWSER_NOT_FOUND', `Исполняемый файл браузера не найден: ${opts.explicit.path} (источник: ${opts.explicit.source}).`, 'Проверьте путь или уберите его, чтобы включить автоматический поиск; `sbox-browser install` скачает Chrome.');
    }
    out.push({ path: opts.explicit.path, source: opts.explicit.source, browser: 'custom' });
  }
  out.push(...(await fromCache(opts.cacheDir, 'cache', headed)));
  const pcache = opts.puppeteerCacheDir === undefined ? puppeteerDefaultCache(env) : opts.puppeteerCacheDir;
  if (pcache) out.push(...(await fromCache(pcache, 'puppeteer-cache', headed)));
  if (opts.system ?? true) out.push(...fromSystem(platform, env));
  const pathEnv = opts.pathEnv === undefined ? (env.PATH ?? '') : opts.pathEnv;
  if (pathEnv) {
    for (const name of PATH_NAMES) {
      const p = findInPath(name, pathEnv, platform);
      if (p) out.push({ path: p, source: 'path', browser: name });
    }
  }
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.path) ? false : (seen.add(c.path), true)));
}

export async function resolveExecutable(opts: ResolveOptions): Promise<ResolvedExecutable | null> {
  return (await listCandidates(opts))[0] ?? null;
}

export function notFoundError(): SboxError {
  return new SboxError('BROWSER_NOT_FOUND', 'Браузер не найден: ни в кэше, ни в системе.', 'Выполните `sbox-browser install` (скачает Chrome for Testing) или укажите существующий: флаг --executable, переменная SBOX_BROWSER_EXECUTABLE или browser.executable в .sbox/config.yaml.');
}
