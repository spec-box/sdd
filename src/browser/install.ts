import fs from 'node:fs';
import { Browser, detectBrowserPlatform, getInstalledBrowsers, install, resolveBuildId, uninstall } from '@puppeteer/browsers';
import { SboxError } from '../core/errors.js';

export const INSTALLABLE = ['chrome', 'chrome-headless-shell', 'chromium'] as const;
export type InstallableBrowser = (typeof INSTALLABLE)[number];

export interface InstalledEntry {
  browser: string;
  buildId: string;
  platform: string;
  executablePath: string;
  path: string;
  /** Исполняемый файл на месте; false для прерванной или чужой по платформе установки. */
  complete: boolean;
}

export function isInstallable(name: string): name is InstallableBrowser {
  return (INSTALLABLE as readonly string[]).includes(name);
}

/** Скачивает браузер в кэш инструмента; повторный вызов с тем же buildId ничего не качает. */
export async function installBrowser(opts: {
  browser: InstallableBrowser;
  tag?: string;
  cacheDir: string;
  onProgress?: (downloadedBytes: number, totalBytes: number) => void;
}): Promise<InstalledEntry & { alreadyInstalled: boolean }> {
  const platform = detectBrowserPlatform();
  if (!platform) throw new SboxError('BROWSER_PLATFORM', `Платформа ${process.platform}/${process.arch} не поддерживается загрузчиком браузеров.`);
  const browser = opts.browser as Browser;
  const tag = opts.tag ?? (opts.browser === 'chromium' ? 'latest' : 'stable');
  let buildId: string;
  try {
    buildId = await resolveBuildId(browser, platform, tag);
  } catch (e) {
    throw new SboxError('BROWSER_INSTALL_FAILED', `Не удалось определить сборку ${opts.browser}@${tag}: ${(e as Error).message}`, 'Проверьте доступ в интернет или укажите точный buildId: `sbox-browser install --build 130.0.6723.58`.');
  }
  const existing = (await listInstalled(opts.cacheDir)).find((b) => b.browser === opts.browser && b.buildId === buildId && b.platform === platform);
  if (existing?.complete) return { ...existing, alreadyInstalled: true };
  if (existing) {
    // Прерванная установка: папка есть, бинарника нет. Удаляем след и качаем заново.
    await uninstall({ browser, buildId, cacheDir: opts.cacheDir, platform }).catch(() => fs.rmSync(existing.path, { recursive: true, force: true }));
  }
  try {
    const result = await install({ browser, buildId, cacheDir: opts.cacheDir, platform, downloadProgressCallback: opts.onProgress ?? (() => {}) });
    return { browser: result.browser, buildId: result.buildId, platform: result.platform, executablePath: result.executablePath, path: result.path, complete: fs.existsSync(result.executablePath), alreadyInstalled: false };
  } catch (e) {
    throw new SboxError('BROWSER_INSTALL_FAILED', `Установка ${opts.browser}@${buildId} не удалась: ${(e as Error).message}`, 'Повторите позже или установите браузер вручную и укажите путь через --executable.');
  }
}

export async function listInstalled(cacheDir: string): Promise<InstalledEntry[]> {
  if (!fs.existsSync(cacheDir)) return [];
  const installed = await getInstalledBrowsers({ cacheDir });
  return installed.map((b) => ({ browser: b.browser, buildId: b.buildId, platform: b.platform, executablePath: b.executablePath, path: b.path, complete: fs.existsSync(b.executablePath) }));
}

export async function uninstallBrowser(opts: { browser: string; buildId: string; cacheDir: string }): Promise<void> {
  const platform = detectBrowserPlatform();
  if (!platform) throw new SboxError('BROWSER_PLATFORM', `Платформа ${process.platform}/${process.arch} не поддерживается.`);
  await uninstall({ browser: opts.browser as Browser, buildId: opts.buildId, cacheDir: opts.cacheDir, platform });
}
