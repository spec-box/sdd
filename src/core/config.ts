import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { SboxError } from './errors.js';
import { SBOX_DIR, CONFIG_FILE, exists, readText, writeText } from './paths.js';

export const AUTONOMY_PROFILES = ['supervised', 'checkpoint', 'autonomous'] as const;
export type AutonomyProfile = (typeof AUTONOMY_PROFILES)[number];

export const GATES = ['proposal', 'plan', 'tests'] as const;
export type Gate = (typeof GATES)[number];

const modelsSchema = z.record(z.string(), z.string());

export const configSchema = z.object({
  version: z.literal(1),
  spec: z.object({
    adapter: z.enum(['spec-box', 'openspec']),
    'spec-box': z
      .object({
        config: z.string().default('.tms.json'),
        files: z.array(z.string()).optional(),
        newFile: z.string().default('specs/{code}.spec-box.yml'),
      })
      .prefault({}),
    openspec: z.object({ root: z.string().default('openspec') }).prefault({}),
  }),
  autonomy: z.enum(AUTONOMY_PROFILES).default('supervised'),
  gates: z
    .object({
      channels: z.array(z.enum(['cli', 'pr-comments', 'tracker', 'chat'])).default(['cli']),
      /** Явный набор гейтов; если задан, имеет приоритет над профилем. */
      enabled: z.array(z.enum(GATES)).optional(),
    })
    .prefault({}),
  runner: z
    .object({
      default: z.enum(['claude', 'codex']).default('claude'),
      models: modelsSchema.default({}),
      /** Усилие модели по ролям (low | medium | high | xhigh); без записи роль получает medium, а не усилие сессии. */
      efforts: z.record(z.string(), z.string()).default({}),
      defaultEffort: z.string().default('medium'),
      /** Каталог вне репозитория для событий и stderr запусков. */
      stateDir: z.string().default('~/.sbox/runs'),
      timeoutMinutes: z.number().positive().default(120),
      idleTimeoutMinutes: z.number().positive().default(20),
      claude: z
        .object({
          executable: z.string().optional(),
          permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions']).default('acceptEdits'),
          allowedTools: z.array(z.string()).default(['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']),
          readOnlyTools: z.array(z.string()).default(['Read', 'Grep', 'Glob', 'Bash']),
          maxBudgetUsd: z.number().positive().optional(),
          maxTurns: z.number().int().positive().optional(),
        })
        .prefault({}),
      codex: z
        .object({
          executable: z.string().default('codex'),
          sandboxWrite: z.string().default('workspace-write'),
          sandboxRead: z.string().default('read-only'),
          approvalPolicy: z.string().default('on-request'),
          extraConfig: z.array(z.string()).default([]),
        })
        .prefault({}),
    })
    .prefault({}),
  repo: z
    .object({
      adapter: z.enum(['github', 'local']).default('local'),
      baseBranch: z.string().default('main'),
      branchPrefix: z.string().default('sbox/'),
      github: z
        .object({
          owner: z.string().optional(),
          repo: z.string().optional(),
          apiUrl: z.string().default('https://api.github.com'),
          tokenEnv: z.string().default('GITHUB_TOKEN'),
        })
        .prefault({}),
    })
    .prefault({}),
  changeset: z
    .object({
      exclude: z.array(z.string()).optional(),
      /** Файлы в change-set, изменение которых после verify/review не отменяет вердикт: дайджест перепривязывается с записью. */
      nonInvalidating: z.array(z.string()).default(['**/*.md', '.gitignore', '.gitattributes', '.editorconfig', '.claude/**', '.codex/**', '.sbox/**']),
    })
    .prefault({}),
  /** Проверка подключения по образцу: advisory (пункты PARTIAL для ревьюера) или strict (ошибка верификации). */
  wiring: z.object({ strict: z.boolean().default(false) }).prefault({}),
  changes: z.object({ dir: z.string().default('.sbox/changes') }).prefault({}),
  project: z.object({ docs: z.string().default('.sbox/project'), wiki: z.string().default('.sbox/wiki') }).prefault({}),
  testing: z
    .object({
      manualPlan: z.enum(['always', 'when-needed', 'never']).default('when-needed'),
      /** Повторять ИИ-ревью тестов после доработки по замечанию человека; по умолчанию только первый прогон. */
      reviewReworks: z.boolean().default(false),
      protectedGlobs: z.array(z.string()).default([]),
    })
    .prefault({}),
  limits: z
    .object({
      returnsPerPhase: z.number().int().positive().default(3),
      rejectionsPerPhase: z.number().int().nonnegative().default(2),
      maxRunsPerInvocation: z.number().int().positive().default(20),
      maxCostUsdPerInvocation: z.number().positive().optional(),
      packetFileChars: z.number().int().positive().default(4000),
    })
    .prefault({}),
  context: z.string().optional(),
  rules: z.record(z.string(), z.array(z.string())).prefault({}),
});

export type Config = z.infer<typeof configSchema>;

export function configPath(root: string): string {
  return path.join(root, SBOX_DIR, CONFIG_FILE);
}

export function loadConfig(root: string): Config {
  const file = configPath(root);
  if (!exists(file)) {
    throw new SboxError('NO_CONFIG', `Нет файла ${file}`, 'Выполните `sbox init`.');
  }
  const raw = YAML.parse(readText(file)) ?? {};
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new SboxError('BAD_CONFIG', `Некорректный ${file}: ${issues}`);
  }
  return parsed.data;
}

export function saveConfig(root: string, config: Config): void {
  writeText(configPath(root), YAML.stringify(config));
}

export function defaultConfig(specAdapter: 'spec-box' | 'openspec' = 'spec-box'): Config {
  return configSchema.parse({ version: 1, spec: { adapter: specAdapter } });
}

/** Какие гейты включены: явный список из конфига, иначе профиль автономии. */
export function enabledGates(config: Config, autonomy?: AutonomyProfile): Gate[] {
  if (config.gates.enabled) return [...config.gates.enabled];
  const profile = autonomy ?? config.autonomy;
  switch (profile) {
    case 'supervised':
      return ['proposal', 'plan', 'tests'];
    case 'checkpoint':
      return ['plan'];
    case 'autonomous':
      return [];
  }
}
