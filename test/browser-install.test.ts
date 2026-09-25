import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Browser, computeExecutablePath, detectBrowserPlatform } from '@puppeteer/browsers';
import { describe, expect, it } from 'vitest';
import { isInstallable, listInstalled, uninstallBrowser } from '../src/browser/install.js';

describe('browser: кэш установленных браузеров', () => {
  it('перечисляет и удаляет сборку из кэша инструмента', async () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbox-cache-'));
    const platform = detectBrowserPlatform()!;
    const exe = computeExecutablePath({ browser: Browser.CHROME, buildId: '140.0.0.1', cacheDir, platform });
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, '');
    expect(await listInstalled(cacheDir)).toMatchObject([{ browser: 'chrome', buildId: '140.0.0.1', executablePath: exe }]);
    await uninstallBrowser({ browser: 'chrome', buildId: '140.0.0.1', cacheDir });
    expect(await listInstalled(cacheDir)).toEqual([]);
    expect(fs.existsSync(exe)).toBe(false);
    expect(await listInstalled(path.join(cacheDir, 'missing'))).toEqual([]);
  });

  it('знает, какие браузеры умеет ставить', () => {
    expect(isInstallable('chrome')).toBe(true);
    expect(isInstallable('chrome-headless-shell')).toBe(true);
    expect(isInstallable('firefox')).toBe(false);
  });
});
