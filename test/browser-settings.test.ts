import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadBrowserSettings, parseViewport } from '../src/browser/settings.js';
import { tempProject, write } from './helpers.js';

const clean = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: process.env.HOME, ...extra });

describe('browser: настройки', () => {
  it('порядок: флаги → окружение → конфиг → умолчания', () => {
    const root = tempProject('spec-box-project', { git: false });
    write(root, '.sbox/config.yaml', `${fs.readFileSync(path.join(root, '.sbox/config.yaml'), 'utf8')}\nbrowser:\n  executable: /cfg/chrome\n  headless: false\n  profile: cfg\n  baseUrl: http://cfg\n  cacheDir: ~/cfg-cache\n  viewport: { width: 640, height: 480 }\n  timeoutMs: 1234\n  idleMinutes: 7\n`);
    const fromConfig = loadBrowserSettings({ cwd: root }, clean());
    expect(fromConfig).toMatchObject({ executable: { path: '/cfg/chrome', source: 'config' }, headless: false, profile: 'cfg', baseUrl: 'http://cfg', cacheDir: path.join(os.homedir(), 'cfg-cache'), viewport: { width: 640, height: 480 }, timeoutMs: 1234, idleMinutes: 7, projectRoot: root });
    const fromEnv = loadBrowserSettings({ cwd: root }, clean({ SBOX_BROWSER_EXECUTABLE: '/env/chrome', SBOX_BROWSER_HEADLESS: '1', SBOX_BROWSER_PROFILE: 'envp', SBOX_BROWSER_BASE_URL: 'http://env', SBOX_BROWSER_CACHE_DIR: '/env-cache' }));
    expect(fromEnv).toMatchObject({ executable: { path: '/env/chrome', source: 'env' }, headless: true, profile: 'envp', baseUrl: 'http://env', cacheDir: '/env-cache' });
    const fromFlags = loadBrowserSettings({ cwd: root, executable: '/flag/chrome', headed: true, profile: 'flagp', baseUrl: 'http://flag', timeout: 9, idle: 0, viewport: '10x20', cacheDir: '/flag-cache' }, clean({ SBOX_BROWSER_HEADLESS: '1' }));
    expect(fromFlags).toMatchObject({ executable: { path: '/flag/chrome', source: 'flag' }, headless: false, profile: 'flagp', baseUrl: 'http://flag', timeoutMs: 9, idleMinutes: 0, viewport: { width: 10, height: 20 }, cacheDir: '/flag-cache' });
  });

  it('вне проекта действуют умолчания, невалидный конфиг это ошибка, а не пустая секция', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbox-noproj-'));
    const defaults = loadBrowserSettings({ cwd: dir }, clean());
    expect(defaults).toMatchObject({ executable: null, headless: true, profile: null, baseUrl: null, timeoutMs: 15_000, idleMinutes: 30, projectRoot: null });
    expect(defaults.cacheDir.endsWith(path.join('.sbox', 'browser', 'cache'))).toBe(true);
    const root = tempProject('spec-box-project', { git: false });
    write(root, '.sbox/config.yaml', `${fs.readFileSync(path.join(root, '.sbox/config.yaml'), 'utf8')}\nbrowser:\n  viewport: 1280x800\n`);
    expect(() => loadBrowserSettings({ cwd: root }, clean())).toThrow(/BAD_CONFIG|Некорректный/);
  });

  it('разбирает размер окна', () => {
    expect(parseViewport('375x812')).toEqual({ width: 375, height: 812 });
    expect(() => parseViewport('wide')).toThrow(/1280x800/);
  });
});
