import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Копия фикстуры во временном git-репозитории с начальным коммитом: тесты не трогают исходник. */
export function tempProject(name = 'spec-box-project', opts: { git?: boolean } = {}): string {
  const src = path.join(here, 'fixtures', name);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbox-test-'));
  fs.cpSync(src, dir, { recursive: true });
  if (opts.git !== false) {
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'sbox test']);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'init']);
  }
  return dir;
}

export function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function write(root: string, rel: string, content: string): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

export function read(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

export const RESULT = (status: string, extra = ''): string => `Готово.\n\n\`\`\`yaml\n# sbox-result\nstatus: ${status}\nblocker: { category: нет }\n${extra}\`\`\`\n`;

export const BLOCKED = (category: string, message: string): string => `Стоп.\n\n\`\`\`yaml\n# sbox-result\nstatus: заблокировано\nblocker: { category: ${category}, message: "${message}" }\n\`\`\`\n`;

/** Ответ исследователя с «Разбором запроса»: одна дословная цитата со статусом «подтверждено». */
export const RESEARCH = (quote: string, extra = ''): string => RESULT('готово', `request:\n  - { quote: "${quote}", status: подтверждено, evidence: "src/index.ts" }\n${extra}`);
