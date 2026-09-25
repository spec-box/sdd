import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SboxError } from './errors.js';

export const SBOX_DIR = '.sbox';
export const CONFIG_FILE = 'config.yaml';

/** Ищет корень проекта: ближайший каталог вверх, где есть .sbox/config.yaml. */
export function findProjectRoot(start: string = process.cwd()): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, SBOX_DIR, CONFIG_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function requireProjectRoot(start?: string): string {
  const root = findProjectRoot(start);
  if (!root) {
    throw new SboxError('NO_PROJECT', 'Не найден .sbox/config.yaml выше текущего каталога.', 'Выполните `sbox init` в корне репозитория продукта.');
  }
  return root;
}

/** Корень npm-пакета инструмента: нужен, чтобы находить assets/ и в dev-режиме, и после сборки. */
export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Не найден package.json инструмента');
    dir = parent;
  }
}

/** Версия пакета из package.json инструмента. */
export function packageVersion(): string {
  try {
    return (JSON.parse(fs.readFileSync(path.join(packageRoot(), 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

/** Раскрывает ведущую тильду в домашний каталог: `~/x` → `/Users/me/x`. */
export function expandHome(p: string): string {
  return p.replace(/^~(?=$|\/)/, os.homedir());
}

export function assetsDir(): string {
  return path.join(packageRoot(), 'assets');
}

export function sboxDir(root: string): string {
  return path.join(root, SBOX_DIR);
}

export function readText(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

export function writeText(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

export function exists(file: string): boolean {
  return fs.existsSync(file);
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Локальная дата YYYY-MM-DD (не UTC), чтобы имена архивов совпадали с календарём разработчика. */
export function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
