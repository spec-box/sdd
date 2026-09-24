import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { exists, readText, toPosix } from './paths.js';

/**
 * Проверка подключения нового модуля по образцу (docs/design.md, «Единообразие»).
 * Все файлы вне каталога образца, где упоминается его идентификатор, считаются местами регистрации
 * (решение, csproj хоста, конфиг сборок, навигация). В каждом из них должен появиться и новый модуль.
 */
export interface WiringGap {
  file: string;
  analogMentions: number;
}

export interface WiringResult {
  analog: string;
  fresh: string;
  registrationFiles: string[];
  gaps: WiringGap[];
  exceptions: string[];
}

const SKIP_DIRS = ['node_modules', '.git', '.sbox', 'openspec', 'dist', 'bin', 'obj', 'coverage', 'build'];

function filesMentioning(root: string, needle: string): string[] {
  try {
    const out = execFileSync('git', ['grep', '-l', '-I', '-F', '--untracked', '--', needle], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    const files = fg.sync(['**/*'], { cwd: root, onlyFiles: true, dot: false, ignore: SKIP_DIRS.map((d) => `**/${d}/**`) });
    return files.filter((f) => {
      try {
        return fs.readFileSync(path.join(root, f), 'utf8').includes(needle);
      } catch {
        return false;
      }
    });
  }
}

function isUnderModuleDir(file: string, moduleId: string): boolean {
  const segs = toPosix(file).split('/');
  return segs.slice(0, -1).some((s) => s === moduleId || s.endsWith(moduleId));
}

export function wiringGaps(root: string, analog: string, fresh: string, exceptions: string[] = []): WiringResult {
  const mentioning = filesMentioning(root, analog).filter((f) => !isUnderModuleDir(f, analog) && !isUnderModuleDir(f, fresh) && !SKIP_DIRS.some((d) => toPosix(f).split('/').includes(d)));
  const registrationFiles = mentioning.filter((f) => !/\.(md|txt|lock)$/i.test(f) || /README/i.test(f) === false).filter((f) => !/\.md$/i.test(f));
  const gaps: WiringGap[] = [];
  for (const f of registrationFiles) {
    const abs = path.join(root, f);
    if (!exists(abs)) continue;
    const text = readText(abs);
    if (text.includes(fresh)) continue;
    if (exceptions.some((e) => toPosix(f) === e || toPosix(f).endsWith(`/${e}`))) continue;
    gaps.push({ file: toPosix(f), analogMentions: text.split(analog).length - 1 });
  }
  return { analog, fresh, registrationFiles: registrationFiles.map(toPosix), gaps, exceptions };
}

/** Образец и новый модуль из раздела «Единообразие» design.md: строки `- Образец: \`X\`` и `- Новый модуль: \`Y\``. */
export function parseAnalogFromDesign(designText: string): { analog: string; fresh: string; exceptions: string[] } | null {
  const analog = designText.match(/^[-*]?\s*Образец\s*[:—-]\s*`([^`]+)`/im)?.[1]?.trim();
  const fresh = designText.match(/^[-*]?\s*Новый модуль\s*[:—-]\s*`([^`]+)`/im)?.[1]?.trim();
  if (!analog || !fresh) return null;
  const exc = designText.match(/^[-*]?\s*Исключения подключения\s*[:—-]\s*(.+)$/im)?.[1] ?? '';
  const exceptions = [...exc.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.trim());
  return { analog, fresh, exceptions };
}

/** Результат проверки для изменения по строкам «Образец» и «Новый модуль» из design.md; null, если образец не объявлен. */
export function wiringForChange(root: string, changeDir: string): WiringResult | null {
  const designFile = path.join(changeDir, 'design.md');
  if (!exists(designFile)) return null;
  const parsed = parseAnalogFromDesign(readText(designFile));
  if (!parsed) return null;
  return wiringGaps(root, parsed.analog, parsed.fresh, parsed.exceptions);
}
