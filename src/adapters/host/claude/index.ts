import { resolveModel, MODEL_PROFILES, claudeAgentName, type ModelProfile } from '../../../core/model-policy.js';
import path from 'node:path';
import { loadRoleDescription, loadRoleText } from '../../../core/roles.js';
import { ROLES, type Role } from '../../../core/phases.js';
import { READ_ONLY_ROLES } from '../../../core/runner.js';
import { loadSkills, skillsForRole, type SkillDefinition } from '../../../core/skills.js';
import { assetsDir, readText, writeText } from '../../../core/paths.js';
import { configSchema, type Config } from '../../../core/config.js';

const AGENT_ROLES: Role[] = ['researcher', 'planner', 'tester', 'implementer', 'reviewer', 'verifier', 'challenger'];

/**
 * Агенты Claude Code: базовое имя роли и варианты для каждого профиля. Текст агента это шаблон assets/hosts/claude/agent.md с данными роли:
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
    for (const profile of MODEL_PROFILES) {
      const variant = path.join(root, '.claude', 'agents', `${claudeAgentName(role, profile)}.md`);
      writeText(variant, agentFile(template, root, role, cfg, skillsForRole(skills, role), profile));
      written.push(variant);
    }
  }
  return written;
}

function agentFile(template: string, root: string, role: Role, config: Config, skills: string[], profile?: ModelProfile): string {
  const execution = resolveModel(config, 'claude', role, undefined, profile);
  const tools = (READ_ONLY_ROLES.has(role) ? config.runner.claude.readOnlyTools : config.runner.claude.allowedTools).join(', ');
  const values: Record<string, string> = {
    role,
    name: profile ? claudeAgentName(role, profile) : `sbox-${role}`,
    description: JSON.stringify(loadRoleDescription(root, role)),
    tools,
    model: JSON.stringify(execution.model),
    effort: execution.effort,
    skills: skills.length ? `skills:\n${skills.map((s) => `  - ${s}`).join('\n')}\n` : '',
    body: loadRoleText(root, role).trim(),
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? '');
}
