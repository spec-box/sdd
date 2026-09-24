import fs from 'node:fs';
import path from 'node:path';
import { archiveDir, loadChange, type Change } from './change.js';
import { exists, readText } from './paths.js';
import type { Config } from './config.js';

/**
 * Метрики работы решателя по одному изменению: время агентов и ожидания человека,
 * запуски и стоимость, возвраты и вмешательства, оценка результата человеком.
 * Считаются из change.yaml и receipt.json, ничего не хранится отдельно.
 */
export interface PhaseMetrics {
  runs: number;
  agent_minutes: number;
  returns: number;
  rejections: number;
}

export interface ChangeMetrics {
  id: string;
  title: string;
  status: string;
  phase: string;
  size: string;
  autonomy: string;
  created: string;
  finished: string | null;
  wall_hours: number | null;
  runs: number;
  agent_minutes: number;
  cost_usd: number | null;
  phases: Record<string, PhaseMetrics>;
  gates: Record<string, { state: string; wait_minutes: number | null; rejected_times: number }>;
  interventions: { gate_rejections: number; resumes: number; user_blockers: number; report_rejections: number; total: number };
  autonomous: boolean;
  rating: { score: number; comment?: string; at: string } | null;
}

interface Receipt {
  id: string;
  role: string;
  phase: string;
  started: string | null;
  finished: string | null;
  cost_usd: number | null;
  status: string;
}

function minutes(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms / 60_000 : null;
}

function readReceipts(dir: string): Receipt[] {
  const runs = path.join(dir, 'runs');
  if (!exists(runs)) return [];
  return fs
    .readdirSync(runs, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const rdir = path.join(runs, e.name);
      const receiptFile = path.join(rdir, 'receipt.json');
      const packetFile = path.join(rdir, 'packet.json');
      const resultFile = path.join(rdir, 'result.md');
      const receipt = exists(receiptFile) ? (JSON.parse(readText(receiptFile)) as Partial<Receipt>) : {};
      // В интерактивном режиме время старта это момент выдачи пакета, окончания это момент записи ответа.
      const started = receipt.started ?? (exists(packetFile) ? fs.statSync(packetFile).mtime.toISOString() : null);
      const finished = receipt.finished ?? (exists(resultFile) ? fs.statSync(resultFile).mtime.toISOString() : null);
      return { id: e.name, role: receipt.role ?? '', phase: receipt.phase ?? '', started, finished, cost_usd: receipt.cost_usd ?? null, status: receipt.status ?? 'done' };
    })
    .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
}

export function changeMetrics(dir: string, change: Change): ChangeMetrics {
  const receipts = readReceipts(dir);
  const phases: Record<string, PhaseMetrics> = {};
  let agentMinutes = 0;
  let cost = 0;
  let hasCost = false;
  for (const r of receipts) {
    const p = (phases[r.phase] ??= { runs: 0, agent_minutes: 0, returns: 0, rejections: 0 });
    p.runs += 1;
    const m = minutes(r.started, r.finished) ?? 0;
    p.agent_minutes += m;
    agentMinutes += m;
    if (r.cost_usd !== null) {
      cost += r.cost_usd;
      hasCost = true;
    }
  }
  for (const [key, n] of Object.entries(change.returns)) {
    if (key.endsWith(':rejections')) (phases[key.replace(':rejections', '')] ??= { runs: 0, agent_minutes: 0, returns: 0, rejections: 0 }).rejections = n;
    else (phases[key] ??= { runs: 0, agent_minutes: 0, returns: 0, rejections: 0 }).returns = n;
  }
  const gates: ChangeMetrics['gates'] = {};
  let gateRejections = 0;
  for (const [gate, g] of Object.entries(change.gates)) {
    // Ожидание человека: от последнего запуска фазы перед гейтом до решения.
    const phaseOfGate = gate === 'proposal' ? 'propose' : gate === 'plan' ? 'plan' : 'tests_review';
    const lastRun = [...receipts].reverse().find((r) => r.phase === phaseOfGate);
    const wait = g.at ? minutes(lastRun?.finished ?? null, g.at) : null;
    gates[gate] = { state: g.state, wait_minutes: wait, rejected_times: g.rejected_times ?? 0 };
    gateRejections += g.rejected_times ?? 0;
  }
  const resumes = change.interventions?.resumes ?? 0;
  const userBlockers = change.interventions?.user_blockers ?? 0;
  const reportRejections = Object.values(phases).reduce((n, p) => n + p.rejections, 0);
  const total = gateRejections + resumes + userBlockers + reportRejections;
  const finished = change.status === 'done' || change.status === 'archived' ? (receipts.at(-1)?.finished ?? null) : null;
  return {
    id: change.id,
    title: change.title,
    status: change.status,
    phase: change.phase,
    size: change.size,
    autonomy: change.autonomy ?? 'по конфигу',
    created: change.created,
    finished,
    wall_hours: finished ? (minutes(`${change.created}T00:00:00Z`, finished) ?? 0) / 60 : null,
    runs: receipts.length,
    agent_minutes: Math.round(agentMinutes * 10) / 10,
    cost_usd: hasCost ? Math.round(cost * 100) / 100 : null,
    phases,
    gates,
    interventions: { gate_rejections: gateRejections, resumes, user_blockers: userBlockers, report_rejections: reportRejections, total },
    autonomous: total === 0,
    rating: change.rating ?? null,
  };
}

/** Все изменения проекта: активные и архивные. */
export function allChangeDirs(root: string, config: Config): string[] {
  const base = path.join(root, config.changes.dir);
  const out: string[] = [];
  if (exists(base)) {
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== 'archive' && exists(path.join(base, e.name, 'change.yaml'))) out.push(path.join(base, e.name));
    }
  }
  const archive = archiveDir(root, config);
  if (exists(archive)) {
    for (const e of fs.readdirSync(archive, { withFileTypes: true })) {
      if (e.isDirectory() && exists(path.join(archive, e.name, 'change.yaml'))) out.push(path.join(archive, e.name));
    }
  }
  return out;
}

export function findChangeDir(root: string, config: Config, id: string): string | null {
  return allChangeDirs(root, config).find((d) => {
    try {
      return loadChange(d).id === id;
    } catch {
      return false;
    }
  }) ?? null;
}

export interface MetricsSummary {
  changes: number;
  finished: number;
  autonomous_share: number | null;
  median_agent_minutes: number | null;
  median_runs: number | null;
  total_cost_usd: number | null;
  mean_rating: number | null;
  interventions_per_change: number | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function summarize(all: ChangeMetrics[]): MetricsSummary {
  const finished = all.filter((m) => m.finished);
  const costs = all.filter((m) => m.cost_usd !== null).map((m) => m.cost_usd!);
  const ratings = all.filter((m) => m.rating).map((m) => m.rating!.score);
  return {
    changes: all.length,
    finished: finished.length,
    autonomous_share: finished.length ? Math.round((finished.filter((m) => m.autonomous).length / finished.length) * 100) / 100 : null,
    median_agent_minutes: median(all.map((m) => m.agent_minutes)),
    median_runs: median(all.map((m) => m.runs)),
    total_cost_usd: costs.length ? Math.round(costs.reduce((a, b) => a + b, 0) * 100) / 100 : null,
    mean_rating: ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : null,
    interventions_per_change: all.length ? Math.round((all.reduce((n, m) => n + m.interventions.total, 0) / all.length) * 10) / 10 : null,
  };
}
