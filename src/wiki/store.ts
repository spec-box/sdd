import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import fg from 'fast-glob';
import { parseDoc } from '../core/project-docs.js';
import { SboxError } from '../core/errors.js';
import { diag, type Diagnostic } from '../core/diagnostics.js';
import { markdown, type Heading } from './markdown.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const list = (value: unknown): string[] => typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
export interface Page {
  file: string; id: string; title: string; summary: string; read_when: string[]; source_roots: string[]; areas: string[];
  revision: string; headings: Heading[]; links: string[]; body: string; text: string; invalid: boolean;
}
interface Entry { stamp: string; page: Page }
interface Cache { version: 1; entries: Record<string, Entry> }
export const pageSummary = ({ body, text, links, invalid, ...page }: Page) => page;

export function parsePage(file: string, content: string): Page {
  const doc = parseDoc(content);
  const fm = doc.frontmatter;
  const parsed = markdown(doc.body);
  const invalid = Boolean(fm.__invalid) || !fm || typeof fm !== 'object' || Array.isArray(fm)
    || ['id', 'summary', 'title'].some(key => fm[key] !== undefined && typeof fm[key] !== 'string')
    || ['read_when', 'source_roots', 'areas'].some(key => fm[key] !== undefined && typeof fm[key] !== 'string' && !(Array.isArray(fm[key]) && fm[key].every((v: unknown) => typeof v === 'string')));
  return {
    file, id: typeof fm.id === 'string' ? fm.id : file.replace(/\.md$/i, ''),
    title: typeof fm.title === 'string' ? fm.title : parsed.headings[0]?.title ?? file,
    summary: typeof fm.summary === 'string' ? fm.summary : '', read_when: list(fm.read_when), source_roots: list(fm.source_roots), areas: list(fm.areas),
    revision: hash(content), ...parsed, body: doc.body, invalid,
  };
}

/** Markdown остаётся истиной. Кеш содержит текст для поиска, но index отдаёт только карточки. */
export class WikiStore {
  readonly dir: string;
  readonly cacheFile: string;
  constructor(dir: string, readonly projectRoot: string = dir) {
    this.dir = path.resolve(dir);
    this.cacheFile = path.join(os.tmpdir(), `sbox-wiki-${process.getuid?.() ?? 'user'}`, `${hash(this.dir)}.json`);
  }
  private safe(file: string): string {
    const target = path.resolve(this.dir, file);
    if (target === this.dir || !target.startsWith(this.dir + path.sep)) throw new SboxError('WIKI_PATH', `Путь вне wiki: ${file}`);
    // Не следуем симлинкам ни при чтении, ни при записи.
    let current = target;
    for (;;) {
      try { if (fs.lstatSync(current).isSymbolicLink()) throw new SboxError('WIKI_PATH', `Символическая ссылка: ${current}`); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      if (current === this.dir) break;
      current = path.dirname(current);
    }
    return target;
  }
  pages(rebuild = false): Page[] {
    if (!fs.existsSync(this.dir)) return [];
    let cache: Cache = { version: 1, entries: {} };
    if (!rebuild) {
      try { const value = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')); if (value.version === 1 && value.entries) cache = value; } catch { /* восстанавливаемый кеш */ }
    }
    const entries: Record<string, Entry> = {};
    for (const file of fg.sync('**/*.md', { cwd: this.dir, onlyFiles: true, followSymbolicLinks: false }).sort()) {
      const target = this.safe(file);
      const stat = fs.statSync(target);
      const stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
      const cached = cache.entries[file];
      const valid = cached?.page && ['id', 'title', 'summary', 'revision', 'body', 'text'].every(key => typeof (cached.page as unknown as Record<string, unknown>)[key] === 'string')
        && ['read_when', 'source_roots', 'areas', 'links'].every(key => { const value = (cached.page as unknown as Record<string, unknown>)[key]; return Array.isArray(value) && value.every(x => typeof x === 'string'); })
        && Array.isArray(cached.page.headings) && cached.page.headings.every(h => h && typeof h.anchor === 'string' && typeof h.title === 'string' && Number.isInteger(h.start) && Number.isInteger(h.end) && Number.isInteger(h.level))
        && cached.page.file === file && typeof cached.page.invalid === 'boolean';
      entries[file] = cached?.stamp === stamp && valid ? cached : { stamp, page: parsePage(file, fs.readFileSync(target, 'utf8')) };
    }
    // Отсутствие доступа к кешу не должно мешать читать wiki.
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true, mode: 0o700 });
      const temp = `${this.cacheFile}.${randomUUID()}`;
      try { fs.writeFileSync(temp, JSON.stringify({ version: 1, entries }), { mode: 0o600 }); fs.renameSync(temp, this.cacheFile); }
      finally { fs.rmSync(temp, { force: true }); }
    } catch { /* кеш необязателен */ }
    return Object.values(entries).map(e => e.page);
  }
  resolve(ref: string, pages = this.pages()): Page {
    const byFile = pages.find(p => p.file === ref);
    if (byFile) return byFile;
    const matches = pages.filter(p => p.id === ref);
    if (matches.length !== 1) throw new SboxError(matches.length ? 'WIKI_AMBIGUOUS' : 'WIKI_NOT_FOUND', `Страница «${ref}»: найдено ${matches.length}. Используйте уникальный id или путь .md.`);
    return matches[0]!;
  }
  get(ref: string, section?: string) {
    const page = this.resolve(ref);
    const content = fs.readFileSync(this.safe(page.file), 'utf8');
    const fresh = parsePage(page.file, content);
    if (!section) return { ...pageSummary(fresh), content };
    const matches = fresh.headings.filter(h => h.anchor === section || h.title === section);
    if (matches.length !== 1) throw new SboxError('WIKI_SECTION', `Раздел «${section}»: найдено ${matches.length}. Используйте якорь из index/get.`);
    const h = matches[0]!;
    return { ...pageSummary(fresh), content: fresh.body.split('\n').slice(h.start, h.end).join('\n') };
  }
  private link(page: Page, href: string): { file: string; anchor: string } | null {
    if (/^(?:[a-z][\w+.-]*:|\/\/)/i.test(href)) return null;
    const split = href.indexOf('#');
    try {
      const file = decodeURIComponent((split < 0 ? href : href.slice(0, split)).split('?')[0]!);
      const anchor = decodeURIComponent(split < 0 ? '' : href.slice(split + 1));
      const target = file ? path.resolve(this.dir, path.dirname(page.file), file) : path.join(this.dir, page.file);
      const relative = path.relative(this.dir, target).split(path.sep).join('/');
      this.safe(relative);
      return { file: relative, anchor };
    } catch { throw new SboxError('WIKI_LINK_PATH', `Недопустимая ссылка: ${href}`); }
  }
  validate(pages = this.pages()): Diagnostic[] {
    const out: Diagnostic[] = [];
    const ids = new Set<string>();
    for (const p of pages) {
      const add = (severity: 'error' | 'warning', code: string, message: string) => out.push(diag(severity, code, message, p.file));
      if (p.invalid) add('error', 'WIKI_METADATA', 'Некорректный YAML или тип поля метаданных');
      if (!p.id.trim() || ids.has(p.id)) add('error', 'WIKI_ID', `Пустой или повторяющийся id: ${p.id}`);
      ids.add(p.id);
      if (!p.summary.trim()) add('warning', 'WIKI_SUMMARY', 'У страницы нет summary');
      if (!p.read_when.some(x => x.trim())) add('warning', 'WIKI_READ_WHEN', 'У страницы нет read_when');
      for (const root of p.source_roots) if (!fs.existsSync(path.resolve(this.projectRoot, root))) add('warning', 'WIKI_SOURCE_ROOT', `Не существует source_roots: ${root}`);
      for (const href of p.links) {
        try {
          const link = this.link(p, href);
          if (!link) continue;
          const dest = pages.find(x => x.file === link.file);
          if (!dest && (!fs.existsSync(this.safe(link.file)) || /\.md$/i.test(link.file))) add('error', 'WIKI_LINK_MISSING', `Не найдена цель: ${href}`);
          else if (dest && link.anchor && !dest.headings.some(h => h.anchor === link.anchor)) add('error', 'WIKI_LINK_ANCHOR', `Не найден раздел: ${href}`);
        } catch (e) { add('error', 'WIKI_LINK_PATH', (e as Error).message); }
      }
    }
    return out;
  }
  backlinks(ref: string) {
    const pages = this.pages();
    const target = this.resolve(ref, pages);
    return pages.flatMap(p => p.links.flatMap(href => {
      try { return this.link(p, href)?.file === target.file ? [{ id: p.id, file: p.file, href }] : []; } catch { return []; }
    }));
  }
  search(query: string, sourcePath?: string, limit = 5) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new SboxError('WIKI_LIMIT', 'limit должен быть целым от 1 до 100');
    const words = [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])];
    if (!words.length && !sourcePath) throw new SboxError('WIKI_QUERY', 'Укажите запрос или --path');
    const within = (a: string, b: string) => a === b || a.startsWith(b.replace(/\/$/, '') + '/');
    return this.pages().map(p => {
      const reasons: string[] = [];
      let score = 0;
      const fields: [string, string, number][] = [['title', p.title, 5], ['summary', p.summary, 4], ['read_when', p.read_when.join(' '), 4], ['areas', p.areas.join(' '), 3], ['text', p.text, 1]];
      for (const [name, value, weight] of fields) {
        const found = words.filter(w => value.toLocaleLowerCase().includes(w));
        if (found.length) { score += found.length * weight; reasons.push(`${name}: ${found.join(', ')}`); }
      }
      if (sourcePath && p.source_roots.some(r => within(sourcePath, r) || within(r, sourcePath))) { score += 10; reasons.push(`source_roots: ${sourcePath}`); }
      const lines = p.text.split('\n');
      const snippet = (lines.find(line => words.some(w => line.toLocaleLowerCase().includes(w))) ?? p.summary).slice(0, 300);
      return { ...pageSummary(p), score, reasons, snippet };
    }).filter(p => p.score > 0).sort((a, b) => b.score - a.score || a.file.localeCompare(b.file)).slice(0, limit);
  }
  put(ref: string, content: string, options: { create?: boolean; ifMatch?: string }) {
    fs.mkdirSync(this.dir, { recursive: true });
    const lock = this.safe('.sbox-wiki.lock');
    let fd: number;
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; throw new SboxError('WIKI_BUSY', 'Другая запись wiki активна. После аварии удалите .sbox-wiki.lock, убедившись, что процесс завершён.'); }
    try {
      fs.writeSync(fd, String(process.pid));
      const pages = this.pages(true);
      let file: string;
      if (options.create) {
        if (options.ifMatch) throw new SboxError('WIKI_ARGUMENT', '--create несовместим с --if-match');
        file = path.relative(this.dir, this.safe(ref)).split(path.sep).join('/');
        if (!file.endsWith('.md')) throw new SboxError('WIKI_PATH', 'Для новой страницы укажите относительный путь .md');
        if (fs.existsSync(this.safe(file))) throw new SboxError('WIKI_EXISTS', `Страница уже существует: ${file}`);
      } else {
        const current = this.resolve(ref, pages);
        file = current.file;
        if (!options.ifMatch || current.revision !== options.ifMatch) throw new SboxError('WIKI_CONFLICT', 'Нужна текущая revision из get в --if-match. Перечитайте страницу и примените правку к новой версии.');
      }
      const candidate = parsePage(file, content);
      const diagnostics = this.validate([...pages.filter(p => p.file !== file), candidate]);
      if (diagnostics.some(d => d.severity === 'error')) throw new SboxError('WIKI_INVALID', JSON.stringify(diagnostics));
      const target = this.safe(file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const temp = `${target}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temp, content, { flag: 'wx', mode: fs.existsSync(target) ? fs.statSync(target).mode : 0o644 });
        // Повторная проверка также ловит правку обычным редактором во время валидации.
        if (!options.create && hash(fs.readFileSync(target, 'utf8')) !== options.ifMatch) throw new SboxError('WIKI_CONFLICT', 'Страница изменилась во время записи');
        if (options.create) { fs.linkSync(temp, target); } else fs.renameSync(temp, target);
      } finally { fs.rmSync(temp, { force: true }); }
      return { ...pageSummary(candidate), diagnostics };
    } finally { fs.closeSync(fd); fs.rmSync(lock, { force: true }); }
  }
}
