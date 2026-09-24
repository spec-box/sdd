import YAML from 'yaml';
import { z } from 'zod';
import { slugify, type Capability, type Requirement, type Scenario } from '../../../core/spec-model.js';

/** Формат файла spec-box (см. README @spec-box/sync). */
const assertSchema = z.object({ assert: z.string().min(1), description: z.string().optional() });
export const specBoxFileSchema = z.object({
  feature: z.string().min(1),
  code: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'code: только латиница, цифры, - и _, начинается с буквы'),
  description: z.string().optional(),
  type: z.enum(['Functional', 'Visual']).optional(),
  'specs-unit': z.record(z.string(), z.array(assertSchema)).optional(),
  definitions: z.record(z.string(), z.array(z.string())).optional(),
});
export type SpecBoxFile = z.infer<typeof specBoxFileSchema>;
export type SpecBoxAssert = z.infer<typeof assertSchema>;

export function toScenario(a: SpecBoxAssert): Scenario {
  const s: Scenario = { id: slugify(a.assert), title: a.assert };
  if (a.description) s.description = a.description;
  return s;
}

export function toRequirement(title: string, asserts: SpecBoxAssert[]): Requirement {
  return { id: slugify(title), title, scenarios: asserts.map(toScenario) };
}

export function parseSpecBoxFile(text: string, source: string): Capability {
  const raw = YAML.parse(text);
  const parsed = specBoxFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`${source}: ${issues}`);
  }
  const f = parsed.data;
  const cap: Capability = {
    id: f.code,
    title: f.feature,
    requirements: Object.entries(f['specs-unit'] ?? {}).map(([title, asserts]) => toRequirement(title, asserts)),
    source,
  };
  if (f.description) cap.purpose = f.description;
  if (f.type) cap.type = f.type;
  if (f.definitions) cap.attributes = f.definitions;
  return cap;
}

export function toSpecBoxFile(cap: Capability): SpecBoxFile {
  const file: SpecBoxFile = { feature: cap.title, code: cap.id };
  if (cap.purpose) file.description = cap.purpose;
  if (cap.type === 'Functional' || cap.type === 'Visual') file.type = cap.type;
  const units: Record<string, SpecBoxAssert[]> = {};
  for (const r of cap.requirements) {
    units[r.title] = r.scenarios.map((s) => (s.description ? { assert: s.title, description: s.description } : { assert: s.title }));
  }
  file['specs-unit'] = units;
  if (cap.attributes && Object.keys(cap.attributes).length > 0) file.definitions = cap.attributes;
  return file;
}

/** Порядок ключей фиксирован, чтобы диф истины в пул-реквесте был читаемым. */
export function serializeSpecBox(cap: Capability): string {
  const f = toSpecBoxFile(cap);
  const ordered: Record<string, unknown> = { feature: f.feature };
  if (f.description) ordered.description = f.description;
  ordered.code = f.code;
  if (f.type) ordered.type = f.type;
  ordered['specs-unit'] = f['specs-unit'];
  if (f.definitions) ordered.definitions = f.definitions;
  return YAML.stringify(ordered, { lineWidth: 0 });
}
