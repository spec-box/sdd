import YAML from 'yaml';
import { z } from 'zod';
import { diag, type Diagnostic } from '../../../core/diagnostics.js';
import { slugify, type Capability, type DeltaOp, type Requirement, type SpecDelta } from '../../../core/spec-model.js';
import { toRequirement, toScenario } from './yaml.js';

const assertSchema = z.object({ assert: z.string().min(1), description: z.string().optional() });
const groupMap = z.record(z.string(), z.array(assertSchema));

/**
 * Диалект дельты spec-box (docs/design.md, «Дельты спецификаций»):
 * секции added / modified / removed / renamed поверх структуры specs-unit.
 */
export const specBoxDeltaSchema = z.object({
  code: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'code: только латиница, цифры, - и _'),
  feature: z.string().optional(),
  description: z.string().optional(),
  type: z.enum(['Functional', 'Visual']).optional(),
  definitions: z.record(z.string(), z.array(z.string())).optional(),
  added: groupMap.optional(),
  modified: groupMap.optional(),
  removed: z
    .record(
      z.string(),
      z.object({ reason: z.string().optional(), migration: z.string().optional(), asserts: z.array(z.string()).optional() }).nullable(),
    )
    .optional(),
  renamed: z.array(z.object({ from: z.string().min(1), to: z.string().min(1) })).optional(),
});
export type SpecBoxDelta = z.infer<typeof specBoxDeltaSchema>;

export function parseDelta(text: string, source: string, truthIds: Set<string>): SpecDelta {
  const raw = YAML.parse(text);
  const parsed = specBoxDeltaSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`${source}: ${issues}`);
  }
  const d = parsed.data;
  const ops: DeltaOp[] = [];
  for (const r of d.renamed ?? []) ops.push({ op: 'rename-requirement', from: r.from, to: r.to });
  for (const [title, info] of Object.entries(d.removed ?? {})) {
    ops.push({ op: 'remove-requirement', requirementTitle: title, ...(info?.reason ? { reason: info.reason } : {}), ...(info?.migration ? { migration: info.migration } : {}), ...(info?.asserts ? { scenarios: info.asserts } : {}) });
  }
  for (const [title, asserts] of Object.entries(d.modified ?? {})) ops.push({ op: 'modify-requirement', requirement: toRequirement(title, asserts) });
  for (const [title, asserts] of Object.entries(d.added ?? {})) ops.push({ op: 'add-requirement', requirement: toRequirement(title, asserts) });
  const delta: SpecDelta = { capabilityId: d.code, isNew: !truthIds.has(d.code), ops, source };
  if (d.feature) delta.title = d.feature;
  if (d.description) delta.purpose = d.description;
  if (d.type) delta.type = d.type;
  if (d.definitions) delta.attributes = d.definitions;
  return delta;
}

export function validateDeltas(truth: Capability[], deltas: SpecDelta[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  const byId = new Map(truth.map((c) => [c.id, c]));
  const seen = new Set<string>();
  for (const delta of deltas) {
    const t = delta.source;
    if (seen.has(delta.capabilityId)) out.push(diag('error', 'DELTA_DUPLICATE', `Дельта для ${delta.capabilityId} встречается дважды`, t));
    seen.add(delta.capabilityId);
    const cap = byId.get(delta.capabilityId);
    if (delta.ops.length === 0 && !delta.isNew) out.push(diag('error', 'DELTA_EMPTY', 'Дельта без операций', t, 'Добавьте added/modified/removed/renamed или удалите файл.'));
    if (!cap) {
      if (!delta.title) out.push(diag('error', 'DELTA_NEW_TITLE', `Новая capability ${delta.capabilityId} без feature (названия)`, t));
      if (!delta.purpose || delta.purpose.length < 20) out.push(diag('warning', 'DELTA_NEW_PURPOSE', 'У новой capability нет description (назначения) или оно короче 20 символов', t));
      for (const op of delta.ops) {
        if (op.op !== 'add-requirement') out.push(diag('error', 'DELTA_NEW_OP', `Для новой capability допустимы только added, найдено ${op.op}`, t));
      }
      if (!delta.ops.some((op) => op.op === 'add-requirement')) out.push(diag('error', 'DELTA_NEW_EMPTY', 'Новая capability без единого требования', t));
    } else {
      const titles = new Set(cap.requirements.map((r) => r.title));
      const renamedTo = new Set<string>();
      const renamedFrom = new Set(delta.ops.filter((op) => op.op === 'rename-requirement').map((op) => (op as { from: string }).from));
      for (const op of delta.ops) {
        switch (op.op) {
          case 'rename-requirement':
            if (!titles.has(op.from)) out.push(diag('error', 'DELTA_RENAME_FROM', `Переименование: группы «${op.from}» нет в истине`, t));
            if (titles.has(op.to)) out.push(diag('error', 'DELTA_RENAME_TO', `Переименование: группа «${op.to}» уже существует`, t));
            renamedTo.add(op.to);
            break;
          case 'remove-requirement':
            if (!titles.has(op.requirementTitle)) out.push(diag('error', 'DELTA_REMOVE_MISSING', `Удаление: группы «${op.requirementTitle}» нет в истине`, t));
            else if (op.scenarios) {
              const existing = new Set(cap.requirements.find((r) => r.title === op.requirementTitle)!.scenarios.map((s) => s.title));
              for (const s of op.scenarios) if (!existing.has(s)) out.push(diag('error', 'DELTA_REMOVE_ASSERT', `Удаление: утверждения «${s}» нет в группе «${op.requirementTitle}»`, t));
            }
            if (!op.reason) out.push(diag('warning', 'DELTA_REMOVE_REASON', `Удаление «${op.requirementTitle}» без reason`, t));
            break;
          case 'modify-requirement':
            if (renamedFrom.has(op.requirement.title)) out.push(diag('error', 'DELTA_MODIFY_RENAMED', `Изменение: группа «${op.requirement.title}» переименована, опишите её в modified под новым названием`, t));
            else if (!titles.has(op.requirement.title) && !renamedTo.has(op.requirement.title)) out.push(diag('error', 'DELTA_MODIFY_MISSING', `Изменение: группы «${op.requirement.title}» нет в истине`, t, 'Для новой группы используйте added.'));
            break;
          case 'add-requirement':
            if (titles.has(op.requirement.title)) out.push(diag('info', 'DELTA_ADD_EXTENDS', `added дополняет существующую группу «${op.requirement.title}»`, t));
            break;
        }
      }
    }
    for (const op of delta.ops) {
      if (op.op === 'add-requirement' || op.op === 'modify-requirement') {
        const set = new Set<string>();
        for (const s of op.requirement.scenarios) {
          if (set.has(s.title)) out.push(diag('warning', 'DELTA_ASSERT_DUPLICATE', `Утверждение повторяется в группе «${op.requirement.title}»: ${s.title}`, t));
          set.add(s.title);
        }
        if (op.requirement.scenarios.length === 0) out.push(diag('error', 'DELTA_GROUP_EMPTY', `Группа «${op.requirement.title}» без утверждений`, t));
      }
    }
  }
  return out;
}

/** Применить дельту к capability (или создать новую). Чистая функция. */
export function applyDelta(cap: Capability | undefined, delta: SpecDelta): Capability {
  const base: Capability = cap
    ? { ...cap, requirements: cap.requirements.map((r) => ({ ...r, scenarios: [...r.scenarios] })) }
    : { id: delta.capabilityId, title: delta.title ?? delta.capabilityId, requirements: [] };
  if (delta.title && !cap) base.title = delta.title;
  if (delta.purpose) base.purpose = delta.purpose;
  if (delta.type) base.type = delta.type;
  if (delta.attributes) base.attributes = { ...(base.attributes ?? {}), ...delta.attributes };
  const find = (title: string) => base.requirements.find((r) => r.title === title);
  for (const op of delta.ops) {
    switch (op.op) {
      case 'rename-requirement': {
        const r = find(op.from);
        if (r) {
          r.title = op.to;
          r.id = slugify(op.to);
        }
        break;
      }
      case 'remove-requirement': {
        const r = find(op.requirementTitle);
        if (!r) break;
        if (op.scenarios) {
          const drop = new Set(op.scenarios);
          r.scenarios = r.scenarios.filter((s) => !drop.has(s.title));
          if (r.scenarios.length === 0) base.requirements = base.requirements.filter((x) => x !== r);
        } else {
          base.requirements = base.requirements.filter((x) => x !== r);
        }
        break;
      }
      case 'modify-requirement': {
        const r = find(op.requirement.title);
        if (r) r.scenarios = op.requirement.scenarios.map((s) => ({ ...s }));
        else base.requirements.push(cloneReq(op.requirement));
        break;
      }
      case 'add-requirement': {
        const r = find(op.requirement.title);
        if (r) {
          const have = new Set(r.scenarios.map((s) => s.title));
          for (const s of op.requirement.scenarios) if (!have.has(s.title)) r.scenarios.push({ ...s });
        } else base.requirements.push(cloneReq(op.requirement));
        break;
      }
    }
  }
  return base;
}

function cloneReq(r: Requirement): Requirement {
  return { ...r, scenarios: r.scenarios.map((s) => ({ ...s })) };
}

export { toScenario };
