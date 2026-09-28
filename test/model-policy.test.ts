import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { configSchema, defaultConfig, saveConfig } from '../src/core/config.js';
import { resolveModel, selectProfile, higherComplexity, MODEL_PROFILES } from '../src/core/model-policy.js';
import { installClaudeAgents } from '../src/adapters/host/claude/index.js';
import { parseDoc } from '../src/core/project-docs.js';
import { createChange, loadChange, saveChange } from '../src/core/change.js';
import { tempProject } from './helpers.js';

const config = (runner: object = {}) => configSchema.parse({ version: 1, spec: { adapter: 'spec-box' }, runner });
const cli = (root: string, args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', 'import {main} from "./src/cli/main.ts"; await main(["node", "sbox", ...process.argv.slice(1)]);', '--', '--cwd', root, '--json', ...args], { encoding: 'utf8' });

describe('профили моделей по раннерам', () => {
  it('отделяет настройки Claude от Codex, дополняет неполные профили дефолтами', () => {
    const c = config({ claude: { profiles: { medium: { model: 'claude-custom', effort: 'high' } } }, codex: { profiles: { medium: { model: 'codex-custom' } } } });
    expect(resolveModel(c, 'claude', 'researcher')).toMatchObject({ model: 'claude-custom', effort: 'high', profile: 'medium' });
    expect(resolveModel(c, 'codex', 'researcher')).toMatchObject({ model: 'codex-custom', effort: 'medium', profile: 'medium' });
    expect(resolveModel(c, 'claude', 'planner').profile).toBe('complex');
    expect(resolveModel(c, 'codex', 'distiller').profile).toBe('simple');
  });
  it.each([['простая', 'simple'], ['обычная', 'medium'], ['высокая', 'complex']] as const)('сопоставляет %s с %s для реализации, сохраняя сильное ревью', (level, profile) => {
    const c = defaultConfig();
    const complexity = { implementation: level, review: 'обычная' as const };
    expect(selectProfile(c, 'implementer', complexity)).toBe(profile);
    expect(selectProfile(c, 'tester', complexity)).toBe(profile);
    expect(selectProfile(c, 'reviewer', complexity)).toBe('complex');
    expect(selectProfile(c, 'reviewer', { implementation: 'обычная', review: level })).toBe('complex');
    expect(selectProfile(c, 'planner', complexity)).toBe('complex');
  });
  it('явный профиль роли имеет приоритет над автоматическим выбором', () => {
    const c = config({ roleProfiles: { reviewer: 'medium', planner: 'medium' } });
    expect(selectProfile(c, 'reviewer', { implementation: 'простая', review: 'простая' })).toBe('medium');
    expect(selectProfile(c, 'planner')).toBe('medium');
  });
  it.each(['claude', 'codex'] as const)('%s усиливает проработку и независимое ревью по умолчанию', (runner) => {
    for (const role of ['planner', 'challenger', 'reviewer'] as const) {
      expect(resolveModel(defaultConfig(), runner, role, { implementation: 'простая', review: 'простая' }))
        .toMatchObject({ profile: 'complex', effort: 'high' });
    }
  });
  it('не понижает автоматически сложность после возврата', () => {
    expect(higherComplexity('обычная', 'простая')).toBe('обычная');
    expect(higherComplexity('высокая', 'обычная')).toBe('высокая');
    expect(higherComplexity('простая', 'высокая')).toBe('высокая');
  });
  it('отклоняет старые общие поля с указанием нового расположения', () => {
    expect(() => config({ models: { planner: 'old' } })).toThrow(/runner.claude.profiles/);
    expect(() => config({ efforts: {} })).toThrow(/внутри профиля/);
    expect(() => config({ defaultEffort: 'medium' })).toThrow(/внутри профиля/);
  });
  it('валидирует профиль, роль, непустую модель и effort раннера', () => {
    expect(() => config({ roleProfiles: { writer: 'simple' } })).toThrow();
    expect(() => config({ roleProfiles: { planner: 'pro' } })).toThrow();
    expect(() => config({ claude: { profiles: { simple: { model: ' ' } } } })).toThrow();
    expect(() => config({ claude: { profiles: { simple: { effort: 'none' } } } })).toThrow();
    expect(() => config({ codex: { profiles: { complex: { effort: 'max' } } } })).toThrow();
    expect(() => config({ codex: { profiles: { complex: { effort: 'typo' } } } })).toThrow();
    expect(() => config({ codex: { extraConfig: ['model_reasoning_effort="low"'] } })).toThrow(/profiles/);
  });
  it('материалы Claude сохраняют точные model/effort всех профилей из общего resolver', () => {
    const root = tempProject('spec-box-project', { git: false });
    const c = config({ claude: { profiles: { complex: { model: 'claude-opus-pinned-version', effort: 'max' } } } });
    installClaudeAgents(root, c);
    for (const profile of MODEL_PROFILES) {
      const fm = parseDoc(fs.readFileSync(path.join(root, `.claude/agents/sbox-implementer-${profile}.md`), 'utf8')).frontmatter;
      expect(fm).toMatchObject({ name: `sbox-implementer-${profile}`, ...c.runner.claude.profiles[profile] });
    }
  });
  it('next и models учитывают runner и сложность, не смешивают их с размером изменения', () => {
    const root = tempProject('spec-box-project', { git: false });
    const c = config({ default: 'codex', claude: { profiles: { simple: { model: 'c-simple' } } }, codex: { profiles: { simple: { model: 'x-simple' } } } });
    saveConfig(root, c);
    const { dir } = createChange(root, c, { id: 'models', title: 't', request: 'r' });
    const change = loadChange(dir); change.phase = 'implement'; change.complexity = { implementation: 'простая', review: 'высокая' }; saveChange(dir, change);
    const next = cli(root, ['next', '--change', 'models', '--runner', 'claude', '--brief']);
    expect(next.status, next.stderr).toBe(0);
    const json = JSON.parse(next.stdout);
    expect(json.execution).toMatchObject({ model: 'c-simple', effort: 'low', profile: 'simple', agent: 'sbox-implementer-simple' });
    const codex = JSON.parse(cli(root, ['next', '--change', 'models', '--runner', 'codex', '--brief']).stdout);
    expect(codex.execution).toMatchObject({ model: 'x-simple', profile: 'simple', agent: null });
    const models = JSON.parse(cli(root, ['models', '--change', 'models']).stdout);
    expect(models.rows.find((r: { role: string; runner: string }) => r.role === 'reviewer' && r.runner === 'codex').profile).toBe('complex');
  });
});
