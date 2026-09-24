import path from 'node:path';
import type { Change } from './change.js';
import type { RoleResult } from './result.js';
import type { SpecDelta } from './spec-model.js';
import { exists, readText } from './paths.js';

export interface DodItem {
  id: number;
  text: string;
  ok: boolean;
  detail?: string;
}

/**
 * Текст пул-реквеста собирается только из delivery_narrative ревьюера, отчёта верификатора,
 * сводки дельт и чеклиста готовности (docs/design.md, «Правила ревьюера»).
 */
export function renderPullRequestBody(input: {
  change: Change;
  dir: string;
  narrative: NonNullable<RoleResult['delivery_narrative']>;
  deltas: SpecDelta[];
  dod: DodItem[];
}): string {
  const { change, narrative, deltas, dod } = input;
  const lines: string[] = [];
  lines.push(`## ${narrative.title}`, '');
  lines.push(narrative.delta, '');
  lines.push('### Почему это работает', '', narrative.why, '');
  if (narrative.preserved) lines.push('### Что сохранено', '', narrative.preserved, '');
  if (narrative.rollout || narrative.rollback) {
    lines.push('### Выкатка и откат', '');
    if (narrative.rollout) lines.push(`- Выкатка: ${narrative.rollout}`);
    if (narrative.rollback) lines.push(`- Откат: ${narrative.rollback}`);
    lines.push('');
  }
  if (deltas.length > 0) {
    lines.push('### Спецификации', '');
    for (const d of deltas) {
      const ops = d.ops.map((op) => (op.op === 'add-requirement' ? `+ ${op.requirement.title}` : op.op === 'modify-requirement' ? `~ ${op.requirement.title}` : op.op === 'remove-requirement' ? `- ${op.requirementTitle}` : `→ ${op.from} ⇒ ${op.to}`));
      lines.push(`- \`${d.capabilityId}\`${d.isNew ? ' (новая)' : ''}: ${ops.join('; ')}`);
    }
    lines.push('');
  }
  if (change.verification) {
    const v = change.verification;
    const counts = { PASS: 0, FAIL: 0, PARTIAL: 0, NOT_RUN: 0 };
    for (const c of v.checks) counts[c.result] += 1;
    lines.push('### Верификация', '', `Проверок: ${v.checks.length} (PASS ${counts.PASS}, PARTIAL ${counts.PARTIAL}, NOT_RUN ${counts.NOT_RUN}).`);
    for (const c of v.checks) lines.push(`- ${c.id} ${c.result}${c.purpose ? ` — ${c.purpose}` : ''}${c.evidence ? `: ${c.evidence}` : ''}`);
    if (change.accepted_gaps.length > 0) {
      lines.push('', 'Принятые пробелы (ручная или CI-проверка):');
      for (const g of change.accepted_gaps) {
        const gap = v.gaps.find((x) => x.id === g.item);
        lines.push(`- ${g.item}${gap?.environment ? ` (${gap.environment})` : ''}${g.reason ? `: ${g.reason}` : ''}`);
      }
    }
    lines.push('');
  }
  if (change.changeset?.rebound.length) {
    lines.push('### После ревью', '', 'Изменялись только файлы вне кода, вердикты verify и review сохранены:');
    for (const r of change.changeset.rebound) lines.push(`- ${r.files.join(', ')} (${r.at.slice(0, 16).replace('T', ' ')})`);
    lines.push('');
  }
  const testPlan = path.join(input.dir, 'test-plan.md');
  if (exists(testPlan)) {
    lines.push('### План ручного тестирования', '', readText(testPlan).trim(), '');
  }
  lines.push('### Готовность к влитию', '');
  for (const item of dod) lines.push(`- [${item.ok ? 'x' : ' '}] ${item.id}. ${item.text}${item.detail ? ` (${item.detail})` : ''}`);
  lines.push('', `<sub>sbox: изменение \`${change.id}\`, change-set \`${change.changeset?.digest ?? '—'}\`</sub>`);
  return lines.join('\n');
}
