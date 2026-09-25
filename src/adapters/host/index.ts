import { SboxError } from '../../core/errors.js';
import type { Config } from '../../core/config.js';
import { installClaudeAgents } from './claude/index.js';
import { installSkills, isHostTarget, type HostTarget } from './skills.js';

export interface HostInstallResult {
  target: HostTarget;
  files: string[];
  notes: string[];
}

/** Материалы хоста: скиллы из единого источника для любого хоста плюс агенты, если адаптер хоста их умеет. */
export function installHostMaterials(root: string, target: string, config?: Config): HostInstallResult {
  if (!isHostTarget(target)) throw new SboxError('HOST_UNKNOWN', `Неизвестный хост ${target}; доступны claude и codex.`);
  const files = installSkills(root, target);
  const notes: string[] = [];
  switch (target) {
    case 'claude':
      files.push(...installClaudeAgents(root, config));
      break;
    case 'codex':
      notes.push('Скиллы для Codex установлены в .agents/skills; агенты ролей и раздел AGENTS.md для Codex появятся на этапе 4 плана.');
      break;
  }
  return { target, files, notes };
}
