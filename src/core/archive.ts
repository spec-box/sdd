import { ContractService } from '../contract/service.js';
import fs from 'node:fs';
import path from 'node:path';
import type { Diagnostic } from './diagnostics.js';
import { SboxError } from './errors.js';
import { today } from './paths.js';
import { archiveDir, saveChange, type Change } from './change.js';
import type { Config } from './config.js';
import type { SpecAdapter } from '../contract/adapter.js';

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
 * Папка runs/ (ответы ролей, квитанции) в архив не попадает, если не включено archive.runs: всё нужное после доставки
 * (запуски, стоимость, delivery_narrative) уже записано в change.yaml.
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
  let result: { appliedFiles: string[]; diagnostics: Diagnostic[] };
  try {
    result = await new ContractService(root, adapter).apply(change.skip_specs ? undefined : path.join(dir, 'specs'), {
      force: opts.force,
      finalize: () => {
        change.phase = 'archived';
        change.status = 'archived';
        saveChange(dir, change);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(dir, target);
        if (!config.archive.runs) fs.rmSync(path.join(target, 'runs'), { recursive: true, force: true });
      },
    });
  } catch (e) {
    throw e instanceof SboxError ? e : new SboxError('ARCHIVE_FAILED', `Архивация прервана, истина спецификаций восстановлена: ${(e as Error).message}`);
  }
  return { archivedTo: target, ...result, cleanedStaleArchive };
}
