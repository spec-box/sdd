import { enabledGates, type Config, type Gate } from './config.js';
import { SboxError } from './errors.js';
import type { Change, Phase } from './change.js';

export const ROLES = ['researcher', 'planner', 'challenger', 'tester', 'implementer', 'reviewer', 'verifier', 'distiller'] as const;
export type Role = (typeof ROLES)[number];

/** Порядок фаз (docs/design.md, раздел 4). intake выполняет CLI при создании изменения. */
export const PHASE_ORDER: Phase[] = [
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
];

export const ROLE_BY_PHASE: Partial<Record<Phase, Role>> = {
  research: 'researcher',
  propose: 'planner',
  plan: 'planner',
  cover: 'tester',
  tests_review: 'reviewer',
  implement: 'implementer',
  review: 'reviewer',
  verify: 'verifier',
};

/** Гейт стоит после фазы: пройдена фаза, ждём человека, потом следующая фаза. */
export const GATE_AFTER: Partial<Record<Phase, Gate>> = {
  propose: 'proposal',
  plan: 'plan',
  tests_review: 'tests',
};

export const PHASE_OF_GATE: Record<Gate, Phase> = {
  proposal: 'propose',
  plan: 'plan',
  tests: 'tests_review',
};

/** Куда возвращает блокер каждой категории. */
export const RETURN_PHASE: Record<string, Phase | null> = {
  артефакт: 'plan',
  тесты: 'cover',
  реализация: 'implement',
  внешний: null,
  пользователь: null,
};

export function nextPhase(phase: Phase): Phase | null {
  const i = PHASE_ORDER.indexOf(phase);
  return i >= 0 && i + 1 < PHASE_ORDER.length ? PHASE_ORDER[i + 1]! : null;
}

export type NextStep =
  | { kind: 'role'; role: Role; phase: Phase }
  | { kind: 'gate'; gate: Gate; phase: Phase }
  | { kind: 'deliver' }
  | { kind: 'wait'; status: Change['status']; blocker: Change['blocker'] }
  | { kind: 'done' };

export function isRoleName(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function gateEnabled(change: Change, config: Config, gate: Gate): boolean {
  return enabledGates(config, change.autonomy).includes(gate);
}

/** Что делать дальше по состоянию изменения. Чистая функция, ничего не меняет. */
export function nextStep(change: Change, config: Config): NextStep {
  switch (change.status) {
    case 'waiting_approval': {
      const pending = (Object.entries(change.gates).find(([, g]) => g.state === 'pending') ?? [])[0] as Gate | undefined;
      if (pending) return { kind: 'gate', gate: pending, phase: PHASE_OF_GATE[pending] };
      break;
    }
    case 'waiting_user':
    case 'waiting_peer':
    case 'parked':
    case 'blocked':
    case 'stopped':
    case 'delivery_unknown':
    case 'failed':
      return { kind: 'wait', status: change.status, blocker: change.blocker };
    case 'archived':
    case 'done':
      return { kind: 'done' };
    case 'active':
      break;
  }
  const phase: Phase = change.phase === 'intake' ? 'research' : change.phase;
  if (phase === 'deliver') return { kind: 'deliver' };
  if (phase === 'archived') return { kind: 'done' };
  const role = ROLE_BY_PHASE[phase];
  if (!role) throw new SboxError('BAD_PHASE', `Для фазы ${phase} не задана роль`);
  return { kind: 'role', role, phase };
}

/** Фаза завершена успешно: либо гейт, либо следующая фаза. Мутирует change. */
export function completePhase(change: Change, config: Config, phase: Phase): void {
  change.blocker = null;
  // Доработка тестов по замечанию человека с гейта: ИИ-ревью уже было, идём сразу на гейт.
  if (phase === 'cover' && !config.testing.reviewReworks && change.gates.tests?.state === 'rejected') {
    change.phase = 'tests_review';
    completePhase(change, config, 'tests_review');
    return;
  }
  const gate = GATE_AFTER[phase];
  if (gate) {
    const state = change.gates[gate];
    if (gateEnabled(change, config, gate) && state?.state !== 'approved') {
      change.gates[gate] = { state: 'pending', ...(state?.rejected_times ? { rejected_times: state.rejected_times } : {}) };
      change.status = 'waiting_approval';
      change.phase = phase;
      return;
    }
    if (!gateEnabled(change, config, gate) && state?.state !== 'approved') {
      change.gates[gate] = { state: 'skipped', reason: 'autonomy' };
    }
  }
  advance(change, phase);
}

export function advance(change: Change, from: Phase): void {
  const next = nextPhase(from);
  if (!next) {
    change.status = 'done';
    return;
  }
  change.phase = next;
  change.status = next === 'archived' ? 'archived' : 'active';
}

export function approveGate(change: Change, gate: Gate, by: string, comment?: string, answers?: Record<string, string>): void {
  const state = change.gates[gate];
  if (!state || state.state !== 'pending') {
    throw new SboxError('GATE_NOT_PENDING', `Гейт ${gate} не ожидает решения (состояние: ${state?.state ?? 'нет'}).`);
  }
  change.gates[gate] = { state: 'approved', by, at: new Date().toISOString(), ...(comment ? { comment } : {}), ...(answers ? { answers } : {}), ...(state.rejected_times ? { rejected_times: state.rejected_times } : {}) };
  change.status = 'active';
  advance(change, PHASE_OF_GATE[gate]);
}

export function rejectGate(change: Change, gate: Gate, by: string, comment: string): void {
  const state = change.gates[gate];
  if (!state || state.state !== 'pending') {
    throw new SboxError('GATE_NOT_PENDING', `Гейт ${gate} не ожидает решения (состояние: ${state?.state ?? 'нет'}).`);
  }
  change.gates[gate] = { state: 'rejected', by, at: new Date().toISOString(), comment, rejected_times: (state.rejected_times ?? 0) + 1 };
  change.status = 'active';
  // Возврат на фазу, которая производит утверждаемый артефакт.
  change.phase = gate === 'tests' ? 'cover' : PHASE_OF_GATE[gate];
  change.blocker = { category: 'пользователь', message: comment, phase: change.phase };
}

/** Маршрутизация блокера. Возвращает фазу возврата или null, если запуск останавливается. */
export function routeBlocker(
  change: Change,
  config: Config,
  input: { category: string; artifact?: string; message: string; role: Role; phase: Phase },
): Phase | null {
  change.blocker = { category: input.category, message: input.message, role: input.role, phase: input.phase, ...(input.artifact ? { artifact: input.artifact } : {}) };
  const target = RETURN_PHASE[input.category] ?? null;
  if (input.category === 'пользователь') {
    change.status = 'waiting_user';
    change.interventions.user_blockers += 1;
    return null;
  }
  if (!target) {
    change.status = 'blocked';
    return null;
  }
  const limit = change.returns_limit ?? config.limits.returnsPerPhase;
  const count = (change.returns[target] ?? 0) + 1;
  change.returns[target] = count;
  if (count > limit) {
    change.status = 'parked';
    change.blocker.message = `Лимит возвратов в фазу ${target} (${limit}) исчерпан. Последний блокер: ${input.message}`;
    return null;
  }
  change.phase = target;
  change.status = 'active';
  return target;
}

export const RESUMABLE_STATUSES: ReadonlySet<Change['status']> = new Set<Change['status']>(['parked', 'blocked', 'failed', 'waiting_user', 'stopped', 'delivery_unknown']);

/**
 * Явное продолжение человеком (docs/design.md, «Возвраты»): снимает parked/blocked,
 * при необходимости поднимает бюджет возвратов и записывает ответ на блокер как фидбэк.
 */
export function resumeChange(change: Change, config: Config, opts: { returns?: number; comment?: string } = {}): Phase {
  if (!RESUMABLE_STATUSES.has(change.status)) {
    throw new SboxError('NOT_RESUMABLE', `Статус ${change.status} не требует продолжения.`);
  }
  const category = change.blocker?.category;
  const target = category ? (RETURN_PHASE[category] ?? null) : null;
  if (change.status === 'parked' && target) {
    const used = change.returns[target] ?? 0;
    const current = change.returns_limit ?? config.limits.returnsPerPhase;
    if (opts.returns === undefined) {
      throw new SboxError('RETURNS_REQUIRED', `Бюджет возвратов в фазу ${target} исчерпан (${used} из ${current}).`, 'Укажите --returns N с числом больше использованного.');
    }
    if (opts.returns <= used) throw new SboxError('RETURNS_TOO_SMALL', `--returns ${opts.returns} не больше использованных ${used}.`);
    change.returns_limit = opts.returns;
    change.phase = target;
  } else if (opts.returns !== undefined) {
    change.returns_limit = opts.returns;
  }
  if (change.status === 'delivery_unknown') {
    change.phase = 'deliver';
  }
  if (change.blocker && opts.comment) change.blocker.resolution = opts.comment;
  change.interventions.resumes += 1;
  change.stop_requested = false;
  change.status = 'active';
  return change.phase;
}
