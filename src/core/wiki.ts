import path from 'node:path';
import type { Diagnostic } from './diagnostics.js';
import { WikiStore } from '../wiki/store.js';
import { assetsDir, readText, toPosix } from './paths.js';
import type { Config } from './config.js';

/**
 * Wiki проекта (docs/design.md, раздел 7): страницы с локальными знаниями об областях кода.
 * Индекс страниц (summary, read_when, source_roots) из sbox-wiki попадает в пакет каждой роли,
 * роль читает страницы, чьи read_when подходят к задаче, и может использовать поиск.
 */
export interface WikiPage {
  file: string;
  id: string;
  summary: string;
  read_when: string[];
  source_roots: string[];
  areas: string[];
}

export function wikiDir(root: string, config: Config): string {
  return path.join(root, config.project.wiki);
}

export function loadWiki(root: string, config: Config): WikiPage[] {
  return new WikiStore(wikiDir(root, config), root).pages()
    .filter(p => path.basename(p.file).toLowerCase() !== 'readme.md')
    .map(p => ({ file: toPosix(path.relative(root, path.join(wikiDir(root, config), p.file))), id: p.id,
      summary: p.summary, read_when: p.read_when, source_roots: p.source_roots, areas: p.areas }));
}

/** Страницы, чьи source_roots пересекаются с путями задачи; без путей возвращаются все. */
export function relevantWiki(pages: WikiPage[], paths: string[]): WikiPage[] {
  if (paths.length === 0) return pages;
  const hit = pages.filter((p) => p.source_roots.some((r) => paths.some((x) => x.startsWith(r) || r.startsWith(x))));
  return hit.length > 0 ? hit : pages;
}

export function doctorWiki(root: string, config: Config): Diagnostic[] {
  return new WikiStore(wikiDir(root, config), root).validate()
    .filter(d => !(path.basename(d.target ?? '').toLowerCase() === 'readme.md' && ['WIKI_SUMMARY', 'WIKI_READ_WHEN'].includes(d.code)))
    .map(d => ({ ...d, target: toPosix(path.relative(root, path.join(wikiDir(root, config), d.target!))) }));
}

export const WIKI_README = readText(path.join(assetsDir(), 'project', 'wiki.README.md'));
