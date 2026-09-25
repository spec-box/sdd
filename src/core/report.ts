import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { diag, hasErrors, type Diagnostic } from './diagnostics.js';
import { nextRunId, runDir, saveChange, type Change, type Phase } from './change.js';
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
  diagnostics: Diagnostic[];
  next: NextStep;
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

  if (role === 'planner' && phase === 'propose') {
    if (result.size) change.size = result.size;
    if (result.skip_specs !== undefined) {
      change.skip_specs = result.skip_specs;
      const openspecMeta = path.join(dir, '.openspec.yaml');
      if (exists(openspecMeta)) writeText(openspecMeta, readText(openspecMeta).replace(/^skip_specs:.*$/m, `skip_specs: ${result.skip_specs}`));
    }
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
  return { runId, result, phaseCompleted, diagnostics, next: nextStep(change, config) };
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

function saveEvidence(dir: string, change: Change, role: Role, phase: Phase, markdown: string): void {
  const n = change.runs.filter((r) => r.role === role && r.phase === phase).length + 1;
  const names: Partial<Record<`${Role}:${Phase}`, string>> = {
    'researcher:research': 'research.md',
    'reviewer:tests_review': `tests-review-${n}.md`,
    'reviewer:review': `review-${n}.md`,
    'verifier:verify': `verify-${n}.md`,
    'challenger:plan': 'challenge.md',
  };
  const name = names[`${role}:${phase}`];
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
