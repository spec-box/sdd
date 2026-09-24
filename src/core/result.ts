import YAML from 'yaml';
import { z } from 'zod';
import { SboxError } from './errors.js';

/** Машиночитаемый блок в конце ответа роли (docs/design.md, раздел 5). */
export const ROLE_STATUSES = ['готово', 'утверждение', 'заблокировано'] as const;
export const BLOCKER_CATEGORIES = ['артефакт', 'тесты', 'реализация', 'внешний', 'пользователь', 'нет'] as const;
export const DISPOSITIONS = ['satisfied', 'manual_gap_accepted', 'change_required', 'blocked'] as const;

export const roleResultSchema = z.object({
  status: z.enum(ROLE_STATUSES),
  blocker: z
    .object({
      category: z.enum(BLOCKER_CATEGORIES).default('нет'),
      artifact: z.string().optional(),
      message: z.string().optional(),
    })
    .optional(),
  complexity: z
    .object({ implementation: z.enum(['обычная', 'высокая']), review: z.enum(['обычная', 'высокая']) })
    .optional(),
  size: z.enum(['small', 'normal', 'large']).optional(),
  skip_specs: z.boolean().optional(),
  questions: z
    .array(z.object({ id: z.string(), priority: z.enum(['P0', 'P1', 'P2']), text: z.string() }))
    .optional(),
  findings: z
    .array(z.object({ level: z.enum(['blocking', 'non-blocking']), file: z.string().optional(), text: z.string() }))
    .optional(),
  checks: z
    .array(z.object({ id: z.string(), purpose: z.string().optional(), result: z.enum(['PASS', 'FAIL', 'PARTIAL', 'NOT_RUN']), evidence: z.string().optional() }))
    .optional(),
  gaps: z.array(z.object({ id: z.string(), environment: z.string().optional(), oracle: z.string().optional(), risk: z.string().optional() })).optional(),
  dispositions: z.array(z.object({ item: z.string(), disposition: z.enum(DISPOSITIONS), reason: z.string().optional() })).optional(),
  delivery_narrative: z
    .object({
      title: z.string().min(1),
      delta: z.string().min(1),
      why: z.string().min(1),
      preserved: z.string().optional(),
      rollout: z.string().optional(),
      rollback: z.string().optional(),
    })
    .optional(),
  protected: z.array(z.string()).optional(),
  verified: z.array(z.string()).optional(),
});

export type RoleResult = z.infer<typeof roleResultSchema>;

/**
 * Ищет последний fenced-блок yaml, содержащий маркер `# sbox-result`,
 * либо блок, начинающийся строкой `# sbox-result` без ограждения.
 */
export function extractResultBlock(markdown: string): string | null {
  const fences = [...markdown.matchAll(/```(?:ya?ml)?[^\n]*\n([\s\S]*?)```/g)];
  for (let i = fences.length - 1; i >= 0; i -= 1) {
    const body = fences[i]![1] ?? '';
    if (/^\s*#\s*sbox-result/m.test(body)) return body;
  }
  const bare = markdown.match(/^#\s*sbox-result\s*\n([\s\S]*)$/m);
  return bare ? bare[1]! : null;
}

export function parseRoleResult(markdown: string): RoleResult {
  const block = extractResultBlock(markdown);
  if (!block) {
    throw new SboxError(
      'NO_RESULT_BLOCK',
      'В ответе роли нет блока `# sbox-result`.',
      'Завершите ответ блоком ```yaml с первой строкой `# sbox-result` и полем status.',
    );
  }
  let raw: unknown;
  try {
    raw = YAML.parse(block);
  } catch (e) {
    throw new SboxError('BAD_RESULT_YAML', `Блок sbox-result не разбирается как YAML: ${(e as Error).message}`);
  }
  const parsed = roleResultSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new SboxError('BAD_RESULT', `Блок sbox-result не соответствует контракту: ${issues}`);
  }
  const result = parsed.data;
  if (result.status === 'заблокировано' && (!result.blocker || result.blocker.category === 'нет')) {
    throw new SboxError('BAD_RESULT', 'Статус «заблокировано» требует blocker.category, отличную от «нет».');
  }
  return result;
}

/** Ответ в формате JSON (например, из `codex exec --output-schema`) переводится в Markdown с блоком sbox-result. */
export function jsonAnswerToMarkdown(json: unknown): string {
  const obj = (json ?? {}) as { markdown?: string; result?: unknown };
  const markdown = typeof obj.markdown === 'string' ? obj.markdown : '';
  const result = obj.result ?? json;
  return `${markdown.trimEnd()}\n\n\`\`\`yaml\n# sbox-result\n${YAML.stringify(result, { lineWidth: 0 })}\`\`\`\n`;
}
