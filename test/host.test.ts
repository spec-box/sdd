import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { installHostMaterials } from '../src/adapters/host/index.js';
import { SKILL_LAYOUT } from '../src/adapters/host/skills.js';
import { loadConfig } from '../src/core/config.js';
import { assetsDir } from '../src/core/paths.js';
import { loadSkills, parseSkill, skillsForRole } from '../src/core/skills.js';
import { tempProject, write } from './helpers.js';

const BUILTIN = ['sbox-approve', 'sbox-browser', 'sbox-run'];

describe('host: скиллы из единого источника', () => {
  it('встроенные скиллы валидны и sbox-browser привязан к ролям, которые смотрят интерфейс', () => {
    const root = tempProject('spec-box-project', { git: false });
    const skills = loadSkills(root);
    expect(skills.map((s) => s.name)).toEqual(BUILTIN);
    expect(skills.every((s) => s.source === 'builtin' && s.description.length > 20)).toBe(true);
    expect(skillsForRole(skills, 'verifier')).toEqual(['sbox-browser']);
    expect(skillsForRole(skills, 'tester')).toEqual(['sbox-browser']);
    expect(skillsForRole(skills, 'researcher')).toEqual(['sbox-browser']);
    expect(skillsForRole(skills, 'planner')).toEqual([]);
  });

  it('claude: копирует скиллы без изменений и подключает их агентам полем skills', () => {
    const root = tempProject('spec-box-project', { git: false });
    const result = installHostMaterials(root, 'claude', loadConfig(root));
    const rel = result.files.map((f) => path.relative(root, f));
    expect(rel).toEqual(expect.arrayContaining(BUILTIN.map((n) => SKILL_LAYOUT.claude(n))));
    for (const name of BUILTIN) {
      expect(fs.readFileSync(path.join(root, SKILL_LAYOUT.claude(name)), 'utf8')).toBe(fs.readFileSync(path.join(assetsDir(), 'skills', `${name}.md`), 'utf8'));
    }
    for (const role of ['verifier', 'tester', 'researcher']) {
      expect(fs.readFileSync(path.join(root, `.claude/agents/sbox-${role}.md`), 'utf8')).toContain('effort: medium\nskills:\n  - sbox-browser\n---');
    }
    for (const role of ['planner', 'implementer', 'reviewer', 'challenger']) {
      const agent = fs.readFileSync(path.join(root, `.claude/agents/sbox-${role}.md`), 'utf8');
      expect(agent).not.toContain('skills:');
      expect(agent).toMatch(/\neffort: medium\n---/);
    }
    expect(result.notes).toEqual([]);
  });

  it('codex: те же скиллы в .agents/skills, агенты пока не генерируются', () => {
    const root = tempProject('spec-box-project', { git: false });
    const result = installHostMaterials(root, 'codex', loadConfig(root));
    const rel = result.files.map((f) => path.relative(root, f)).sort();
    expect(rel).toEqual(BUILTIN.map((n) => SKILL_LAYOUT.codex(n)).sort());
    expect(fs.readFileSync(path.join(root, '.agents/skills/sbox-browser/SKILL.md'), 'utf8')).toContain('name: sbox-browser');
    expect(fs.existsSync(path.join(root, '.claude'))).toBe(false);
    expect(result.notes.join(' ')).toMatch(/этапе 4/);
    expect(() => installHostMaterials(root, 'cursor')).toThrow(/HOST_UNKNOWN|Неизвестный хост/);
  });

  it('проект заменяет встроенный скилл и добавляет свой с привязкой к роли', () => {
    const root = tempProject('spec-box-project', { git: false });
    write(root, '.sbox/skills/sbox-browser.md', '---\nname: sbox-browser\ndescription: Наш браузерный регламент\nmetadata:\n  roles: [verifier]\n---\n\n# Наш регламент\n');
    write(root, '.sbox/skills/release-notes.md', '---\nname: release-notes\ndescription: Как писать заметки к релизу\nmetadata:\n  roles: [planner]\n---\n\n# Заметки\n');
    const skills = loadSkills(root);
    expect(skills.find((s) => s.name === 'sbox-browser')).toMatchObject({ source: 'project', roles: ['verifier'] });
    expect(skillsForRole(skills, 'tester')).toEqual([]);
    expect(skillsForRole(skills, 'planner')).toEqual(['release-notes']);
    installHostMaterials(root, 'claude', loadConfig(root));
    expect(fs.readFileSync(path.join(root, '.claude/skills/sbox-browser/SKILL.md'), 'utf8')).toContain('# Наш регламент');
    expect(fs.readFileSync(path.join(root, '.claude/agents/sbox-planner.md'), 'utf8')).toContain('skills:\n  - release-notes\n---');
    expect(fs.readFileSync(path.join(root, '.claude/agents/sbox-tester.md'), 'utf8')).not.toContain('skills:');
  });

  it('проверяет фронтматтер скилла', () => {
    expect(() => parseSkill('# без фронтматтера\n', '/x/my.md', 'project')).toThrow(/BAD_SKILL|фронтматтера/);
    expect(() => parseSkill('---\nname: other\ndescription: d\n---\n', '/x/my.md', 'project')).toThrow(/совпадать с именем файла/);
    expect(() => parseSkill('---\nname: my\ndescription: d\nmetadata:\n  roles: [ninja]\n---\n', '/x/my.md', 'project')).toThrow(/неизвестная роль/);
    expect(parseSkill('---\nname: my\ndescription: d\n---\nтело\n', '/x/my.md', 'builtin')).toMatchObject({ name: 'my', roles: [], source: 'builtin' });
  });
});
