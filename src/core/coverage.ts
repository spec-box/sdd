import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { SboxError } from './errors.js';
import type { SpecDelta } from './spec-model.js';
import type { TestCase } from './test-reports.js';

/**
 * coverage.yaml: capability → группа → утверждение → tests[] | manual.
 * Сопоставление с отчётом повторяет ключи spec-box: название фичи › группы › утверждения.
 */
const testRefSchema = z.object({ level: z.string().optional(), file: z.string().optional(), name: z.string().min(1) });
const entrySchema = z.union([z.object({ tests: z.array(testRefSchema).min(1) }), z.object({ manual: z.string().min(1) })]);
export const coverageSchema = z.record(z.string(), z.record(z.string(), z.record(z.string(), entrySchema)));
export type Coverage = z.infer<typeof coverageSchema>;

export function readCoverage(dir: string): Coverage {
  const file = path.join(dir, 'coverage.yaml');
  if (!fs.existsSync(file)) throw new SboxError('NO_COVERAGE', `Нет файла ${file}`);
  const raw = YAML.parse(fs.readFileSync(file, 'utf8')) ?? {};
  const parsed = coverageSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new SboxError('BAD_COVERAGE', `coverage.yaml не соответствует контракту: ${issues}`);
  }
  return parsed.data;
}

export interface CoverageRow {
  capability: string;
  requirement: string;
  scenario: string;
  kind: 'automated' | 'manual';
  tests: { name: string; level?: string; file?: string; status: 'passed' | 'failed' | 'skipped' | 'pending' | 'missing' }[];
  manual?: string;
  state: 'green' | 'red' | 'missing' | 'manual' | 'unlisted';
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Состояние каждого утверждения из дельт: покрыто зелёным тестом, падает, теста нет в отчёте, ручное, не описано в coverage. */
export function matchCoverage(coverage: Coverage, deltas: SpecDelta[], report: TestCase[] | null): CoverageRow[] {
  const byName = new Map<string, TestCase>();
  for (const t of report ?? []) {
    byName.set(norm(t.fullName), t);
    byName.set(norm(t.titles.join(' › ')), t);
    byName.set(norm(t.titles.join(' ')), t);
  }
  const rows: CoverageRow[] = [];
  for (const delta of deltas) {
    const cap = coverage[delta.capabilityId] ?? {};
    for (const op of delta.ops) {
      if (op.op !== 'add-requirement' && op.op !== 'modify-requirement') continue;
      const group = cap[op.requirement.title] ?? {};
      for (const s of op.requirement.scenarios) {
        const entry = group[s.title];
        if (!entry) {
          rows.push({ capability: delta.capabilityId, requirement: op.requirement.title, scenario: s.title, kind: 'automated', tests: [], state: 'unlisted' });
          continue;
        }
        if ('manual' in entry) {
          rows.push({ capability: delta.capabilityId, requirement: op.requirement.title, scenario: s.title, kind: 'manual', tests: [], manual: entry.manual, state: 'manual' });
          continue;
        }
        const tests: CoverageRow['tests'] = entry.tests.map((t) => {
          const found = report ? byName.get(norm(t.name)) : undefined;
          const status: CoverageRow['tests'][number]['status'] = report ? (found?.status ?? 'missing') : 'pending';
          return { name: t.name, ...(t.level ? { level: t.level } : {}), ...(t.file ? { file: t.file } : {}), status };
        });
        const state: CoverageRow['state'] = !report ? 'missing' : tests.every((t) => t.status === 'passed') ? 'green' : tests.some((t) => t.status === 'failed') ? 'red' : 'missing';
        rows.push({ capability: delta.capabilityId, requirement: op.requirement.title, scenario: s.title, kind: 'automated', tests, state });
      }
    }
  }
  return rows;
}

export function coverageSummary(rows: CoverageRow[]): Record<CoverageRow['state'], number> {
  const out: Record<CoverageRow['state'], number> = { green: 0, red: 0, missing: 0, manual: 0, unlisted: 0 };
  for (const r of rows) out[r.state] += 1;
  return out;
}
