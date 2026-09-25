import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { diag, hasErrors, type Diagnostic } from './diagnostics.js';
import { nextRunId, runDir, saveChange, type Change, type Conflict, type Phase, type Run } from './change.js';
import { isGitRepo, sealChangeSet, writeChangeSet } from './changeset.js';
import { reconcileDrift } from './drift.js';
import { completePhase, nextStep, routeBlocker, type NextStep, type Role } from './phases.js';
import { parseRoleResult, type RoleResult } from './result.js';
import { artifactStates, loadWorkflow, pendingArtifacts } from './schema.js';
import { taskProgress } from './tasks.js';
import { wiringForChange } from './wiring.js';
import picomatch from 'picomatch';
import { protectedViolations, snapshotProtected, trackedChangedFiles } from './protect.js';
import { exists, readText, toPosix, writeText } from './paths.js';
import type { Config } from './config.js';
import type { SpecAdapter } from './spec-adapter.js';

export interface RunReceiptInput {
  runner?: string;
  model?: string;
  session?: string;
  attempt?: number;
  started?: string;
  exitCode?: number | null;
  costUsd?: number;
  promptSha256?: string;
  packetSha256?: string;
  eventsPath?: string;
  eventsSha256?: string;
  stderrSha256?: string;
  failure?: string;
}

export interface ReportInput {
  root: string;
  config: Config;
  dir: string;
  change: Change;
  role: Role;
  phase: Phase;
  markdown: string;
  adapter: SpecAdapter;
  receipt?: RunReceiptInput;
}

export interface ReportOutcome {
  runId: string;
  result: RoleResult;
  phaseCompleted: boolean;
  /** Отчёт принят: нет диагностик уровня error (для повторного отчёта: прежний запуск не был отклонён). */
  accepted: boolean;
  diagnostics: Diagnostic[];
  next: NextStep;
  /** Одна строка для человека: роль, запуск, статус, артефакты, расхождения, следующий шаг. Скилл показывает её дословно. */
  summary: string;
  /** Ответ уже был принят раньше: новый запуск не создавался, состояние не менялось. */
  alreadyApplied?: boolean;
}

export const CHANGESET_EXCLUDE_DEFAULT = ['.sbox/**', 'node_modules/**', 'dist/**', 'build/**', 'coverage/**', 'reports/**'];

export function changesetExclude(config: Config, changeDirRel: string): string[] {
  return [...(config.changeset?.exclude ?? CHANGESET_EXCLUDE_DEFAULT), `${changeDirRel}/**`];
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Принять ответ роли: сохранить, разобрать, проверить и перевести изменение в следующее состояние. */
export async function applyReport(input: ReportInput): Promise<ReportOutcome> {
  const { root, config, dir, change, role, phase, markdown } = input;
  const diagnostics: Diagnostic[] = [];
  const runId = nextRunId(change);
  const rdir = runDir(dir, runId);
  fs.mkdirSync(rdir, { recursive: true });
  const resultFile = path.join(rdir, 'result.md');
  writeText(resultFile, markdown);
  const receiptBase = {
    id: runId,
    role,
    phase,
    attempt: input.receipt?.attempt ?? 1,
    runner: input.receipt?.runner ?? null,
    model: input.receipt?.model ?? null,
    session: input.receipt?.session ?? null,
    // В интерактивном режиме старт запуска это момент выдачи пакета: packet.json не архивируется и не коммитится, поэтому время фиксируется здесь.
    started: input.receipt?.started ?? (exists(path.join(rdir, 'packet.json')) ? fs.statSync(path.join(rdir, 'packet.json')).mtime.toISOString() : null),
    finished: new Date().toISOString(),
    exit_code: input.receipt?.exitCode ?? null,
    cost_usd: input.receipt?.costUsd ?? null,
    packet_sha256: input.receipt?.packetSha256 ?? (exists(path.join(rdir, 'packet.json')) ? sha256(readText(path.join(rdir, 'packet.json'))) : null),
    prompt_sha256: input.receipt?.promptSha256 ?? null,
    result_sha256: sha256(markdown),
    result_bytes: Buffer.byteLength(markdown),
    events_path: input.receipt?.eventsPath ?? null,
    events_sha256: input.receipt?.eventsSha256 ?? null,
    stderr_sha256: input.receipt?.stderrSha256 ?? null,
  };
  const pushRun = (status: 'done' | 'failed' | 'blocked', failure?: string) => {
    change.runs.push({
      id: runId,
      role,
      phase,
      attempt: receiptBase.attempt,
      status,
      dir: `runs/${runId}`,
      finished: receiptBase.finished,
      ...(receiptBase.runner ? { runner: receiptBase.runner } : {}),
      ...(receiptBase.model ? { model: receiptBase.model } : {}),
      ...(receiptBase.session ? { session: receiptBase.session } : {}),
      ...(receiptBase.started ? { started: receiptBase.started } : {}),
      ...(receiptBase.cost_usd !== null ? { cost_usd: receiptBase.cost_usd } : {}),
      ...(failure ? { failure } : {}),
    });
    writeText(path.join(rdir, 'receipt.json'), `${JSON.stringify({ ...receiptBase, status, ...(failure ? { failure } : {}) }, null, 2)}\n`);
  };

  let result: RoleResult;
  try {
    result = parseRoleResult(markdown);
  } catch (e) {
    pushRun('failed', 'no-result');
    saveChange(dir, change);
    throw e;
  }

  saveEvidence(dir, change, role, phase, markdown);

  if (role === 'researcher' && phase === 'research') {
    // Противоречия запросу из «Разбора запроса» человек видит на гейте proposal (docs/design.md, раздел 5).
    replaceConflicts(change, role, (result.request ?? []).filter((r) => r.status === 'противоречит').map((r) => ({ kind: 'противоречие' as const, subject: 'запрос' as const, role, run: runId, text: r.quote, ...(r.evidence ? { evidence: r.evidence } : {}) })));
  }
  if (role === 'planner' && phase === 'propose') {
    if (result.size) change.size = result.size;
    if (result.skip_specs !== undefined) {
      change.skip_specs = result.skip_specs;
      const openspecMeta = path.join(dir, '.openspec.yaml');
      if (exists(openspecMeta)) writeText(openspecMeta, readText(openspecMeta).replace(/^skip_specs:.*$/m, `skip_specs: ${result.skip_specs}`));
    }
    replaceConflicts(change, role, (result.deviations ?? []).map((d) => ({ kind: 'отступление' as const, subject: d.subject, role, run: runId, text: d.text, decision: d.decision, ...(d.reason ? { reason: d.reason } : {}) })));
  }
  if (result.complexity) {
    const prev = change.complexity;
    change.complexity = {
      implementation: prev?.implementation === 'высокая' ? 'высокая' : result.complexity.implementation,
      review: prev?.review === 'высокая' ? 'высокая' : result.complexity.review,
    };
  }
  if (role === 'tester' && result.protected && result.protected.length > 0) {
    change.protected = [...new Set([...change.protected, ...result.protected, ...config.testing.protectedGlobs])];
  }
  if (role === 'verifier' && (result.checks || result.gaps)) {
    change.verification = { run: runId, checks: result.checks ?? [], gaps: result.gaps ?? [] };
    // Кандидаты подключения по образцу, которые верификатор не закрыл сам: становятся пунктами PARTIAL для disposition ревьюера.
    const w = wiringForChange(root, dir);
    if (w && w.gaps.length > 0) {
      const covered = new Set(change.verification.checks.flatMap((c) => w.gaps.filter((g) => `${c.purpose ?? ''} ${c.evidence ?? ''}`.includes(g.file)).map((g) => g.file)));
      for (const [i, gap] of w.gaps.filter((g) => !covered.has(g.file)).entries()) {
        change.verification.checks.push({ id: `W${i + 1}`, purpose: `подключение нового модуля «${w.fresh}» в ${gap.file}, где зарегистрирован образец «${w.analog}»`, result: 'PARTIAL', evidence: `sbox wiring: образец упомянут ${gap.analogMentions} раз, новый модуль не упомянут; верификатор этот файл не рассматривал` });
      }
    }
  }
  if (role === 'reviewer' && phase === 'review' && result.dispositions) {
    change.accepted_gaps = result.dispositions.filter((d) => d.disposition === 'manual_gap_accepted').map((d) => ({ item: d.item, ...(d.reason ? { reason: d.reason } : {}) }));
  }
  if (role === 'reviewer' && phase === 'review' && result.status === 'готово' && result.delivery_narrative) {
    change.delivery_narrative = result.delivery_narrative;
  }

  let phaseCompleted = false;
  let runStatus: 'done' | 'failed' | 'blocked' = 'done';
  const p0 = (result.questions ?? []).filter((q) => q.priority === 'P0');
  const changeDirRel = toPosix(path.relative(root, dir));

  if (result.status === 'заблокировано') {
    runStatus = 'blocked';
    routeBlocker(change, config, { category: result.blocker!.category, artifact: result.blocker!.artifact, message: result.blocker!.message ?? 'без описания', role, phase });
  } else if (p0.length > 0) {
    runStatus = 'blocked';
    routeBlocker(change, config, { category: 'пользователь', message: `Вопросы P0: ${p0.map((q) => `${q.id}: ${q.text}`).join(' | ')}`, role, phase });
  } else {
    const check = await checkPhaseDone({ ...input, result, changeDirRel });
    diagnostics.push(...check);
    if (hasErrors(check)) {
      runStatus = 'failed';
    } else if (role === 'verifier' && (result.checks ?? []).some((c) => c.result === 'FAIL')) {
      runStatus = 'blocked';
      routeBlocker(change, config, {
        category: 'реализация',
        message: `Проверки FAIL: ${(result.checks ?? []).filter((c) => c.result === 'FAIL').map((c) => `${c.id}${c.evidence ? ` (${c.evidence})` : ''}`).join(' | ')}`,
        role,
        phase,
      });
    } else if (role === 'reviewer' && (result.findings ?? []).some((f) => f.level === 'blocking')) {
      runStatus = 'blocked';
      routeBlocker(change, config, {
        category: phase === 'tests_review' ? 'тесты' : 'реализация',
        message: (result.findings ?? []).filter((f) => f.level === 'blocking').map((f) => `${f.file ? `${f.file}: ` : ''}${f.text}`).join(' | '),
        role,
        phase,
      });
    } else if (role === 'reviewer' && phase === 'review' && (result.dispositions ?? []).some((d) => d.disposition === 'change_required')) {
      runStatus = 'blocked';
      routeBlocker(change, config, {
        category: 'реализация',
        message: (result.dispositions ?? []).filter((d) => d.disposition === 'change_required').map((d) => `${d.item}: ${d.reason ?? ''}`).join(' | '),
        role,
        phase,
      });
    } else if (role === 'reviewer' && phase === 'review' && (result.dispositions ?? []).some((d) => d.disposition === 'blocked')) {
      runStatus = 'blocked';
      routeBlocker(change, config, {
        category: 'внешний',
        message: (result.dispositions ?? []).filter((d) => d.disposition === 'blocked').map((d) => `${d.item}: ${d.reason ?? ''}`).join(' | '),
        role,
        phase,
      });
    } else {
      if (phase === 'cover' && change.protected.length > 0) {
        change.protected_snapshot = snapshotProtected(root, change.protected);
        diagnostics.push(diag('info', 'PROTECTED_SNAPSHOT', `Снимок защищённых файлов: ${Object.keys(change.protected_snapshot).length}`, 'protected'));
      }
      if (phase === 'implement') sealAfterImplement(root, config, dir, change, runId, changeDirRel, diagnostics);
      if ((phase === 'verify' || phase === 'review') && change.changeset) change.reviewed_digest = change.changeset.digest;
      completePhase(change, config, phase);
      phaseCompleted = true;
    }
  }

  pushRun(runStatus, runStatus === 'failed' ? 'checks' : undefined);
  saveChange(dir, change);
  const next = nextStep(change, config);
  const summary = reportSummary({ root, dir, change, role, phase, runId, result, phaseCompleted, diagnostics, next });
  return { runId, result, phaseCompleted, accepted: !hasErrors(diagnostics), diagnostics, next, summary };
}

function sealAfterImplement(root: string, config: Config, dir: string, change: Change, runId: string, changeDirRel: string, diagnostics: Diagnostic[]): void {
  if (!isGitRepo(root) || !change.base_revision) {
    diagnostics.push(diag('warning', 'CHANGESET_SKIPPED', 'Change-set не запечатан: нет git-репозитория или базовой ревизии', 'changeset'));
    return;
  }
  const sealed = sealChangeSet(root, change.base_revision, changesetExclude(config, changeDirRel), runId);
  writeChangeSet(dir, sealed);
  change.changeset = { base: sealed.base, digest: sealed.digest, paths: sealed.paths, sealed_after: runId, sealed_at: sealed.sealed_at, rebound: [] };
  change.reviewed_digest = null;
  diagnostics.push(diag('info', 'CHANGESET_SEALED', `Change-set запечатан: ${sealed.paths} файлов, ${sealed.digest.slice(0, 19)}…`, 'changeset'));
}

const EVIDENCE_NAMES: Partial<Record<`${Role}:${Phase}`, (n: number) => string>> = {
  'researcher:research': () => 'research.md',
  'reviewer:tests_review': (n) => `tests-review-${n}.md`,
  'reviewer:review': (n) => `review-${n}.md`,
  'verifier:verify': (n) => `verify-${n}.md`,
  'challenger:plan': () => 'challenge.md',
};

/** Имя файла evidence для запуска роли: порядковый номер считается по запускам той же роли и фазы до этого запуска (runId null: до текущего момента). */
function evidenceName(change: Change, role: Role, phase: Phase, runId: string | null): string | null {
  const make = EVIDENCE_NAMES[`${role}:${phase}`];
  if (!make) return null;
  const idx = runId ? change.runs.findIndex((r) => r.id === runId) : -1;
  const before = idx >= 0 ? change.runs.slice(0, idx) : change.runs;
  return make(before.filter((r) => r.role === role && r.phase === phase).length + 1);
}

function saveEvidence(dir: string, change: Change, role: Role, phase: Phase, markdown: string): void {
  const name = evidenceName(change, role, phase, null);
  if (!name) return;
  const file = path.join(dir, 'evidence', name);
  if (role === 'researcher' && exists(file)) return;
  writeText(file, markdown);
}

/** Детерминированные проверки завершённости фазы: артефакты, дельты, задачи, защищённые файлы, дайджест, disposition. */
async function checkPhaseDone(input: ReportInput & { result: RoleResult; changeDirRel: string }): Promise<Diagnostic[]> {
  const { root, config, dir, change, phase, role, result, adapter, changeDirRel } = input;
  const out: Diagnostic[] = [];
  const workflow = loadWorkflow(root);
  const states = artifactStates(workflow, change, dir);

  if (role === 'researcher' && phase === 'research') out.push(...checkRequestMap(root, dir, change, result));
  if (role === 'planner' && phase === 'propose') {
    const open = change.conflicts.filter((c) => c.role === 'researcher');
    if (open.length > 0 && (result.deviations ?? []).length === 0) {
      out.push(diag('error', 'DEVIATIONS_MISSING', `Исследователь отметил противоречия запросу (${open.map((c) => c.id).join(', ')}), а в блоке sbox-result нет deviations`, 'deviations', 'Запишите раздел «Расхождения с запросом» в proposal.md: по каждому противоречию решение и причина, и продублируйте его в deviations.'));
    }
  }
  if (phase === 'propose' || phase === 'plan' || phase === 'cover') {
    for (const s of pendingArtifacts(states, phase)) {
      if (s.optional) continue;
      if (phase === 'cover' && s.id === 'test-plan') continue;
      out.push(diag('error', 'ARTIFACT_MISSING', `Артефакт ${s.id} не создан: ожидался ${path.relative(root, s.outputPath)}`, s.id));
    }
  }
  if (phase === 'plan' && !change.skip_specs) {
    try {
      const truth = await adapter.readTruth();
      const deltas = await adapter.readDelta(path.join(dir, 'specs'));
      if (deltas.length === 0) out.push(diag('error', 'DELTA_MISSING', 'В specs/ нет ни одной дельты, а skip_specs не задан', 'specs'));
      out.push(...adapter.validate(truth, deltas));
    } catch (e) {
      out.push(diag('error', 'DELTA_READ', (e as Error).message, 'specs'));
    }
  }
  if (phase === 'implement') {
    const tasksFile = path.join(dir, 'tasks.md');
    if (exists(tasksFile)) {
      const progress = taskProgress(readText(tasksFile));
      if (progress.remaining > 0) {
        out.push(diag('error', 'TASKS_REMAINING', `Не отмечено задач: ${progress.remaining} из ${progress.total}`, 'tasks.md', 'Выполните задачи и отметьте их `- [x]`, либо верните статус «заблокировано».'));
      }
    }
    if (change.protected.length > 0) {
      const hasSnapshot = Object.keys(change.protected_snapshot).length > 0;
      const violations = hasSnapshot
        ? protectedViolations(root, change.protected, change.protected_snapshot).map((v) => `${v.path} (${v.kind === 'modified' ? 'изменён' : v.kind === 'deleted' ? 'удалён' : 'добавлен'})`)
        : trackedChangedFiles(root).filter((f) => picomatch(change.protected, { dot: true })(f)).map((f) => `${f} (изменён)`);
      if (violations.length > 0) {
        out.push(diag('error', 'PROTECTED_CHANGED', `Изменены защищённые файлы: ${violations.join(', ')}`, 'protected', 'Откатите правки тестов; спорный тест возвращайте блокером категории «тесты».'));
      }
    }
  }
  if (phase === 'verify' && config.wiring.strict) {
    const w = wiringForChange(root, dir);
    if (w && w.gaps.length > 0) {
      out.push(diag('error', 'WIRING_MISSING', `Образец «${w.analog}» подключён в файлах, где нового модуля «${w.fresh}» нет: ${w.gaps.map((g) => g.file).join(', ')}`, 'wiring', 'Добавьте регистрацию или перечислите файлы в design.md строкой «Исключения подключения» с причиной; либо выключите wiring.strict.'));
    }
  }
  if ((phase === 'verify' || phase === 'review') && change.changeset && isGitRepo(root)) {
    // Безобидный дрейф (документация, .gitignore, материалы хостов) перепривязывается, код после запечатывания меняться не может.
    out.push(...reconcileDrift(root, config, dir, change, { rebind: true }).diagnostics);
  }
  if (role === 'reviewer' && phase === 'review') {
    const pending = new Set<string>();
    for (const c of change.verification?.checks ?? []) if (c.result !== 'PASS') pending.add(c.id);
    for (const g of change.verification?.gaps ?? []) pending.add(g.id);
    for (const d of result.dispositions ?? []) pending.delete(d.item);
    if (pending.size > 0) {
      out.push(diag('error', 'REVIEW_DISPOSITION_MISSING', `Нет disposition для пунктов верификатора: ${[...pending].join(', ')}`, 'dispositions', 'Каждый не-PASS пункт и пробел получает satisfied, manual_gap_accepted, change_required или blocked.'));
    }
    if (result.status === 'готово' && !result.delivery_narrative) {
      out.push(diag('error', 'DELIVERY_NARRATIVE_MISSING', 'Вердикт «готово» требует delivery_narrative с полями title, delta, why', 'delivery_narrative'));
    }
  }
  return out;
}

/** Нормализация для сверки цитат с запросом: регистр, ё, кавычки и выделение, тире, пробелы, знаки по краям. */
export function normalizeQuote(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"“”„‘’`*_]/g, '')
    .replace(/[—–]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.,;:!?()-]+|[\s.,;:!?()-]+$/g, '')
    .trim();
}

/** Текст, с которым сверяются цитаты «Разбора запроса»: бриф, если изменение создано из него, иначе request.md. */
function requestSource(root: string, dir: string, change: Change): { file: string; text: string } | null {
  const candidates = [...(change.source.kind === 'brief' && change.source.brief ? [path.resolve(root, change.source.brief)] : []), path.join(dir, 'request.md')];
  for (const file of candidates) if (exists(file)) return { file, text: readText(file) };
  return null;
}

/** Доля запроса, начиная с которой одна цитата считается пересказом целиком, а не отдельным утверждением. */
const BLANKET_SHARE = 0.8;

/**
 * Проверка «Разбора запроса»: поле обязательно, цитаты должны быть дословными.
 * Проверка не судит о смысле: она делает пересказ невозможным, а несовпадение видимым (предупреждение, не ошибка, чтобы не плодить круги доработки).
 */
function checkRequestMap(root: string, dir: string, change: Change, result: RoleResult): Diagnostic[] {
  const out: Diagnostic[] = [];
  const rows = result.request ?? [];
  if (rows.length === 0) {
    out.push(diag('error', 'REQUEST_MAP_MISSING', 'В блоке sbox-result нет поля request: разбора запроса по цитатам со статусами', 'request', 'Перечислите явные утверждения запроса дословными цитатами со статусом подтверждено, противоречит или не проверено; пересказ вместо цитаты не принимается.'));
    return out;
  }
  const source = requestSource(root, dir, change);
  if (!source) return out;
  const text = normalizeQuote(source.text);
  const file = toPosix(path.relative(root, source.file));
  for (const row of rows) {
    const quote = normalizeQuote(row.quote);
    const short = row.quote.length > 60 ? `${row.quote.slice(0, 57)}…` : row.quote;
    if (!quote || !text.includes(quote)) {
      out.push(diag('warning', 'REQUEST_QUOTE_MISMATCH', `Цитата не найдена в ${file}: «${short}»`, 'request', 'Цитируйте запрос дословно: статус пересказа проверить нельзя.'));
    } else if (rows.length === 1 || quote.length >= text.length * BLANKET_SHARE) {
      if (quote.length >= text.length * BLANKET_SHARE && text.split(' ').length > 3) {
        out.push(diag('warning', 'REQUEST_QUOTE_BLANKET', `Одна цитата покрывает почти весь запрос: «${short}»`, 'request', 'Разбейте запрос на отдельные утверждения: у каждого свой статус и доказательство.'));
      }
    }
  }
  return out;
}

/** Заменяет расхождения, заявленные ролью, и перенумеровывает идентификаторы C1, C2… в порядке появления. */
function replaceConflicts(change: Change, role: Role, items: Omit<Conflict, 'id'>[]): void {
  const kept = change.conflicts.filter((c) => c.role !== role);
  change.conflicts = [...kept, ...items].map((c, i) => ({ ...c, id: `C${i + 1}` }));
}

function recordedResultSha(dir: string, run: Run): string | null {
  const file = path.join(dir, run.dir ?? `runs/${run.id}`, 'receipt.json');
  if (!exists(file)) return null;
  try {
    return (JSON.parse(readText(file)) as { result_sha256?: string }).result_sha256 ?? null;
  } catch {
    return null;
  }
}

export interface ReportFile {
  file: string;
  /** Запуск, чей ответ с этим же содержимым уже принят: повторный отчёт, новый запуск не нужен. */
  applied: Run | null;
}

/**
 * Файл ответа для `sbox report`: явный `--file`, иначе `runs/<следующий>/result.md`.
 * Если его нет, а последний запуск той же роли переписал свой ответ после отклонённого отчёта, принимается он.
 * Совпадение sha с уже принятым ответом означает повторный отчёт (docs/design.md, раздел 12).
 */
export function resolveReportFile(dir: string, change: Change, role: Role, explicit?: string): ReportFile {
  const last = change.runs.at(-1);
  const sameRole = last && last.role === role && last.status !== 'running' ? last : null;
  const lastSha = sameRole ? recordedResultSha(dir, sameRole) : null;
  const appliedIf = (file: string): Run | null => (sameRole && lastSha && exists(file) && sha256(readText(file)) === lastSha ? sameRole : null);
  if (explicit) {
    const file = path.resolve(explicit);
    return { file, applied: appliedIf(file) };
  }
  const next = path.join(dir, 'runs', nextRunId(change), 'result.md');
  if (exists(next)) return { file: next, applied: null };
  const lastFile = sameRole ? path.join(dir, sameRole.dir ?? `runs/${sameRole.id}`, 'result.md') : null;
  if (lastFile && exists(lastFile)) return { file: lastFile, applied: appliedIf(lastFile) };
  return { file: next, applied: null };
}

export interface AppliedInput {
  root: string;
  config: Config;
  dir: string;
  change: Change;
  run: Run;
}

/** Результат уже принятого ответа для повторного `report`: без нового запуска и без изменения состояния. */
export function appliedOutcome(input: AppliedInput): ReportOutcome {
  const { root, config, dir, change, run } = input;
  const result = parseRoleResult(readText(path.join(dir, run.dir ?? `runs/${run.id}`, 'result.md')));
  const diagnostics: Diagnostic[] = [diag('info', 'REPORT_ALREADY_APPLIED', `Ответ запуска ${run.id} уже принят${run.finished ? ` ${run.finished}` : ''}; новый запуск не создан`, 'report')];
  if (run.status === 'failed') {
    diagnostics.push(diag('warning', 'RUN_FAILED', `Запуск ${run.id} завершился со статусом failed${run.failure ? ` (${run.failure})` : ''}`, 'report', 'Исправьте ответ роли и повторите report: изменённый файл будет принят как новый запуск.'));
  }
  const next = nextStep(change, config);
  const phaseCompleted = run.status === 'done';
  const role = run.role as Role;
  const phase = run.phase as Phase;
  const summary = reportSummary({ root, dir, change, role, phase, runId: run.id, result, phaseCompleted, diagnostics, next, alreadyApplied: true });
  return { runId: run.id, result, phaseCompleted, accepted: run.status !== 'failed', diagnostics, next, summary, alreadyApplied: true };
}

interface SummaryInput {
  root: string;
  dir: string;
  change: Change;
  role: Role;
  phase: Phase;
  runId: string;
  result: RoleResult;
  phaseCompleted: boolean;
  diagnostics: Diagnostic[];
  next: NextStep;
  alreadyApplied?: boolean;
}

/** Одна строка для человека: скилл показывает её дословно вместо пересказа сообщения субагента. */
export function reportSummary(s: SummaryInput): string {
  const errors = s.diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = s.diagnostics.filter((d) => d.severity === 'warning').length;
  const outcome = errors > 0 ? `отчёт не принят, ошибок: ${errors}` : s.phaseCompleted ? 'фаза завершена' : 'фаза не завершена';
  const parts = [`${s.role} ${s.runId}: ${s.result.status}${s.alreadyApplied ? ' (ответ уже был принят)' : ''}, ${outcome}${warnings > 0 ? `, предупреждений: ${warnings}` : ''}.`];
  const artifacts = summaryArtifacts(s.root, s.dir, s.change, s.role, s.phase, s.runId);
  if (artifacts.length > 0) parts.push(`Артефакты: ${artifacts.join(', ')}.`);
  if (s.change.conflicts.length > 0) parts.push(`Расхождения: ${s.change.conflicts.map((c) => c.id).join(', ')}.`);
  if (s.result.blocker && s.result.blocker.category !== 'нет') parts.push(`Блокер (${s.result.blocker.category})${s.result.blocker.message ? `: ${s.result.blocker.message}` : ''}.`);
  parts.push(describeNext(s.next));
  return parts.join(' ');
}

function summaryArtifacts(root: string, dir: string, change: Change, role: Role, phase: Phase, runId: string): string[] {
  const name = evidenceName(change, role, phase, runId);
  if (name) {
    const file = path.join(dir, 'evidence', name);
    return exists(file) ? [toPosix(path.relative(root, file))] : [];
  }
  if (role === 'planner' || role === 'tester') {
    return artifactStates(loadWorkflow(root), change, dir)
      .filter((st) => st.phase === phase && st.existing.length > 0)
      .flatMap((st) => st.existing.map((f) => toPosix(path.relative(root, f))));
  }
  return [];
}

function describeNext(next: NextStep): string {
  switch (next.kind) {
    case 'role':
      return `Дальше: роль ${next.role}, фаза ${next.phase}.`;
    case 'gate':
      return `Дальше: гейт ${next.gate}.`;
    case 'deliver':
      return 'Дальше: доставка.';
    case 'wait':
      return `Дальше: ожидание, статус ${next.status}${next.blocker ? `, блокер ${next.blocker.category}: ${next.blocker.message}` : ''}.`;
    default:
      return 'Изменение завершено.';
  }
}
