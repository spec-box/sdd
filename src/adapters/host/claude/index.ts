import path from 'node:path';
import { loadRoleText } from '../../../core/roles.js';
import { ROLES, type Role } from '../../../core/phases.js';
import { defaultHostModel } from '../../../core/runner.js';
import { loadSkills, skillsForRole } from '../../../core/skills.js';
import { writeText } from '../../../core/paths.js';
import type { Config } from '../../../core/config.js';
import { installSkills } from '../skills.js';

const AGENT_ROLES: Role[] = ['researcher', 'planner', 'tester', 'implementer', 'reviewer', 'verifier', 'challenger'];

const TOOLS: Record<Role, string> = {
  researcher: 'Read, Grep, Glob, Bash',
  planner: 'Read, Write, Edit, Grep, Glob, Bash',
  challenger: 'Read, Grep, Glob, Bash',
  tester: 'Read, Write, Edit, Grep, Glob, Bash',
  implementer: 'Read, Write, Edit, Grep, Glob, Bash',
  reviewer: 'Read, Grep, Glob, Bash',
  verifier: 'Read, Grep, Glob, Bash',
  distiller: 'Read, Write, Edit, Grep, Glob',
};

const DESCRIPTIONS: Record<Role, string> = {
  researcher: 'Исследователь @spec-box/sdd: Evidence Pack по изменению. Вызывается только скиллом sbox-run.',
  planner: 'Планировщик @spec-box/sdd: proposal, дельты спецификаций, design, tasks. Вызывается только скиллом sbox-run.',
  challenger: 'Аудитор плана @spec-box/sdd. Вызывается только скиллом sbox-run.',
  tester: 'Тестировщик @spec-box/sdd: тесты по сценариям до реализации. Вызывается только скиллом sbox-run.',
  implementer: 'Реализатор @spec-box/sdd: выполняет tasks.md, не трогая защищённые тесты. Вызывается только скиллом sbox-run.',
  reviewer: 'Ревьюер @spec-box/sdd: тесты против спецификаций, код против артефактов. Вызывается только скиллом sbox-run.',
  verifier: 'Верификатор @spec-box/sdd: полнота, корректность, согласованность. Вызывается только скиллом sbox-run.',
  distiller: 'Дистиллятор знаний @spec-box/sdd.',
};

/** Агенты Claude Code по одному на роль; скиллы из metadata.roles подключаются полем skills (субагенты не видят скиллы проекта сами). */
export function installClaudeAgents(root: string, config?: Config): string[] {
  const written: string[] = [];
  const skills = loadSkills(root);
  for (const role of ROLES) {
    if (!AGENT_ROLES.includes(role)) continue;
    const file = path.join(root, '.claude', 'agents', `sbox-${role}.md`);
    writeText(file, agentFile(root, role, config?.runner.models[role], config?.runner.efforts[role] ?? config?.runner.defaultEffort ?? 'medium', skillsForRole(skills, role)));
    written.push(file);
  }
  return written;
}

/** Полный набор материалов Claude Code: скиллы из единого источника и агенты. */
export function installClaudeMaterials(root: string, config?: Config): string[] {
  return [...installSkills(root, 'claude'), ...installClaudeAgents(root, config)];
}

/** Имя модели для фронтматтера агента Claude Code: псевдонимы sonnet/opus/haiku или полный идентификатор. */
function agentModel(configured: string | undefined): string | null {
  if (!configured) return null;
  const v = configured.toLowerCase();
  if (v.includes('opus')) return 'opus';
  if (v.includes('sonnet')) return 'sonnet';
  if (v.includes('haiku')) return 'haiku';
  return configured;
}

function agentFile(root: string, role: Role, configuredModel?: string, effort = 'medium', skills: string[] = []): string {
  const body = loadRoleText(root, role);
  const model = agentModel(configuredModel) ?? defaultHostModel(role);
  const skillsBlock = skills.length ? `skills:\n${skills.map((s) => `  - ${s}`).join('\n')}\n` : '';
  // Без явного effort субагент наследует усилие сессии (в пилоте это был xhigh на каждом ходе).
  return `---
name: sbox-${role}
description: ${DESCRIPTIONS[role]}
tools: ${TOOLS[role]}
model: ${model}
effort: ${effort}
${skillsBlock}---

Ты выполняешь роль ${role} инструмента @spec-box/sdd. Во входном сообщении путь к JSON-пакету (\`packet\`). Прочитай пакет целиком: там цель, допущенные файлы, ограничения, правила проекта, инструкции к артефактам и путь \`resultFile\`.

Порядок работы: прочитай пакет → выполни этапы роли ниже → запиши полный ответ (Markdown и завершающий блок \`# sbox-result\`) в файл \`resultFile\` из пакета → в сообщении верни только две строки: путь к resultFile и статус.

${body.trim()}
`;
}
