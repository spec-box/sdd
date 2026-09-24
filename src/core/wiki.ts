import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { diag, type Diagnostic } from './diagnostics.js';
import { parseDoc } from './project-docs.js';
import { exists, readText, toPosix } from './paths.js';
import type { Config } from './config.js';

/**
 * Wiki проекта (docs/design.md, раздел 7): страницы с локальными знаниями об областях кода.
 * Первый шаг: индекс страниц (summary, read_when, source_roots) попадает в пакет каждой роли,
 * роль сама читает страницы, чьи read_when подходят к задаче. Роутер и дистилляция позже.
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

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value.trim()) return [value];
  return [];
}

export function loadWiki(root: string, config: Config): WikiPage[] {
  const dir = wikiDir(root, config);
  if (!exists(dir)) return [];
  return fg
    .sync('**/*.md', { cwd: dir, onlyFiles: true, absolute: true })
    .filter((f) => path.basename(f).toLowerCase() !== 'readme.md')
    .sort()
    .map((f) => {
      const doc = parseDoc(readText(f));
      const fm = doc.frontmatter;
      return {
        file: toPosix(path.relative(root, f)),
        id: String(fm.id ?? path.basename(f, '.md')),
        summary: String(fm.summary ?? ''),
        read_when: asList(fm.read_when),
        source_roots: asList(fm.source_roots),
        areas: asList(fm.areas),
      };
    });
}

/** Страницы, чьи source_roots пересекаются с путями задачи; без путей возвращаются все. */
export function relevantWiki(pages: WikiPage[], paths: string[]): WikiPage[] {
  if (paths.length === 0) return pages;
  const hit = pages.filter((p) => p.source_roots.some((r) => paths.some((x) => x.startsWith(r) || r.startsWith(x))));
  return hit.length > 0 ? hit : pages;
}

export function doctorWiki(root: string, config: Config): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const page of loadWiki(root, config)) {
    if (!page.summary) out.push(diag('warning', 'WIKI_SUMMARY', 'У страницы нет summary во фронтматтере', page.file));
    if (page.read_when.length === 0) out.push(diag('warning', 'WIKI_READ_WHEN', 'У страницы нет read_when: роли не поймут, когда её читать', page.file));
    for (const r of page.source_roots) {
      if (!fs.existsSync(path.join(root, r))) out.push(diag('warning', 'WIKI_SOURCE_ROOT', `source_roots указывает на несуществующий путь ${r}`, page.file));
    }
  }
  return out;
}

export const WIKI_README = `# Wiki проекта для ролей @spec-box/sdd

Здесь лежат локальные знания об областях кода, которым не место в общей документации \`.sbox/project/\`:
как устроен конкретный модуль, какой образец повторять при добавлении похожей функциональности,
подводные камни области. Одна страница на область или тему. Файл README.md страницей не считается.

Каждая страница начинается с фронтматтера:

\`\`\`yaml
---
id: wiki.exports              # уникальный идентификатор
summary: Как устроены модули экспорта и какой образец повторять
read_when:                    # когда роль обязана прочитать страницу
  - Добавляется или меняется экспорт данных
  - Создаётся новый модуль в src/features
source_roots:                 # пути области; по ним страница попадает в пакет роли
  - src/features/export
areas: [client]
updated: 2026-09-16
verification: needs-review    # verified после проверки человеком
---
\`\`\`

Тело: факты с путями, образец для единообразия («новый модуль повторяет структуру \`src/features/export\`: …»),
подводные камни, что нельзя делать. Индекс всех страниц (summary и read_when) попадает в пакет каждой роли;
саму страницу роль читает, если read_when подходит к задаче.
`;
