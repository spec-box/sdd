import { z } from 'zod';
import type { Config } from './config.js';

export const ROLE_NAMES = ['researcher', 'planner', 'challenger', 'tester', 'implementer', 'reviewer', 'verifier', 'distiller'] as const;
export const MODEL_PROFILES = ['simple', 'medium', 'complex'] as const;
export type ModelProfile = typeof MODEL_PROFILES[number];
export type RunnerName = 'claude' | 'codex';
export const profileSchema = z.enum(MODEL_PROFILES);
export const complexityLevelSchema = z.enum(['простая', 'обычная', 'высокая']);
export const complexitySchema = z.object({ implementation: complexityLevelSchema, review: complexityLevelSchema });
export type Complexity = z.infer<typeof complexitySchema>;
export const roleProfilesSchema = z.partialRecord(z.enum(ROLE_NAMES), profileSchema).default({});
const effortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export type ModelSettings = { model: string; effort: z.infer<typeof effortSchema> };

/** Сохраняем имеющиеся идентификаторы моделей; проект может заменить любую пару. */
export const DEFAULT_MODEL_PROFILES: Record<RunnerName, Record<ModelProfile, ModelSettings>> = {
  claude: {
    simple: { model: 'claude-sonnet-5', effort: 'low' },
    medium: { model: 'claude-sonnet-5', effort: 'medium' },
    complex: { model: 'claude-opus-5', effort: 'high' },
  },
  codex: {
    simple: { model: 'gpt-5.6-terra', effort: 'low' },
    medium: { model: 'gpt-5.6-terra', effort: 'medium' },
    complex: { model: 'gpt-5.6-sol', effort: 'high' },
  },
};
export function modelProfilesSchema(runner: RunnerName) {
  const entry = (profile: ModelProfile) => z.object({
    model: z.string().trim().min(1).default(DEFAULT_MODEL_PROFILES[runner][profile].model),
    effort: effortSchema.default(DEFAULT_MODEL_PROFILES[runner][profile].effort).refine(
      value => runner === 'claude' ? !['none', 'minimal'].includes(value) : value !== 'max',
      { message: `Недопустимый effort для ${runner}` },
    ),
  }).strict().prefault({});
  return z.object({ simple: entry('simple'), medium: entry('medium'), complex: entry('complex') }).strict().prefault({});
}
export const DEFAULT_ROLE_PROFILES: Record<typeof ROLE_NAMES[number], ModelProfile> = {
  researcher: 'medium', planner: 'complex', challenger: 'complex', tester: 'medium',
  implementer: 'medium', reviewer: 'complex', verifier: 'medium', distiller: 'simple',
};
export function selectProfile(config: Config, role: typeof ROLE_NAMES[number], complexity?: Complexity): ModelProfile {
  const explicit = config.runner.roleProfiles[role];
  if (explicit) return explicit;
  // Независимое ревью не ослабляется оценкой сложности автора плана.
  const level = role === 'implementer' || role === 'tester' ? complexity?.implementation : undefined;
  if (level) return ({ простая: 'simple', обычная: 'medium', высокая: 'complex' } as const)[level];
  return DEFAULT_ROLE_PROFILES[role];
}
export function resolveModel(config: Config, runner: RunnerName, role: typeof ROLE_NAMES[number], complexity?: Complexity, profileOverride?: ModelProfile) {
  const profile = profileOverride ?? selectProfile(config, role, complexity);
  return { runner, profile, ...config.runner[runner].profiles[profile] };
}
export const hostAgentName = (role: string, profile: ModelProfile) => `sbox-${role}-${profile}`;

/** При автоматических возвратах сложность можно повысить, но нельзя незаметно понизить. */
export function higherComplexity(previous: Complexity[keyof Complexity] | undefined, next: Complexity[keyof Complexity]) {
  const order = ['простая', 'обычная', 'высокая'] as const;
  return previous && order.indexOf(previous) > order.indexOf(next) ? previous : next;
}

export const claudeAgentName = hostAgentName;
