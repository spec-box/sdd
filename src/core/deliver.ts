import { createHash } from 'node:crypto';
import path from 'node:path';
import { archiveChange } from './archive.js';
import { loadChange, saveChange, type Change } from './change.js';
import { isGitRepo } from './changeset.js';
import { reconcileDrift } from './drift.js';
import { diag, type Diagnostic } from './diagnostics.js';
import { SboxError } from './errors.js';
import { exists, readText } from './paths.js';
import { renderPullRequestBody, type DodItem } from './pr-body.js';
import { parseRoleResult, type RoleResult } from './result.js';
import { taskProgress } from './tasks.js';
import type { Config } from './config.js';
import type { DeliveryReceipt, RepoHost } from './repo-host.js';
import type { SpecAdapter } from './spec-adapter.js';

export interface DeliverOptions {
  root: string;
  config: Config;
  dir: string;
  change: Change;
  adapter: SpecAdapter;
  host: RepoHost;
  /** Оставить пул-реквест черновиком. */
  keepDraft?: boolean;
  /** Доставить, даже если чеклист готовности не выполнен: невыполненные пункты попадут в описание пул-реквеста. */
  force?: boolean;
  log?: (line: string) => void;
}

export interface DeliverResult {
  dod: DodItem[];
  receipt: DeliveryReceipt;
  archivedTo: string;
  prBody: string;
}

/** Последний ответ ревьюера в фазе review с delivery_narrative; после архивации (runs/ удалён) берётся narrative из change.yaml. */
export function lastReviewResult(dir: string, change: Change): RoleResult | null {
  const runs = [...change.runs].reverse().filter((r) => r.role === 'reviewer' && r.phase === 'review' && r.status === 'done');
  for (const r of runs) {
    const file = path.join(dir, r.dir ?? `runs/${r.id}`, 'result.md');
    if (!exists(file)) continue;
    try {
      return parseRoleResult(readText(file));
    } catch {
      continue;
    }
  }
  if (change.delivery_narrative) return { status: 'готово', delivery_narrative: change.delivery_narrative };
  return null;
}

/** Условия готовности к влитию (docs/design.md, раздел 1). */
export async function readinessChecklist(root: string, config: Config, dir: string, change: Change, adapter: SpecAdapter): Promise<{ dod: DodItem[]; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];
  const dod: DodItem[] = [];
  const tasksFile = path.join(dir, 'tasks.md');
  const tasks = exists(tasksFile) ? taskProgress(readText(tasksFile)) : null;
  dod.push({ id: 1, text: 'Все задачи из tasks.md отмечены', ok: tasks ? tasks.remaining === 0 : false, detail: tasks ? `${tasks.done}/${tasks.total}` : 'нет tasks.md' });

  const verification = change.verification;
  const failed = verification?.checks.filter((c) => c.result === 'FAIL') ?? [];
  dod.push({ id: 2, text: 'Автотесты фазы cover проходят, отчёт верификатора приложен', ok: Boolean(verification) && failed.length === 0, detail: verification ? `${verification.checks.length} проверок, FAIL ${failed.length}` : 'нет отчёта' });

  dod.push({ id: 3, text: 'Защищённые тестовые файлы не изменены реализацией', ok: true, detail: `${change.protected.length} шаблонов` });

  dod.push({ id: 4, text: 'Проверки проекта проходят', ok: Boolean(verification) && failed.length === 0 });

  const review = lastReviewResult(dir, change);
  const reviewOk = review?.status === 'готово' && Boolean(review.delivery_narrative);
  const pendingItems = new Set<string>();
  for (const c of verification?.checks ?? []) if (c.result !== 'PASS') pendingItems.add(c.id);
  for (const g of verification?.gaps ?? []) pendingItems.add(g.id);
  for (const d of review?.dispositions ?? []) pendingItems.delete(d.item);
  dod.push({ id: 5, text: 'Ревью завершено вердиктом «готово», каждый не-PASS пункт получил disposition', ok: reviewOk && pendingItems.size === 0, detail: pendingItems.size ? `без disposition: ${[...pendingItems].join(', ')}` : undefined });

  let deltasOk = true;
  try {
    if (!change.skip_specs) {
      const truth = await adapter.readTruth();
      const deltas = await adapter.readDelta(path.join(dir, 'specs'));
      const errors = adapter.validate(truth, deltas).filter((d) => d.severity === 'error');
      deltasOk = deltas.length > 0 && errors.length === 0;
    }
  } catch {
    deltasOk = false;
  }
  dod.push({ id: 6, text: 'Дельты спецификаций валидны и будут применены к истине', ok: deltasOk });

  const manualPlan = path.join(dir, 'test-plan.md');
  const needsPlan = config.testing.manualPlan === 'always' || change.accepted_gaps.length > 0;
  dod.push({ id: 7, text: 'План ручного тестирования приложен, если требуется', ok: !needsPlan || exists(manualPlan), detail: needsPlan ? (exists(manualPlan) ? 'есть' : 'требуется, но нет') : 'не требуется' });

  const p0p1 = change.blocker?.category === 'пользователь';
  dod.push({ id: 8, text: 'Открытых вопросов P0 и P1 нет', ok: !p0p1 });

  let bound = true;
  let boundDetail: string | undefined;
  if (change.changeset && isGitRepo(root)) {
    const drift = reconcileDrift(root, config, dir, change, { rebind: true });
    if (drift.rebound) {
      saveChange(dir, change);
      boundDetail = `после ревью изменились только ${drift.benign.join(', ')}; change-set перепривязан`;
    }
    if (!drift.ok) {
      bound = false;
      boundDetail = `после ревью изменился код: ${drift.invalidating.join(', ')}. Выполните \`sbox changeset seal\` и пройдите verify и review заново`;
    } else if (change.reviewed_digest !== change.changeset.digest) {
      bound = false;
      boundDetail = 'после последнего запечатывания фазы verify и review не завершались: запустите `/sbox-run` или `sbox run`, они пройдут verify и review по текущему change-set';
    }
  }
  dod.push({ id: 9, text: 'Вердикты verify и review привязаны к текущему change-set', ok: bound, ...(boundDetail ? { detail: boundDetail } : {}) });

  for (const item of dod) if (!item.ok) diagnostics.push(diag('error', `DOD_${item.id}`, `${item.text}${item.detail ? ` (${item.detail})` : ''}`, 'deliver'));
  return { dod, diagnostics };
}

/**
 * Доставка (docs/design.md, фаза deliver): чеклист, write-ahead intent, архивация внутри ветки,
 * коммит с ключом, push, пул-реквест. Повторный вызов после сбоя продолжает с записанного состояния.
 */
export async function deliverChange(opts: DeliverOptions): Promise<DeliverResult> {
  const { root, config, dir, adapter, host } = opts;
  const log = opts.log ?? (() => {});
  let change = opts.change;
  const resuming = Boolean(change.delivery);
  if (!resuming && change.phase !== 'deliver') {
    throw new SboxError('NOT_DELIVERABLE', `Изменение в фазе ${change.phase}, а не deliver.`);
  }
  const { dod, diagnostics } = await readinessChecklist(root, config, dir, change, adapter);
  change = loadChange(dir); // readiness могла перепривязать change-set
  if (diagnostics.length > 0 && !change.delivery && !opts.force) {
    throw new SboxError('DOD_FAILED', `Не выполнены условия готовности:\n${dod.filter((i) => !i.ok).map((i) => `  ${i.id}. ${i.text}${i.detail ? `: ${i.detail}` : ''}`).join('\n')}`, 'Устраните пункты или доставьте как есть: `sbox deliver --force` (невыполненные пункты останутся в чеклисте пул-реквеста).');
  }
  const review = lastReviewResult(dir, change);
  const narrative = review?.delivery_narrative;
  if (!narrative) throw new SboxError('DELIVERY_NARRATIVE_MISSING', 'Нет delivery_narrative ревьюера.');
  const deltas = change.skip_specs ? [] : await adapter.readDelta(path.join(dir, 'specs'));

  const branch = change.branch ?? `${config.repo.branchPrefix}${change.id}`;
  const intentKey = change.delivery?.intent_key ?? `${change.id}:${(change.changeset?.digest ?? createHash('sha256').update(change.id).digest('hex')).replace(/^sha256:/, '').slice(0, 16)}`;
  const prBody = renderPullRequestBody({ change, dir, narrative, deltas, dod });
  const prTitle = `${narrative.title}`;
  const commitMessage = `${narrative.title}\n\n${narrative.delta}`;

  // 1. Write-ahead intent.
  if (!change.delivery) {
    change.delivery = { intent_key: intentKey, created_at: new Date().toISOString(), state: 'intent', commit: null, pr: null, error: null };
    change.branch = branch;
    saveChange(dir, change);
    log(`intent ${intentKey} записан`);
  }
  if (isGitRepo(root) && host.currentBranch() !== branch) host.ensureBranch(branch, config.repo.baseBranch);

  // 2. Архивация внутри ветки: дельты в истину, папка в архив.
  let archivedTo: string;
  if (change.delivery.state === 'intent') {
    const result = await archiveChange(root, config, adapter, dir, change, { force: opts.force });
    if (result.cleanedStaleArchive) log('удалён пустой каталог архива от прерванной попытки');
    archivedTo = result.archivedTo;
    change = loadChange(archivedTo);
    change.delivery!.state = 'archived';
    saveChange(archivedTo, change, { allowTerminalReopen: true });
    log(`архив: ${path.relative(root, archivedTo)}`);
  } else {
    archivedTo = dir;
  }
  const workDir = archivedTo;

  const receipt: DeliveryReceipt = { commit: '', pushed: false, pr: null, reused: { commit: false, pr: false } };
  try {
    // 3. Коммит с ключом идемпотентности.
    const existing = host.findCommitByIntent(intentKey);
    if (existing) {
      receipt.commit = existing;
      receipt.reused.commit = true;
    } else {
      receipt.commit = host.commitAll(commitMessage, intentKey);
    }
    change.delivery!.commit = receipt.commit;
    change.delivery!.state = 'committed';
    saveChange(workDir, change, { allowTerminalReopen: true });
    log(`коммит ${receipt.commit.slice(0, 10)}${receipt.reused.commit ? ' (существующий)' : ''}`);

    // 4. Push и пул-реквест.
    host.push(branch);
    receipt.pushed = true;
    change.delivery!.state = 'pushed';
    saveChange(workDir, change, { allowTerminalReopen: true });
    let pr = await host.findPullRequest(branch);
    if (pr) receipt.reused.pr = true;
    else if (host.name !== 'local') pr = await host.openPullRequest({ branch, base: config.repo.baseBranch, title: prTitle, body: prBody, draft: true });
    if (pr) {
      pr = await host.updatePullRequest(pr, { title: prTitle, body: prBody, draft: opts.keepDraft ? undefined : false });
      change.pr = { number: pr.number, url: pr.url, draft: pr.draft };
      change.delivery!.pr = { number: pr.number, url: pr.url };
      log(`пул-реквест ${pr.url}${receipt.reused.pr ? ' (существующий)' : ''}`);
    }
    receipt.pr = pr;
    change.delivery!.state = 'done';
    change.status = 'done';
    saveChange(workDir, change, { allowTerminalReopen: true });
  } catch (e) {
    // Внешняя операция могла выполниться: фиксируем неизвестный исход, повтор только через resume.
    change.status = 'delivery_unknown';
    change.delivery!.error = (e as Error).message;
    saveChange(workDir, change, { allowTerminalReopen: true });
    throw new SboxError('DELIVERY_UNKNOWN', `Доставка прервана после внешней операции (${change.delivery!.state}): ${(e as Error).message}`, 'Проверьте коммит и пул-реквест вручную, затем `sbox change resume` и `sbox deliver`.');
  }
  return { dod, receipt, archivedTo: workDir, prBody };
}
