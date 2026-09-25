import { SboxError } from '../../core/errors.js';
import type { Config } from '../../core/config.js';
import { loadSkills } from '../../core/skills.js';
import { installClaudeAgents } from './claude/index.js';
import { HOST_TARGETS, installSkills, isHostTarget, type HostTarget } from './skills.js';

export interface HostInstallResult {
  target: HostTarget;
  files: string[];
  notes: string[];
  /** Что делать дальше на этом хосте: одна строка для init и host install. */
  next: string;
}

/** Материалы хоста: скиллы из единого источника для любого хоста плюс агенты, если адаптер хоста их умеет. */
export function installHostMaterials(root: string, target: string, config?: Config): HostInstallResult {
  if (!isHostTarget(target)) throw new SboxError('HOST_UNKNOWN', `Неизвестный хост ${target}; доступны ${HOST_TARGETS.join(' и ')}.`);
  const skills = loadSkills(root);
  const files = installSkills(root, target, skills);
  const notes: string[] = [];
  let next: string;
  switch (target) {
    case 'claude':
      files.push(...installClaudeAgents(root, config, skills));
      next = 'В Claude Code: `/sbox-run` после `sbox change new <id> --title "..." --request "..."`.';
      break;
    case 'codex':
      notes.push('Для Codex установлены скиллы sbox-approve и sbox-browser в .agents/skills; оркестратор sbox-run, агенты ролей и раздел AGENTS.md для Codex появятся на этапе 4 плана.');
      next = 'В Codex: скиллы из .agents/skills доступны сразу; изменения пока ведутся из Claude Code или командами `sbox next` и `sbox report` вручную.';
      break;
  }
  return { target, files, notes, next };
}
