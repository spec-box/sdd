import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { diag, type Diagnostic } from './diagnostics.js';
import { exists, readText, toPosix } from './paths.js';
import type { Config } from './config.js';
import type { Role } from './phases.js';

/** Категории информации о проекте (docs/design.md, раздел 7). */
export interface DocCategory {
  id: string;
  file: string;
  title: string;
  questions: string;
  sections: string[];
  readers: Role[];
  required: boolean;
}

export const DOC_CATEGORIES: DocCategory[] = [
  {
    id: 'product',
    file: 'overview.md',
    title: 'Продукт и границы',
    questions: 'Что за продукт, кто пользователи, какие системы рядом, где живёт код, где истина спецификаций',
    sections: ['Что за продукт', 'Пользователи', 'Системы рядом', 'Где живёт код', 'Истина спецификаций'],
    readers: ['researcher', 'planner', 'challenger'],
    required: true,
  },
  {
    id: 'architecture',
    file: 'architecture.md',
    title: 'Архитектура и карта кода',
    questions: 'Какие пакеты и модули есть, точки входа, поток данных, где что лежит, границы модулей, генерируемый код',
    sections: ['Карта пакетов и модулей', 'Точки входа', 'Поток данных', 'Границы модулей', 'Генерируемый код'],
    readers: ['researcher', 'planner', 'implementer', 'challenger'],
    required: true,
  },
  {
    id: 'conventions',
    file: 'conventions.md',
    title: 'Соглашения по коду',
    questions: 'Язык кода и комментариев, стиль, запрещённые конструкции, именование, правила коммитов',
    sections: ['Язык', 'Стиль', 'Запрещено', 'Именование', 'Коммиты'],
    readers: ['implementer', 'reviewer', 'tester'],
    required: true,
  },
  {
    id: 'testing',
    file: 'testing.md',
    title: 'Тестирование и проверки',
    questions: 'Уровни тестов, команды узкого и полного прогона, пути отчётов, правило именования тестов по сценариям, среда e2e, что нельзя автоматизировать',
    sections: ['Уровни тестов', 'Команды', 'Отчёты', 'Именование тестов по сценариям', 'Среда e2e', 'Не автоматизируется'],
    readers: ['tester', 'implementer', 'verifier', 'reviewer'],
    required: true,
  },
  {
    id: 'workflow',
    file: 'workflow.md',
    title: 'Рабочий процесс',
    questions: 'Ветки, пул-реквесты, обязательные проверки CI, что запрещено без человека, разрешённые команды для агентов',
    sections: ['Ветки', 'Пул-реквесты', 'Проверки CI', 'Запрещено без человека', 'Разрешённые команды'],
    readers: ['implementer', 'tester', 'verifier'],
    required: true,
  },
  {
    id: 'glossary',
    file: 'glossary.md',
    title: 'Словарь домена',
    questions: 'Термины в формулировках, которыми пишутся спецификации и тесты',
    sections: ['Термины'],
    readers: ['researcher', 'planner', 'tester', 'implementer', 'reviewer', 'verifier', 'challenger'],
    required: true,
  },
  {
    id: 'contracts',
    file: 'contracts.md',
    title: 'Интеграции и контракты',
    questions: 'Внешние API, события, схемы, кто потребитель, где лежат машиночитаемые контракты, репозитории-партнёры',
    sections: ['Внешние API', 'События', 'Схемы', 'Потребители', 'Машиночитаемые контракты'],
    readers: ['planner', 'tester', 'challenger'],
    required: false,
  },
];

export const DOC_FRONTMATTER_FIELDS = ['id', 'summary', 'read_when', 'updated', 'verification'] as const;
const VERIFICATION_VALUES = new Set(['verified', 'needs-review']);
const PLACEHOLDER = /(\bTODO\b|\bTBD\b|\bFIXME\b|\{\{[^}]+\}\}|<заполн[^>]*>|<fill[^>]*>)/iu;

export interface ParsedDoc {
  frontmatter: Record<string, unknown>;
  body: string;
  headings: { level: number; text: string; line: number }[];
}

export function parseDoc(text: string): ParsedDoc {
  let frontmatter: Record<string, unknown> = {};
  let body = text;
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (m) {
    try {
      frontmatter = (YAML.parse(m[1]!) as Record<string, unknown>) ?? {};
    } catch {
      frontmatter = { __invalid: true };
    }
    body = text.slice(m[0].length);
  }
  const headings: ParsedDoc['headings'] = [];
  body.split(/\r?\n/).forEach((line, i) => {
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) headings.push({ level: h[1]!.length, text: h[2]!.trim(), line: i + 1 });
  });
  return { frontmatter, body, headings };
}

export function docsDir(root: string, config: Config): string {
  return path.join(root, config.project.docs);
}

export function docsForRole(role: Role): DocCategory[] {
  return DOC_CATEGORIES.filter((c) => c.readers.includes(role));
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Структурный уровень `sbox doctor`: наличие, фронтматтер, разделы, заглушки, ссылки на пути и команды, правила. */
export function doctorDocs(root: string, config: Config): Diagnostic[] {
  const out: Diagnostic[] = [];
  const dir = docsDir(root, config);
  if (!exists(dir)) {
    out.push(diag('error', 'DOCS_DIR_MISSING', `Нет каталога проектной документации ${toPosix(path.relative(root, dir))}`, undefined, 'Выполните `sbox init`.'));
    return out;
  }
  const scripts = readPackageScripts(root);
  for (const category of DOC_CATEGORIES) {
    const file = path.join(dir, category.file);
    const target = toPosix(path.relative(root, file));
    if (!exists(file)) {
      if (category.required) out.push(diag('error', 'DOC_MISSING', `Нет файла категории «${category.title}»`, target, `Создайте ${category.file} с разделами: ${category.sections.join(', ')}.`));
      else out.push(diag('info', 'DOC_OPTIONAL_MISSING', `Необязательная категория «${category.title}» не заполнена`, target));
      continue;
    }
    const text = readText(file);
    const doc = parseDoc(text);
    if (doc.frontmatter.__invalid) out.push(diag('error', 'DOC_FRONTMATTER_INVALID', 'Фронтматтер не разбирается как YAML', target));
    for (const field of DOC_FRONTMATTER_FIELDS) {
      if (doc.frontmatter[field] === undefined || doc.frontmatter[field] === '') {
        out.push(diag('error', 'DOC_FRONTMATTER_FIELD', `В фронтматтере нет поля ${field}`, target));
      }
    }
    const verification = doc.frontmatter.verification;
    if (typeof verification === 'string' && !VERIFICATION_VALUES.has(verification)) {
      out.push(diag('error', 'DOC_VERIFICATION_VALUE', `verification должно быть verified или needs-review, а не «${verification}»`, target));
    }
    const h2 = doc.headings.filter((h) => h.level === 2).map((h) => norm(h.text));
    for (const section of category.sections) {
      if (!h2.includes(norm(section))) {
        out.push(diag('error', 'DOC_SECTION_MISSING', `Нет раздела «## ${section}»`, target, `Категория «${category.title}» отвечает на: ${category.questions}.`));
      }
    }
    doc.body.split(/\r?\n/).forEach((line, i) => {
      if (PLACEHOLDER.test(line)) {
        out.push(diag('error', 'DOC_PLACEHOLDER', `Заглушка в строке ${i + 1}: ${line.trim().slice(0, 80)}`, target));
      }
    });
    if (wordCount(doc.body) < 40) {
      out.push(diag('warning', 'DOC_TOO_SHORT', 'Содержимое короче 40 слов: категория вряд ли закрыта', target));
    }
    for (const ref of pathRefs(doc.body)) {
      if (!exists(path.join(root, ref))) {
        out.push(diag('warning', 'DOC_PATH_MISSING', `Упомянутый путь не найден в репозитории: ${ref}`, target));
      }
    }
    if (category.id === 'testing' && scripts) {
      for (const cmd of scriptRefs(doc.body)) {
        if (!(cmd in scripts)) out.push(diag('warning', 'DOC_SCRIPT_MISSING', `Скрипт «${cmd}» упомянут, но его нет в package.json`, target));
      }
    }
  }
  out.push(...doctorDecisions(root, config));
  return out;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Пути в обратных кавычках: содержат «/», без пробелов, не URL, не глоб. */
function pathRefs(body: string): string[] {
  const refs = new Set<string>();
  for (const m of body.matchAll(/`([^`\s]+)`/g)) {
    const v = m[1]!;
    if (!v.includes('/') || /^[a-z]+:\/\//i.test(v) || /[*?{}[\]]/.test(v) || v.startsWith('/') || v.startsWith('-')) continue;
    if (/^[A-Za-z0-9_.@-][A-Za-z0-9_./@-]*$/.test(v)) refs.add(v.replace(/\/$/, ''));
  }
  return [...refs];
}

/** Команды вида `pnpm test:unit`, `npm run lint`, `yarn e2e` → имя скрипта. */
function scriptRefs(body: string): string[] {
  const refs = new Set<string>();
  for (const m of body.matchAll(/`(?:pnpm|npm run|yarn)\s+([a-z][\w:-]*)`/g)) refs.add(m[1]!);
  return [...refs];
}

function readPackageScripts(root: string): Record<string, string> | null {
  const file = path.join(root, 'package.json');
  if (!exists(file)) return null;
  try {
    return (JSON.parse(readText(file)) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return null;
  }
}

export interface Decision {
  id: string;
  title: string;
  status: 'accepted' | 'superseded';
  scope: string[];
  rule: string;
  file: string;
}

export function decisionsDir(root: string, config: Config): string {
  return path.join(docsDir(root, config), 'decisions');
}

export function loadDecisions(root: string, config: Config): Decision[] {
  const dir = decisionsDir(root, config);
  if (!exists(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^ADR-\d+.*\.md$/i.test(f))
    .sort()
    .map((f) => {
      const doc = parseDoc(readText(path.join(dir, f)));
      const fm = doc.frontmatter;
      const ruleSection = doc.body.match(/##\s*Правило\s*\n([\s\S]*?)(?=\n##\s|$)/);
      return {
        id: String(fm.id ?? f),
        title: String(fm.title ?? f),
        status: (fm.status as Decision['status']) ?? 'accepted',
        scope: Array.isArray(fm.scope) ? fm.scope.map(String) : [],
        rule: (ruleSection?.[1] ?? '').trim(),
        file: toPosix(path.relative(root, path.join(dir, f))),
      };
    });
}

function doctorDecisions(root: string, config: Config): Diagnostic[] {
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const d of loadDecisions(root, config)) {
    if (!/^ADR-\d{4}$/.test(d.id)) out.push(diag('error', 'ADR_ID', `Идентификатор правила должен быть вида ADR-0001, а не «${d.id}»`, d.file));
    if (seen.has(d.id)) out.push(diag('error', 'ADR_DUPLICATE', `Идентификатор ${d.id} повторяется`, d.file));
    seen.add(d.id);
    if (!['accepted', 'superseded'].includes(d.status)) out.push(diag('error', 'ADR_STATUS', `status должен быть accepted или superseded`, d.file));
    if (!d.rule) out.push(diag('error', 'ADR_RULE', 'Нет раздела «## Правило» с формулировкой', d.file));
    if (d.scope.length === 0) out.push(diag('warning', 'ADR_SCOPE', 'Не задана область действия scope', d.file));
  }
  return out;
}

/** Действующие правила, чья область пересекается с затронутыми путями (или все, если пути неизвестны). */
export function applicableDecisions(decisions: Decision[], paths: string[] | null): Decision[] {
  const accepted = decisions.filter((d) => d.status === 'accepted');
  if (!paths || paths.length === 0) return accepted;
  return accepted.filter((d) => d.scope.length === 0 || d.scope.some((s) => paths.some((p) => p.startsWith(s) || s.startsWith(p))));
}
