import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { SboxError } from './errors.js';
import { exists, readText, today, writeText } from './paths.js';
import { headRevision, isGitRepo } from './changeset.js';
import type { Config } from './config.js';

export const PHASES = [
  'intake',
  'research',
  'propose',
  'plan',
  'cover',
  'tests_review',
  'implement',
  'verify',
  'review',
  'deliver',
  'archived',
] as const;
export type Phase = (typeof PHASES)[number];

export const STATUSES = [
  'active',
  'waiting_approval',
  'waiting_user',
  'waiting_peer',
  'parked',
  'blocked',
  'stopped',
  'delivery_unknown',
  'failed',
  'archived',
  'done',
] as const;
export type Status = (typeof STATUSES)[number];

/** Терминальные статусы не меняются обычными командами (docs/design.md, «Файл change.yaml»). */
export const TERMINAL_STATUSES: ReadonlySet<Status> = new Set<Status>(['archived', 'done', 'stopped', 'delivery_unknown']);

export const SIZES = ['small', 'normal', 'large'] as const;
export type Size = (typeof SIZES)[number];

const gateStateSchema = z.object({
  state: z.enum(['pending', 'approved', 'rejected', 'skipped']),
  by: z.string().optional(),
  at: z.string().optional(),
  comment: z.string().optional(),
  reason: z.string().optional(),
  promoted: z.array(z.string()).optional(),
  answers: z.record(z.string(), z.string()).optional(),
  posted_at: z.string().optional(),
  rejected_times: z.number().int().nonnegative().optional(),
});

const runSchema = z.object({
  id: z.string(),
  role: z.string(),
  phase: z.string(),
  attempt: z.number().int().positive().default(1),
  runner: z.string().optional(),
  model: z.string().optional(),
  session: z.string().optional(),
  started: z.string().optional(),
  finished: z.string().optional(),
  status: z.enum(['done', 'failed', 'blocked', 'running', 'stopped']),
  dir: z.string().optional(),
  cost_usd: z.number().optional(),
  failure: z.string().optional(),
});

const checkSchema = z.object({ id: z.string(), purpose: z.string().optional(), result: z.enum(['PASS', 'FAIL', 'PARTIAL', 'NOT_RUN']), evidence: z.string().optional() });
const gapSchema = z.object({ id: z.string(), environment: z.string().optional(), oracle: z.string().optional(), risk: z.string().optional() });

export const changeSchema = z.object({
  id: z.string(),
  title: z.string(),
  created: z.string(),
  revision: z.number().int().nonnegative().default(0),
  source: z
    .object({ kind: z.enum(['text', 'file', 'tracker', 'brief']), ref: z.string().optional(), brief: z.string().optional() })
    .default({ kind: 'text' }),
  size: z.enum(SIZES).default('normal'),
  skip_specs: z.boolean().default(false),
  autonomy: z.enum(['supervised', 'checkpoint', 'autonomous']).optional(),
  phase: z.enum(PHASES).default('intake'),
  status: z.enum(STATUSES).default('active'),
  settled: z.boolean().default(true),
  active_run: z.string().nullable().default(null),
  stop_requested: z.boolean().default(false),
  base_revision: z.string().nullable().default(null),
  gates: z.record(z.string(), gateStateSchema).default({}),
  complexity: z
    .object({ implementation: z.enum(['обычная', 'высокая']), review: z.enum(['обычная', 'высокая']) })
    .optional(),
  assumptions: z.array(z.object({ question: z.string(), priority: z.string(), accepted: z.string() })).default([]),
  protected: z.array(z.string()).default([]),
  /** Хеши защищённых файлов на момент завершения фазы cover: путь → sha256. */
  protected_snapshot: z.record(z.string(), z.string()).default({}),
  blocker: z
    .object({
      category: z.string(),
      artifact: z.string().optional(),
      message: z.string(),
      role: z.string().optional(),
      phase: z.string().optional(),
      resolution: z.string().optional(),
    })
    .nullable()
    .default(null),
  returns: z.record(z.string(), z.number().int()).default({}),
  returns_limit: z.number().int().positive().nullable().default(null),
  changeset: z
    .object({
      base: z.string(),
      digest: z.string(),
      paths: z.number().int(),
      sealed_after: z.string().nullable(),
      sealed_at: z.string(),
      /** Перепривязки после ревью из-за безобидных файлов: что и когда изменилось. */
      rebound: z.array(z.object({ from: z.string(), to: z.string(), files: z.array(z.string()), at: z.string() })).default([]),
    })
    .nullable()
    .default(null),
  reviewed_digest: z.string().nullable().default(null),
  verification: z.object({ run: z.string(), checks: z.array(checkSchema), gaps: z.array(gapSchema) }).nullable().default(null),
  accepted_gaps: z.array(z.object({ item: z.string(), reason: z.string().optional() })).default([]),
  delivery: z
    .object({
      intent_key: z.string(),
      created_at: z.string(),
      state: z.enum(['intent', 'archived', 'committed', 'pushed', 'pr_created', 'done']),
      commit: z.string().nullable().default(null),
      pr: z.object({ number: z.number().optional(), url: z.string().optional() }).nullable().default(null),
      error: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
  interventions: z.object({ resumes: z.number().int().nonnegative().default(0), user_blockers: z.number().int().nonnegative().default(0) }).prefault({}),
  rating: z.object({ score: z.number().int().min(1).max(5), comment: z.string().optional(), at: z.string() }).nullable().default(null),
  coordination: z.unknown().nullable().default(null),
  branch: z.string().optional(),
  pr: z.object({ number: z.number().optional(), url: z.string().optional(), draft: z.boolean().optional() }).optional(),
  runs: z.array(runSchema).default([]),
});

export type Change = z.infer<typeof changeSchema>;
export type GateState = z.infer<typeof gateStateSchema>;
export type Run = z.infer<typeof runSchema>;
export type VerificationCheck = z.infer<typeof checkSchema>;
export type VerificationGap = z.infer<typeof gapSchema>;

export const CHANGE_FILE = 'change.yaml';

export function changesDir(root: string, config: Config): string {
  return path.join(root, config.changes.dir);
}

export function changeDir(root: string, config: Config, id: string): string {
  return path.join(changesDir(root, config), id);
}

export function archiveDir(root: string, config: Config): string {
  return path.join(changesDir(root, config), 'archive');
}

export function isValidChangeId(id: string): boolean {
  return /^[a-z][a-z0-9-]{1,60}$/.test(id);
}

function parseChange(file: string): Change {
  const parsed = changeSchema.safeParse(YAML.parse(readText(file)) ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new SboxError('BAD_CHANGE', `Некорректный ${file}: ${issues}`);
  }
  return parsed.data;
}

export function loadChange(dir: string): Change {
  const file = path.join(dir, CHANGE_FILE);
  if (!exists(file)) throw new SboxError('NO_CHANGE', `Нет файла ${file}`);
  return parseChange(file);
}

export interface SaveOptions {
  /** Разрешить выход из терминального статуса: только для `change resume` и `change reopen`. */
  allowTerminalReopen?: boolean;
}

/**
 * Атомарная запись с проверкой ревизии: временный файл и переименование,
 * отклонение устаревшей копии и защита терминальных статусов.
 */
export function saveChange(dir: string, change: Change, opts: SaveOptions = {}): Change {
  const file = path.join(dir, CHANGE_FILE);
  if (exists(file)) {
    const disk = parseChange(file);
    if (disk.revision !== change.revision) {
      throw new SboxError('REVISION_CONFLICT', `change.yaml изменён другим процессом: на диске ревизия ${disk.revision}, в памяти ${change.revision}.`, 'Перечитайте изменение и повторите действие.');
    }
    if (TERMINAL_STATUSES.has(disk.status) && change.status !== disk.status && !opts.allowTerminalReopen) {
      throw new SboxError('TERMINAL_IMMUTABLE', `Статус ${disk.status} терминальный; переход в ${change.status} возможен только через \`sbox change resume\` или \`sbox change reopen\`.`);
    }
  }
  change.revision += 1;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmp, YAML.stringify(change, { lineWidth: 0 }), 'utf8');
  fs.renameSync(tmp, file);
  return change;
}

export function listChanges(root: string, config: Config): { id: string; dir: string; change: Change }[] {
  const base = changesDir(root, config);
  if (!exists(base)) return [];
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'archive' && exists(path.join(base, e.name, CHANGE_FILE)))
    .map((e) => ({ id: e.name, dir: path.join(base, e.name), change: loadChange(path.join(base, e.name)) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export interface NewChangeInput {
  id: string;
  title: string;
  request: string;
  source?: Change['source'];
  size?: Size;
  autonomy?: Change['autonomy'];
}

export function createChange(root: string, config: Config, input: NewChangeInput): { dir: string; change: Change } {
  if (!isValidChangeId(input.id)) {
    throw new SboxError('BAD_CHANGE_ID', `Идентификатор "${input.id}" должен быть в kebab-case: буквы, цифры, дефис, начинаться с буквы.`);
  }
  const dir = changeDir(root, config, input.id);
  if (exists(dir)) throw new SboxError('CHANGE_EXISTS', `Изменение ${input.id} уже существует: ${dir}`);
  const change: Change = changeSchema.parse({
    id: input.id,
    title: input.title,
    created: today(),
    source: input.source ?? { kind: 'text' },
    size: input.size ?? 'normal',
    autonomy: input.autonomy,
    phase: 'research',
    status: 'active',
    base_revision: isGitRepo(root) ? headRevision(root) : null,
  });
  fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'specs'), { recursive: true });
  writeText(path.join(dir, 'request.md'), input.request.endsWith('\n') ? input.request : `${input.request}\n`);
  writeText(path.join(dir, 'log.md'), `---\nchange: ${input.id}\n---\n\n# Журнал — ${input.id}\n\n<!-- [TASK] событие | [CODE] факт о коде | [RULE] правило | [HUMAN] предпочтение -->\n`);
  saveChange(dir, change);
  return { dir, change };
}

/** Найти изменение по id или единственное активное. */
export function resolveChange(root: string, config: Config, id?: string): { dir: string; change: Change } {
  if (id) {
    const dir = changeDir(root, config, id);
    return { dir, change: loadChange(dir) };
  }
  const all = listChanges(root, config);
  if (all.length === 1) return { dir: all[0]!.dir, change: all[0]!.change };
  if (all.length === 0) throw new SboxError('NO_CHANGES', 'Активных изменений нет.', 'Создайте изменение: `sbox change new <id> --title "..."`.');
  throw new SboxError('AMBIGUOUS_CHANGE', `Активных изменений несколько: ${all.map((c) => c.id).join(', ')}.`, 'Укажите --change <id>.');
}

export function nextRunId(change: Change): string {
  return `r${change.runs.length + 1}`;
}

export function runDir(dir: string, runId: string): string {
  return path.join(dir, 'runs', runId);
}
