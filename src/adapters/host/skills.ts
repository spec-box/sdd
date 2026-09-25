import path from 'node:path';
import { loadSkills, type SkillDefinition } from '../../core/skills.js';
import { writeText } from '../../core/paths.js';

export const HOST_TARGETS = ['claude', 'codex'] as const;
export type HostTarget = (typeof HOST_TARGETS)[number];

export function isHostTarget(value: string): value is HostTarget {
  return (HOST_TARGETS as readonly string[]).includes(value);
}

/**
 * Где хост читает скиллы проекта. Claude Code: .claude/skills/<имя>/SKILL.md.
 * Codex: .agents/skills/<имя>/SKILL.md (Agent Skills; пользовательские ~/.agents/skills и ~/.codex/skills инструмент не трогает).
 */
export const SKILL_LAYOUT: Record<HostTarget, (name: string) => string> = {
  claude: (name) => path.join('.claude', 'skills', name, 'SKILL.md'),
  codex: (name) => path.join('.agents', 'skills', name, 'SKILL.md'),
};

/** Копирует скиллы из единого источника (assets/skills и .sbox/skills) в раскладку хоста без изменений текста. */
export function installSkills(root: string, target: HostTarget, skills: SkillDefinition[] = loadSkills(root)): string[] {
  const written: string[] = [];
  for (const skill of skills) {
    const file = path.join(root, SKILL_LAYOUT[target](skill.name));
    writeText(file, skill.text);
    written.push(file);
  }
  return written;
}
