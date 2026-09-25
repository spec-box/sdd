import path from 'node:path';
import { loadSkills, skillsForHost, type SkillDefinition } from '../../core/skills.js';
import { writeText } from '../../core/paths.js';

/**
 * Где хост читает скиллы проекта. Claude Code: .claude/skills/<имя>/SKILL.md.
 * Codex: .agents/skills/<имя>/SKILL.md (Agent Skills; пользовательские ~/.agents/skills и ~/.codex/skills инструмент не трогает).
 * Новый хост это новая строка здесь.
 */
export const SKILL_LAYOUT = {
  claude: (name: string) => path.join('.claude', 'skills', name, 'SKILL.md'),
  codex: (name: string) => path.join('.agents', 'skills', name, 'SKILL.md'),
} as const;

export type HostTarget = keyof typeof SKILL_LAYOUT;

export const HOST_TARGETS = Object.keys(SKILL_LAYOUT) as HostTarget[];

export function isHostTarget(value: string): value is HostTarget {
  return Object.hasOwn(SKILL_LAYOUT, value);
}

/** Копирует скиллы из единого источника (assets/skills и .sbox/skills), применимые к хосту, в его раскладку без изменений текста. */
export function installSkills(root: string, target: HostTarget, skills: SkillDefinition[] = loadSkills(root)): string[] {
  const written: string[] = [];
  for (const skill of skillsForHost(skills, target)) {
    const file = path.join(root, SKILL_LAYOUT[target](skill.name));
    writeText(file, skill.text);
    written.push(file);
  }
  return written;
}
