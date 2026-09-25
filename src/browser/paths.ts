import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Домашний каталог инструмента: сессии, профили входа, кэш браузеров, журналы, снимки. Вне репозитория продукта. */
export function browserHome(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env.SBOX_BROWSER_HOME;
  return custom ? expandHome(custom) : path.join(os.homedir(), '.sbox', 'browser');
}

export function expandHome(p: string): string {
  return p.replace(/^~(?=$|\/)/, os.homedir());
}

export const browserDirs = {
  cache: (env?: NodeJS.ProcessEnv) => path.join(browserHome(env), 'cache'),
  profiles: (env?: NodeJS.ProcessEnv) => path.join(browserHome(env), 'profiles'),
  sessions: (env?: NodeJS.ProcessEnv) => path.join(browserHome(env), 'sessions'),
  logs: (env?: NodeJS.ProcessEnv) => path.join(browserHome(env), 'logs'),
  shots: (env?: NodeJS.ProcessEnv) => path.join(browserHome(env), 'shots'),
};

/** Кэш самого puppeteer: браузеры, уже скачанные другими проектами, годятся и нам. */
export function puppeteerDefaultCache(env: NodeJS.ProcessEnv = process.env): string {
  return env.PUPPETEER_CACHE_DIR ? expandHome(env.PUPPETEER_CACHE_DIR) : path.join(os.homedir(), '.cache', 'puppeteer');
}

/** Каталоги инструмента содержат профили входа и сокеты: создаются доступными только владельцу. */
export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function profileDir(name: string, env?: NodeJS.ProcessEnv): string {
  return path.join(browserDirs.profiles(env), name);
}

export function timestampSlug(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
