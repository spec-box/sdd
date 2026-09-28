import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WikiStore, pageSummary } from '../src/wiki/store.js';
import { markdown } from '../src/wiki/markdown.js';
import { defaultConfig } from '../src/core/config.js';
import { loadWiki, doctorWiki } from '../src/core/wiki.js';

const dirs: string[] = [];
const stores: WikiStore[] = [];
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbox-wiki-test-')); dirs.push(dir);
  const store = new WikiStore(dir); stores.push(store); return store;
}
const page = (id: string, body = '# Тема\n\nПолезное знание', extra = '') => `---\nid: ${id}\nsummary: Как добавить экспорт\nread_when: [Добавление выгрузки]\nsource_roots: []\n${extra}---\n${body}\n`;
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); for (const store of stores.splice(0)) fs.rmSync(store.cacheFile, { force: true }); });

describe('sbox-wiki', () => {
  it('индекс обновляет изменённые файлы, удаляет исчезнувшие и восстанавливается после повреждения кеша', () => {
    const s = setup(); fs.writeFileSync(path.join(s.dir, 'a.md'), page('a'));
    expect(s.pages().map(pageSummary)[0]).not.toHaveProperty('body');
    const spy = vi.spyOn(fs, 'readFileSync'); s.pages();
    expect(spy.mock.calls.some(args => args[0] === path.join(s.dir, 'a.md'))).toBe(false);
    fs.writeFileSync(path.join(s.dir, 'a.md'), page('b')); expect(s.pages()[0]!.id).toBe('b');
    const cache = JSON.parse(fs.readFileSync(s.cacheFile, 'utf8')); cache.entries['a.md'].page = {};
    fs.writeFileSync(s.cacheFile, JSON.stringify(cache)); expect(s.pages()[0]!.id).toBe('b');
    fs.writeFileSync(s.cacheFile, 'broken'); expect(s.pages()[0]!.id).toBe('b');
    fs.unlinkSync(path.join(s.dir, 'a.md')); expect(s.pages()).toEqual([]);
  });
  it('ищет в метаданных и тексте и повышает релевантность области с границами пути', () => {
    const s = setup();
    fs.writeFileSync(path.join(s.dir, 'a.md'), page('a', '# A\nРедкоеСлово\n\n```ts\nexampleFunction()\n```', 'areas: [backend]\n'));
    fs.writeFileSync(path.join(s.dir, 'b.md'), page('b').replace('source_roots: []', 'source_roots: [src/export]'));
    expect(s.search('редкоеслово')[0]!.id).toBe('a'); expect(s.search('backend')[0]!.id).toBe('a');
    expect(s.search('exampleFunction')[0]!.id).toBe('a');
    expect(s.search('выгрузки', 'src/export/new.ts')[0]!.id).toBe('b');
    expect(s.search('', 'src/exports')).toEqual([]);
    expect(() => s.search('x', undefined, NaN)).toThrow(/limit/);
  });
  it('читает полный Markdown и раздел с вложенными заголовками', () => {
    const s = setup(); const content = page('a', '# Тема\n## Раздел\nтекст\n### Детали\nпример\n## Другой\nконец');
    fs.writeFileSync(path.join(s.dir, 'a.md'), content);
    expect(s.get('a').content).toBe(content);
    expect(s.get('a', 'раздел').content).toBe('## Раздел\nтекст\n### Детали\nпример');
    expect(() => s.get('a', 'missing')).toThrow(/Раздел/);
  });
  it('проверяет относительные/reference ссылки, якоря, дубли заголовков и пропускает код и URL', () => {
    const s = setup(); fs.mkdirSync(path.join(s.dir, 'nested'));
    fs.writeFileSync(path.join(s.dir, 'nested/a.md'), page('a', '# A\n[B][b]\n\n[b]: ../b.md#раздел-1\n\n`[bad](missing.md)`\n\n```md\n[bad](missing.md)\n```\n\n[web](https://example.com)'));
    fs.writeFileSync(path.join(s.dir, 'b.md'), page('b', '# Раздел\n## Раздел'));
    expect(s.validate()).toEqual([]); expect(s.backlinks('b')).toEqual([{ id: 'a', file: 'nested/a.md', href: '../b.md#%D1%80%D0%B0%D0%B7%D0%B4%D0%B5%D0%BB-1' }]);
    fs.writeFileSync(path.join(s.dir, 'b.md'), page('b'));
    expect(s.validate().some(d => d.code === 'WIKI_LINK_ANCHOR')).toBe(true);
    fs.unlinkSync(path.join(s.dir, 'b.md'));
    expect(s.validate().some(d => d.code === 'WIKI_LINK_MISSING')).toBe(true);
  });
  it('сохраняет по revision, запрещает потерю изменений и разрушение входящих ссылок', () => {
    const s = setup(); const created = s.put('a.md', page('a'), { create: true });
    const updated = s.put('a', page('a', '# Тема\nНовое'), { ifMatch: created.revision });
    expect(s.get('a').revision).toBe(updated.revision);
    expect(() => s.put('a', page('a'), { ifMatch: created.revision })).toThrow(/revision/);
    s.put('b.md', page('b', '# B\n[A](a.md#тема)'), { create: true });
    expect(() => s.put('a', page('a', '# Другое'), { ifMatch: updated.revision })).toThrow(/WIKI_LINK_ANCHOR/);
    expect(s.get('a').revision).toBe(updated.revision);
    expect(fs.existsSync(path.join(s.dir, '.sbox-wiki.lock'))).toBe(false);
    expect(() => s.put('a.md', page('a'), { create: true })).toThrow(/существует/);
  });
  it('диагностирует метаданные, id, ссылки за пределы wiki и симлинки', () => {
    const s = setup(); fs.writeFileSync(path.join(s.dir, 'a.md'), page('a', '[bad](../outside.md)'));
    fs.writeFileSync(path.join(s.dir, 'b.md'), page('a'));
    fs.writeFileSync(path.join(s.dir, 'c.md'), '---\nread_when: 1\n---\n# C');
    expect(s.validate().map(d => d.code)).toEqual(expect.arrayContaining(['WIKI_ID', 'WIKI_LINK_PATH', 'WIKI_METADATA', 'WIKI_SUMMARY']));
    expect(() => s.put('../outside.md', page('x'), { create: true })).toThrow(/вне wiki/);
    fs.symlinkSync(os.tmpdir(), path.join(s.dir, 'escape'));
    expect(() => s.put('escape/x.md', page('x'), { create: true })).toThrow(/Символическая/);
  });
  it('не допускает параллельную запись', () => {
    const s = setup(); fs.writeFileSync(path.join(s.dir, '.sbox-wiki.lock'), 'other');
    expect(() => s.put('a.md', page('a'), { create: true })).toThrow(/Другая запись/);
    expect(fs.readFileSync(path.join(s.dir, '.sbox-wiki.lock'), 'utf8')).toBe('other');
  });
  it('интегрируется с SDD, сохраняя пути относительно проекта', () => {
    const s = setup(); const config = defaultConfig(); config.project.wiki = 'knowledge';
    fs.mkdirSync(path.join(s.dir, 'knowledge'));
    fs.writeFileSync(path.join(s.dir, 'knowledge/a.md'), page('a', '[bad](missing.md)'));
    expect(loadWiki(s.dir, config)[0]!.file).toBe('knowledge/a.md');
    expect(doctorWiki(s.dir, config)[0]!.target).toBe('knowledge/a.md');
  });
  it('JSON CLI работает без SDD и сообщает об ошибках аргументов', () => {
    const s = setup(); fs.writeFileSync(path.join(s.dir, 'a.md'), page('a'));
    const cli = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', 'import {main} from "./src/wiki/cli.ts"; await main(["node", "sbox-wiki", ...process.argv.slice(1)]);', '--', '--dir', s.dir, '--json', ...args], { encoding: 'utf8' });
    const get = cli(['get', 'a']); expect(get.status).toBe(0); expect(JSON.parse(get.stdout).data.id).toBe('a');
    const error = cli(['get']); expect(error.status).toBe(1); expect(JSON.parse(error.stdout).ok).toBe(false);
    const missing = cli(['get', 'absent']); expect(JSON.parse(missing.stdout).error.code).toBe('WIKI_NOT_FOUND');
  });
  it('путь разрешает неоднозначный id; нормализует путь создания', () => {
    const s = setup(); fs.writeFileSync(path.join(s.dir, 'a.md'), page('same'));
    fs.writeFileSync(path.join(s.dir, 'b.md'), page('same'));
    expect(() => s.get('same')).toThrow(/найдено 2/);
    expect(s.get('a.md').file).toBe('a.md');
    fs.unlinkSync(path.join(s.dir, 'b.md'));
    expect(s.put('./nested/../new.md', page('new'), { create: true }).file).toBe('new.md');
  });
  it('CLI сохраняет страницу по ревизии и возвращает диагностику битой ссылки', () => {
    const s = setup();
    const input = path.join(s.dir, 'input.txt'); fs.writeFileSync(input, page('a'));
    const cli = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', 'import {main} from "./src/wiki/cli.ts"; await main(["node", "sbox-wiki", ...process.argv.slice(1)]);', '--', '--dir', s.dir, '--json', ...args], { encoding: 'utf8' });
    const created = cli(['put', 'a.md', '--file', input, '--create']);
    expect(created.status).toBe(0); const revision = JSON.parse(created.stdout).data.revision;
    fs.writeFileSync(input, page('a', '# Новая версия'));
    expect(cli(['put', 'a', '--file', input, '--if-match', revision]).status).toBe(0);
    expect(JSON.parse(cli(['put', 'a', '--file', input, '--if-match', revision]).stdout).error.code).toBe('WIKI_CONFLICT');
    fs.writeFileSync(path.join(s.dir, 'b.md'), page('b', '[bad](missing.md)'));
    const validated = cli(['validate']); expect(validated.status).toBe(1);
    expect(JSON.parse(validated.stdout).data.diagnostics[0].code).toBe('WIKI_LINK_MISSING');
  });
  it('разбирает setext-заголовки и игнорирует заголовки в fenced code', () => {
    expect(markdown('Заголовок\n===\n\n```md\n# fake\n```').headings.map(h => h.anchor)).toEqual(['заголовок']);
  });
});
