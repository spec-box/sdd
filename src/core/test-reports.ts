import fs from 'node:fs';
import path from 'node:path';
import { SboxError } from './errors.js';

/** Тест из отчёта: полное имя (describe › it) и статус. Адаптеры повторяют ключи spec-box. */
export interface TestCase {
  fullName: string;
  titles: string[];
  status: 'passed' | 'failed' | 'skipped' | 'pending';
  file?: string;
}

export interface TestReportAdapter {
  readonly name: string;
  read(file: string): TestCase[];
}

/** Jest и Vitest (`--reporter=json`): testResults[].assertionResults[] с ancestorTitles и title. */
export const jestReport: TestReportAdapter = {
  name: 'jest',
  read(file) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { testResults?: { name?: string; assertionResults?: { ancestorTitles?: string[]; title: string; fullName?: string; status: string }[] }[] };
    const out: TestCase[] = [];
    for (const suite of raw.testResults ?? []) {
      for (const a of suite.assertionResults ?? []) {
        const titles = [...(a.ancestorTitles ?? []), a.title];
        out.push({ fullName: a.fullName ?? titles.join(' '), titles, status: normalize(a.status), file: suite.name });
      }
    }
    return out;
  },
};

/** Playwright JSON reporter: suites[] с вложенными suites и specs[].tests[].results[]. */
export const playwrightReport: TestReportAdapter = {
  name: 'playwright',
  read(file) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { suites?: PwSuite[] };
    const out: TestCase[] = [];
    const walk = (suite: PwSuite, ancestors: string[]) => {
      const here = suite.title && !/\.(spec|test)\.[jt]sx?$/.test(suite.title) ? [...ancestors, suite.title] : ancestors;
      for (const spec of suite.specs ?? []) {
        const titles = [...here, spec.title];
        const results = spec.tests?.flatMap((t) => t.results ?? []) ?? [];
        const statuses = results.map((r) => r.status);
        const status: TestCase['status'] = statuses.includes('failed') || statuses.includes('timedOut') ? 'failed' : statuses.includes('passed') ? 'passed' : statuses.includes('skipped') ? 'skipped' : 'pending';
        out.push({ fullName: titles.join(' › '), titles, status, file: spec.file });
      }
      for (const child of suite.suites ?? []) walk(child, here);
    };
    for (const s of raw.suites ?? []) walk(s, []);
    return out;
  },
};

interface PwSuite {
  title?: string;
  file?: string;
  suites?: PwSuite[];
  specs?: { title: string; file?: string; tests?: { results?: { status: string }[] }[] }[];
}

function normalize(status: string): TestCase['status'] {
  if (status === 'passed') return 'passed';
  if (status === 'failed') return 'failed';
  if (status === 'skipped' || status === 'todo' || status === 'disabled') return 'skipped';
  return 'pending';
}

const ADAPTERS: Record<string, TestReportAdapter> = { jest: jestReport, vitest: jestReport, playwright: playwrightReport };

export function readTestReport(kind: string, file: string): TestCase[] {
  const adapter = ADAPTERS[kind];
  if (!adapter) throw new SboxError('REPORT_KIND', `Неизвестный формат отчёта ${kind}; доступны: ${Object.keys(ADAPTERS).join(', ')}`);
  if (!fs.existsSync(file)) throw new SboxError('REPORT_MISSING', `Нет файла отчёта ${path.resolve(file)}`);
  return adapter.read(file);
}
