import { loadConfig } from '../core/config.js';
import { findProjectRoot } from '../core/paths.js';
import { SboxError } from '../core/errors.js';
import { browserDirs, expandHome } from './paths.js';
import type { ExecutableSource } from './executable.js';

/** Итоговые настройки браузера: флаги команды → переменные окружения → browser в .sbox/config.yaml → значения по умолчанию. */
export interface BrowserSettings {
  executable: { path: string; source: ExecutableSource } | null;
  headless: boolean;
  profile: string | null;
  baseUrl: string | null;
  cacheDir: string;
  viewport: { width: number; height: number };
  timeoutMs: number;
  idleMinutes: number;
  projectRoot: string | null;
}

export interface SettingsFlags {
  executable?: string;
  headed?: boolean;
  headless?: boolean;
  profile?: string;
  baseUrl?: string;
  timeout?: number;
  idle?: number;
  viewport?: string;
  cwd?: string;
  cacheDir?: string;
}

export function parseViewport(value: string): { width: number; height: number } {
  const m = value.match(/^(\d+)x(\d+)$/i);
  if (!m) throw new SboxError('BROWSER_VIEWPORT', `Размер окна «${value}» должен быть вида 1280x800.`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

export function loadBrowserSettings(flags: SettingsFlags = {}, env: NodeJS.ProcessEnv = process.env): BrowserSettings {
  const projectRoot = findProjectRoot(flags.cwd);
  let cfg: ReturnType<typeof loadConfig>['browser'] | null = null;
  if (projectRoot) {
    try {
      cfg = loadConfig(projectRoot).browser;
    } catch {
      cfg = null;
    }
  }
  const executable = flags.executable
    ? { path: expandHome(flags.executable), source: 'flag' as const }
    : env.SBOX_BROWSER_EXECUTABLE
      ? { path: expandHome(env.SBOX_BROWSER_EXECUTABLE), source: 'env' as const }
      : cfg?.executable
        ? { path: expandHome(cfg.executable), source: 'config' as const }
        : null;
  const envHeadless = env.SBOX_BROWSER_HEADLESS;
  const headless = flags.headed ? false : flags.headless ? true : envHeadless !== undefined ? !['0', 'false', 'no'].includes(envHeadless.toLowerCase()) : (cfg?.headless ?? true);
  const profile = flags.profile ?? env.SBOX_BROWSER_PROFILE ?? cfg?.profile ?? null;
  const baseUrl = flags.baseUrl ?? env.SBOX_BROWSER_BASE_URL ?? cfg?.baseUrl ?? null;
  const cacheDir = flags.cacheDir ? expandHome(flags.cacheDir) : env.SBOX_BROWSER_CACHE_DIR ? expandHome(env.SBOX_BROWSER_CACHE_DIR) : cfg?.cacheDir ? expandHome(cfg.cacheDir) : browserDirs.cache(env);
  const viewport = flags.viewport ? parseViewport(flags.viewport) : (cfg?.viewport ?? { width: 1280, height: 800 });
  return {
    executable,
    headless,
    profile: profile || null,
    baseUrl: baseUrl || null,
    cacheDir,
    viewport,
    timeoutMs: flags.timeout ?? cfg?.timeoutMs ?? 15_000,
    idleMinutes: flags.idle ?? cfg?.idleMinutes ?? 30,
    projectRoot,
  };
}
