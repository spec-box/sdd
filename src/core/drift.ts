import path from 'node:path';
import { changeSetDrift, classifyDrift, isGitRepo, readChangeSet, sealChangeSet, writeChangeSet } from './changeset.js';
import { diag, type Diagnostic } from './diagnostics.js';
import { changesetExclude } from './report.js';
import { toPosix } from './paths.js';
import type { Change } from './change.js';
import type { Config } from './config.js';

export interface DriftOutcome {
  /** Дрейфа нет или он только безобидный (и уже перепривязан). */
  ok: boolean;
  invalidating: string[];
  benign: string[];
  rebound: boolean;
  diagnostics: Diagnostic[];
}

/**
 * Сверка рабочей копии с запечатанным change-set. Безобидный дрейф (документация, .gitignore, материалы хостов)
 * перепривязывается: change-set запечатывается заново, вердикты остаются в силе, факт записывается в change.yaml.
 * Код и конфигурация приложения после ревью меняться не могут: такой дрейф возвращает в фазу verify.
 */
export function reconcileDrift(root: string, config: Config, dir: string, change: Change, opts: { rebind: boolean }): DriftOutcome {
  const out: DriftOutcome = { ok: true, invalidating: [], benign: [], rebound: false, diagnostics: [] };
  if (!change.changeset || !isGitRepo(root)) return out;
  const sealed = readChangeSet(dir);
  if (!sealed) return out;
  const exclude = changesetExclude(config, toPosix(path.relative(root, dir)));
  const drift = changeSetDrift(root, sealed, exclude);
  if (!drift.drifted) return out;
  const cls = classifyDrift(drift, config.changeset.nonInvalidating);
  out.invalidating = cls.invalidating;
  out.benign = cls.benign;
  if (cls.invalidating.length > 0) {
    out.ok = false;
    out.diagnostics.push(diag('error', 'CHANGESET_DRIFT', `Код изменился после запечатывания: ${cls.invalidating.slice(0, 10).join(', ')}${cls.benign.length ? ` (плюс безобидные: ${cls.benign.join(', ')})` : ''}`, 'changeset', 'Верните файлы к запечатанному состоянию либо выполните `sbox changeset seal` и пройдите verify и review заново.'));
    return out;
  }
  if (!opts.rebind) {
    out.diagnostics.push(diag('info', 'CHANGESET_BENIGN_DRIFT', `После запечатывания изменились только безобидные файлы: ${cls.benign.join(', ')}`, 'changeset'));
    return out;
  }
  const fresh = sealChangeSet(root, sealed.base, exclude, sealed.sealed_after);
  writeChangeSet(dir, { ...fresh, sealed_at: sealed.sealed_at });
  const wasBound = change.reviewed_digest === change.changeset.digest;
  change.changeset = { ...change.changeset, digest: fresh.digest, paths: fresh.paths, rebound: [...change.changeset.rebound, { from: change.changeset.digest, to: fresh.digest, files: cls.benign, at: new Date().toISOString() }] };
  if (wasBound) change.reviewed_digest = fresh.digest;
  out.rebound = true;
  out.diagnostics.push(diag('info', 'CHANGESET_REBOUND', `Change-set перепривязан: после ревью изменились только ${cls.benign.join(', ')}`, 'changeset'));
  return out;
}
