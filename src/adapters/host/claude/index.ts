import path from 'node:path';
import { loadRoleDescription, loadRoleText } from '../../../core/roles.js';
import { ROLES, type Role } from '../../../core/phases.js';
import { defaultHostModel, READ_ONLY_ROLES } from '../../../core/runner.js';
import { loadSkills, skillsForRole, type SkillDefinition } from '../../../core/skills.js';
import { assetsDir, readText, writeText } from '../../../core/paths.js';
import { configSchema, type Config } from '../../../core/config.js';

const AGENT_ROLES: Role[] = ['researcher', 'planner', 'tester', 'implementer', 'reviewer', 'verifier', 'challenger'];

/**
 * Агенты Claude Code по одному на роль. Текст агента это шаблон assets/hosts/claude/agent.md с данными роли:
 * описание из фронтматтера файла роли, инструменты из runner.claude конфига (как в headless-режиме),
 * скиллы из metadata.roles полем skills (субагенты не видят скиллы проекта сами).
 */
export function installClaudeAgents(root: string, config?: Config, skills: SkillDefinition[] = loadSkills(root)): string[] {
  const written: string[] = [];
  const cfg = config ?? configSchema.parse({ version: 1, spec: { adapter: 'spec-box' } });
  const template = readText(path.join(assetsDir(), 'hosts', 'claude', 'agent.md'));
  for (const role of ROLES) {
    if (!AGENT_ROLES.includes(role)) continue;
    const file = path.join(root, '.claude', 'agents', `sbox-${role}.md`);
    writeText(file, agentFile(template, root, role, cfg, skillsForRole(skills, role)));
    written.push(file);
  }
  return written;
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

function agentFile(template: string, root: string, role: Role, config: Config, skills: string[]): string {
  const tools = (READ_ONLY_ROLES.has(role) ? config.runner.claude.readOnlyTools : config.runner.claude.allowedTools).join(', ');
  const values: Record<string, string> = {
    role,
    description: JSON.stringify(loadRoleDescription(root, role)),
    tools,
    model: agentModel(config.runner.models[role]) ?? defaultHostModel(role),
    // Без явного effort субагент наследует усилие сессии (в пилоте это был xhigh на каждом ходе).
    effort: config.runner.efforts[role] ?? config.runner.defaultEffort,
    skills: skills.length ? `skills:\n${skills.map((s) => `  - ${s}`).join('\n')}\n` : '',
    body: loadRoleText(root, role).trim(),
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? '');
}
