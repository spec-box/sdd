import path from 'node:path';
import { loadChange, saveChange, type Change } from './change.js';
import { approveGate, nextStep, rejectGate } from './phases.js';
import { artifactStates, loadWorkflow } from './schema.js';
import { toPosix } from './paths.js';
import type { Config, Gate } from './config.js';
import type { RepoHost, PullRequestRef } from './repo-host.js';

/**
 * Канал гейтов через комментарии пул-реквеста (docs/design.md, «Гейты, профили и каналы»):
 * CLI публикует вопрос комментарием и читает ответы вида `/sbox approve <gate>` и `/sbox reject <gate> <текст>`.
 */
export interface GateCommand {
  action: 'approve' | 'reject';
  gate: Gate;
  comment?: string;
  answers?: Record<string, string>;
  author: string;
  at: string;
}

const COMMAND_RE = /^\s*\/sbox\s+(approve|reject)\s+(proposal|plan|tests)\b\s*([\s\S]*)$/im;

export function parseGateCommand(body: string, author: string, at: string): GateCommand | null {
  const m = body.match(COMMAND_RE);
  if (!m) return null;
  const action = m[1]!.toLowerCase() as 'approve' | 'reject';
  const gate = m[2]!.toLowerCase() as Gate;
  const rest = (m[3] ?? '').trim();
  const answers: Record<string, string> = {};
  const comment = rest
    .split(/\s+/)
    .filter((tok) => {
      const a = tok.match(/^(Q\d+)=(.+)$/i);
      if (a) {
        answers[a[1]!.toUpperCase()] = a[2]!;
        return false;
      }
      return true;
    })
    .join(' ')
    .trim();
  return { action, gate, ...(comment ? { comment } : {}), ...(Object.keys(answers).length ? { answers } : {}), author, at };
}

export function gateQuestion(root: string, dir: string, change: Change, gate: Gate): string {
  const states = artifactStates(loadWorkflow(root), change, dir);
  const files = states.filter((s) => s.existing.length > 0).flatMap((s) => s.existing.map((f) => `- \`${toPosix(path.relative(root, f))}\``));
  const what = gate === 'proposal' ? 'предложение' : gate === 'plan' ? 'план: дизайн, дельты спецификаций и задачи' : 'тесты и план тестирования';
  return [
    `### sbox: гейт \`${gate}\``,
    '',
    `Нужно решение человека по изменению \`${change.id}\` (${change.title}): ${what}.`,
    '',
    'Посмотрите:',
    ...files,
    '',
    `Утвердить: \`/sbox approve ${gate}\` (ответы на вопросы: \`/sbox approve ${gate} Q1=B Q2=A\`)`,
    `Отклонить: \`/sbox reject ${gate} <замечание>\``,
  ].join('\n');
}

export interface PollOutcome {
  posted: boolean;
  applied: GateCommand | null;
}

/** Опубликовать вопрос гейта в пул-реквесте (один раз) и применить первую найденную команду. */
export async function pollPullRequestGate(root: string, config: Config, dir: string, host: RepoHost, pr: PullRequestRef): Promise<PollOutcome> {
  let change = loadChange(dir);
  const step = nextStep(change, config);
  if (step.kind !== 'gate') return { posted: false, applied: null };
  const gate = step.gate;
  const state = change.gates[gate]!;
  let posted = false;
  if (!state.posted_at) {
    await host.postComment(pr, gateQuestion(root, dir, change, gate));
    change.gates[gate] = { ...state, posted_at: new Date().toISOString() };
    saveChange(dir, change);
    posted = true;
    change = loadChange(dir);
  }
  const since = change.gates[gate]!.posted_at;
  const comments = await host.readComments(pr, since);
  for (const c of comments) {
    const cmd = parseGateCommand(c.body, c.author, c.createdAt);
    if (!cmd || cmd.gate !== gate) continue;
    if (cmd.action === 'approve') approveGate(change, gate, cmd.author, cmd.comment, cmd.answers);
    else rejectGate(change, gate, cmd.author, cmd.comment ?? 'отклонено без комментария');
    saveChange(dir, change);
    return { posted, applied: cmd };
  }
  return { posted, applied: null };
}
