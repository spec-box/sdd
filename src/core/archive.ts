import fs from 'node:fs';
import path from 'node:path';
import { hasErrors, type Diagnostic } from './diagnostics.js';
import { SboxError } from './errors.js';
import { today } from './paths.js';
import { archiveDir, saveChange, type Change } from './change.js';
import type { Config } from './config.js';
import type { SpecAdapter } from './spec-adapter.js';

export interface ArchiveResult {
  archivedTo: string;
  appliedFiles: string[];
  diagnostics: Diagnostic[];
  /** Каталог архива был пустым следом прерванной попытки и удалён. */
  cleanedStaleArchive: boolean;
}

/** Каталог считается пустым, если в нём нет ни одного файла (git не хранит пустые каталоги, `checkout` их оставляет). */
export function isEmptyTree(dir: string): boolean {
  if (!fs.existsSync(dir)) return true;
  const walk = (d: string): boolean => fs.readdirSync(d, { withFileTypes: true }).every((e) => e.isDirectory() && walk(path.join(d, e.name)));
  return walk(dir);
}

/**
 * Архивация (docs/design.md, «Архивация до мержа»): проверки до любых записей, снимок затронутых файлов истины,
 * применение дельт, структурная проверка результата, перенос папки; любая ошибка откатывает истину к снимку.
 * Повторный запуск после сбоя даёт тот же результат, что и однократный успешный: применение дельт идемпотентно.
 */
export async function archiveChange(
  root: string,
  config: Config,
  adapter: SpecAdapter,
  dir: string,
  change: Change,
  opts: { force?: boolean; date?: string } = {},
): Promise<ArchiveResult> {
  const date = opts.date ?? today();
  const target = path.join(archiveDir(root, config), `${date}-${change.id}`);
  let cleanedStaleArchive = false;
  if (fs.existsSync(target)) {
    if (isEmptyTree(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      cleanedStaleArchive = true;
    } else {
      throw new SboxError('ARCHIVE_EXISTS', `Каталог архива уже существует и не пуст: ${target}`, 'Если это след прерванной доставки этого же изменения, сравните содержимое с папкой изменения и удалите каталог; если там другое изменение с тем же идентификатором, переименуйте его.');
    }
  }
  const truth = await adapter.readTruth();
  const deltas = change.skip_specs ? [] : await adapter.readDelta(path.join(dir, 'specs'));
  const diagnostics = adapter.validate(truth, deltas);
  if (hasErrors(diagnostics) && !opts.force) {
    throw new SboxError('DELTA_INVALID', `Дельты не проходят валидацию: ${diagnostics.filter((d) => d.severity === 'error').map((d) => d.message).join('; ')}`, 'Исправьте дельты или используйте --force.');
  }

  // Снимок затронутых файлов истины: содержимое или отсутствие.
  const targets = deltas.length > 0 ? adapter.targets(truth, deltas) : [];
  const snapshot = new Map<string, Buffer | null>();
  for (const rel of targets) {
    const abs = path.join(root, rel);
    snapshot.set(abs, fs.existsSync(abs) ? fs.readFileSync(abs) : null);
  }
  const rollback = () => {
    for (const [abs, content] of snapshot) {
      if (content === null) fs.rmSync(abs, { force: true });
      else {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
      }
    }
  };

  let appliedFiles: string[] = [];
  try {
    appliedFiles = deltas.length > 0 ? await adapter.apply(truth, deltas) : [];
    // Постусловие: истина после применения структурно валидна (нет дубликатов).
    const after = await adapter.readTruth();
    const post = adapter.checkTruth(after);
    diagnostics.push(...post);
    if (hasErrors(post)) {
      throw new SboxError('TRUTH_INVALID', `Истина спецификаций после применения дельт невалидна: ${post.filter((d) => d.severity === 'error').map((d) => `${d.target ?? ''}: ${d.message}`).join('; ')}`);
    }
    change.phase = 'archived';
    change.status = 'archived';
    saveChange(dir, change);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(dir, target);
  } catch (e) {
    rollback();
    throw e instanceof SboxError ? e : new SboxError('ARCHIVE_FAILED', `Архивация прервана, истина спецификаций восстановлена: ${(e as Error).message}`);
  }
  return { archivedTo: target, appliedFiles, diagnostics, cleanedStaleArchive };
}
