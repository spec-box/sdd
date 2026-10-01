import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { installHostMaterials } from '../src/adapters/host/index.js';
import { tomlString, updateAgentsSection } from '../src/adapters/host/codex/index.js';
import { loadConfig } from '../src/core/config.js';
import { read, tempProject, write } from './helpers.js';

// Generated values use TOML basic strings, also parseable as JSON strings.
function agent(root: string, name: string): Record<string, string> {
  return Object.fromEntries(read(root, `.codex/agents/${name}.toml`).split('\n').filter(l => l.includes(' = ')).map(l => {
    const split = l.indexOf(' = '); return [l.slice(0, split), JSON.parse(l.slice(split + 3))];
  }));
}

describe('материалы Codex', () => {
  it('применяет профили, права роли и проектные переопределения; фильтрует скиллы хоста', () => {
    const root = tempProject('spec-box-project', { git: false });
    const c = loadConfig(root);
    c.runner.codex.profiles.complex = { model: 'custom-model', effort: 'xhigh' };
    c.runner.roleProfiles.implementer = 'complex';
    write(root, '.sbox/roles/planner.md', '# Планировщик проекта\nПроверь "кавычки" и C:\\files.\n');
    write(root, '.sbox/skills/local-review.md', '---\nname: local-review\ndescription: Правила проекта\nmetadata:\n  roles: [planner]\n  hosts: [codex]\n---\nТекст\n');
    write(root, '.sbox/skills/claude-only.md', '---\nname: claude-only\ndescription: Только Claude\nmetadata:\n  roles: [planner]\n  hosts: [claude]\n---\nТекст\n');
    installHostMaterials(root, 'codex', c);
    expect(agent(root, 'sbox-planner-complex')).toMatchObject({ name: 'sbox-planner-complex', model: 'custom-model', model_reasoning_effort: 'xhigh', sandbox_mode: 'workspace-write' });
    expect(agent(root, 'sbox-implementer').model).toBe('custom-model');
    expect(agent(root, 'sbox-reviewer-complex').sandbox_mode).toBe('read-only');
    const prompt = agent(root, 'sbox-planner-complex').developer_instructions!;
    expect(prompt).toContain('C:\\files');
    expect(prompt).not.toContain('.agents/skills/'); // скиллы не предзагружаются: роль читает руководство через help
    expect(prompt).toContain('sbox help');
    expect(prompt).not.toContain('claude-only');
    expect(prompt).toContain('сам этот файл не записывай');
    expect(fs.existsSync(path.join(root, '.agents/skills/claude-only'))).toBe(false);
  });
  it('повторная установка сохраняет пользовательские инструкции и конфиг, обновляет модели', () => {
    const root = tempProject('spec-box-project', { git: false });
    write(root, 'AGENTS.md', '# Наши правила\nНе менять API.\n');
    write(root, '.codex/config.toml', 'model = "personal"\n');
    const c = loadConfig(root);
    installHostMaterials(root, 'codex', c);
    const once = read(root, 'AGENTS.md');
    installHostMaterials(root, 'codex', c);
    expect(read(root, 'AGENTS.md')).toBe(once);
    expect(once.startsWith('# Наши правила\nНе менять API.\n')).toBe(true);
    expect(read(root, '.codex/config.toml')).toBe('model = "personal"\n');
    c.runner.codex.profiles.complex.effort = 'xhigh';
    installHostMaterials(root, 'codex', c);
    expect(agent(root, 'sbox-reviewer-complex').model_reasoning_effort).toBe('xhigh');
  });
  it('повреждённые маркеры и чужие файлы отклоняются до записи материалов', () => {
    const root = tempProject('spec-box-project', { git: false });
    write(root, 'AGENTS.md', '<!-- sbox:begin -->\nЧужой текст\n');
    expect(() => installHostMaterials(root, 'codex', loadConfig(root))).toThrow(/Повреждён/);
    expect(fs.existsSync(path.join(root, '.agents'))).toBe(false);
    write(root, 'AGENTS.md', 'Правила\n');
    write(root, '.codex/agents/sbox-planner.toml', 'name = "my-planner"\n');
    expect(() => installHostMaterials(root, 'codex', loadConfig(root))).toThrow(/не создан sbox/);
    expect(read(root, 'AGENTS.md')).toBe('Правила\n');
    expect(read(root, '.codex/agents/sbox-planner.toml')).toBe('name = "my-planner"\n');
  });
  it('обновляет только управляемый блок и корректно кодирует управляющие символы', () => {
    expect(updateAgentsSection('до\n<!-- sbox:begin -->\nстарое\n<!-- sbox:end -->\nпосле', 'новое')).toBe('до\n<!-- sbox:begin -->\nновое\n<!-- sbox:end -->\nпосле');
    const value = 'C:\\foo\n"quotes"\f\u007f';
    expect(JSON.parse(tomlString(value))).toBe(value);
    expect(tomlString('\f')).toBe('"\\u000c"');
  });
});
