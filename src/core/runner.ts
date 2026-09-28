import type { Config } from './config.js';
import type { Phase } from './change.js';
import type { Role } from './phases.js';
import type { RolePacket } from './packet.js';

/** Контракт адаптера среды запуска агентов (docs/design.md, раздел 11). */
export interface RunRequest {
  role: Role;
  phase: Phase;
  packet: RolePacket;
  /** Готовый текст промпта: определение роли и пакет. */
  prompt: string;
  cwd: string;
  model: string;
  effort?: string;
  readOnly: boolean;
  resumeSession?: string;
  /** Абсолютный путь файла, куда роль пишет ответ. */
  resultFile: string;
  /** Каталог запуска внутри изменения (пакет, ответ, receipt). */
  runDir: string;
  /** Каталог вне репозитория для событий и stderr. */
  stateDir: string;
  signal: AbortSignal;
  timeoutMs: number;
  idleTimeoutMs: number;
  env?: Record<string, string>;
}

export type RunFailure = 'transport' | 'capacity' | 'no-result' | 'timeout' | 'stopped' | 'tool' | 'unknown';

export interface RunResponse {
  usable: boolean;
  markdown: string | null;
  session?: string;
  costUsd?: number;
  exitCode?: number | null;
  failure?: RunFailure;
  failureMessage?: string;
  eventsPath?: string;
  stderrPath?: string;
  started: string;
  finished: string;
}

export interface AgentRunner {
  readonly name: string;
  readonly supportsResume: boolean;
  run(request: RunRequest): Promise<RunResponse>;
}

export type RunnerFactory = (root: string, config: Config) => AgentRunner;

const registry = new Map<string, RunnerFactory>();

export function registerRunner(name: string, factory: RunnerFactory): void {
  registry.set(name, factory);
}

export function createRunner(name: string, root: string, config: Config): AgentRunner {
  const factory = registry.get(name);
  if (!factory) throw new Error(`Адаптер среды "${name}" не зарегистрирован`);
  return factory(root, config);
}

/** Повтор допустим только для сбоев без пригодного результата (docs/design.md, «Возвраты»). */
export function transportRetryAllowed(failure: RunFailure | undefined): boolean {
  return failure === 'transport' || failure === 'capacity' || failure === 'no-result';
}

/** Ролям без права записи среда даёт только чтение и запуск проверок. */
export const READ_ONLY_ROLES: ReadonlySet<Role> = new Set<Role>(['researcher', 'challenger', 'reviewer', 'verifier']);
