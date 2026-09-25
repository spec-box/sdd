import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeExecutablePath, detectBrowserPlatform, Browser } from '@puppeteer/browsers';
import { describe, expect, it } from 'vitest';
import { listCandidates, resolveExecutable } from '../src/browser/executable.js';

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fakeCacheBrowser(cacheDir: string, browser: Browser, buildId: string): string {
  const platform = detectBrowserPlatform()!;
  const exe = computeExecutablePath({ browser, buildId, cacheDir, platform });
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, '#!/bin/sh\n');
  fs.chmodSync(exe, 0o755);
  return exe;
}

const offline = { system: false, pathEnv: null, puppeteerCacheDir: null } as const;

describe('browser: поиск исполняемого файла', () => {
  it('явный путь должен существовать', async () => {
    await expect(resolveExecutable({ ...offline, cacheDir: tmp('sbox-cache-'), explicit: { path: '/nonexistent/chrome', source: 'flag' } })).rejects.toThrow(/не найден/);
    const exe = path.join(tmp('sbox-exe-'), 'chrome');
    fs.writeFileSync(exe, '');
    const found = await resolveExecutable({ ...offline, cacheDir: tmp('sbox-cache-'), explicit: { path: exe, source: 'config' } });
    expect(found).toEqual({ path: exe, source: 'config', browser: 'custom' });
  });

  it('берёт из кэша самую новую сборку chrome, для headed пропускает headless-shell', async () => {
    const cacheDir = tmp('sbox-cache-');
    const old = fakeCacheBrowser(cacheDir, Browser.CHROME, '129.0.6668.58');
    const fresh = fakeCacheBrowser(cacheDir, Browser.CHROME, '130.0.6723.58');
    const shellOnly = tmp('sbox-cache-');
    fakeCacheBrowser(shellOnly, Browser.CHROMEHEADLESSSHELL, '130.0.6723.58');
    const found = await resolveExecutable({ ...offline, cacheDir });
    expect(found?.path).toBe(fresh);
    expect(found?.source).toBe('cache');
    expect(found?.buildId).toBe('130.0.6723.58');
    expect((await listCandidates({ ...offline, cacheDir })).map((c) => c.path)).toEqual([fresh, old]);
    expect((await resolveExecutable({ ...offline, cacheDir: shellOnly }))?.browser).toBe('chrome-headless-shell');
    expect(await resolveExecutable({ ...offline, cacheDir: shellOnly, headed: true })).toBeNull();
  });

  it('кэш puppeteer других проектов идёт после нашего', async () => {
    const ours = tmp('sbox-cache-');
    const theirs = tmp('pptr-cache-');
    const theirExe = fakeCacheBrowser(theirs, Browser.CHROME, '131.0.0.0');
    expect((await resolveExecutable({ ...offline, cacheDir: ours, puppeteerCacheDir: theirs }))).toMatchObject({ path: theirExe, source: 'puppeteer-cache' });
  });

  it('находит браузер по PATH', async () => {
    const bin = tmp('sbox-bin-');
    const exe = path.join(bin, 'chromium');
    fs.writeFileSync(exe, '#!/bin/sh\n');
    fs.chmodSync(exe, 0o755);
    const found = await resolveExecutable({ cacheDir: tmp('sbox-cache-'), puppeteerCacheDir: null, system: false, pathEnv: bin, platform: 'linux' });
    expect(found).toMatchObject({ path: exe, source: 'path', browser: 'chromium' });
    expect(await resolveExecutable({ ...offline, cacheDir: tmp('sbox-cache-') })).toBeNull();
  });
});
