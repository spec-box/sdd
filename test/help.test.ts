import { describe, expect, it } from 'vitest';
import '../src/adapters/spec/index.js';
import { createChange, loadChange } from '../src/core/change.js';
import { loadConfig } from '../src/core/config.js';
import { findHelpTopic, loadHelpTopics, renderHelpIndex, requireHelpTopic } from '../src/core/help.js';
import { buildPacket, packetFileJson, renderPrompt } from '../src/core/packet.js';
import { createSpecAdapter } from '../src/contract/adapter.js';
import { tempProject, write } from './helpers.js';

describe('справка sbox help', () => {
  it('темы: встроенные файлы и скиллы инструментов без фронтматтера, вне проекта тоже', () => {
    const topics = loadHelpTopics('/');
    expect(topics.map((t) => t.topic)).toEqual(['approve', 'browser', 'contract', 'log', 'packet', 'result', 'run', 'wiki']);
    const browser = findHelpTopic(topics, 'sbox-browser')!;
    expect(browser.source).toBe('builtin');
    expect(browser.text.startsWith('# sbox-browser')).toBe(true);
    expect(browser.text).not.toContain('metadata:');
    expect(findHelpTopic(topics, 'result')!.text).toContain('# sbox-result');
    expect(renderHelpIndex(topics)).toContain('- browser (sbox-browser help) — ');
    expect(() => requireHelpTopic(topics, 'nope')).toThrow(/Нет темы справки «nope»/);
  });

  it('проект заменяет скилл и добавляет свою тему', () => {
    const root = tempProject();
    write(root, '.sbox/skills/sbox-browser.md', '---\nname: sbox-browser\ndescription: Наш регламент\n---\n\n# Наш браузер\nтекст\n');
    write(root, '.sbox/help/release.md', '---\ndescription: Как выпускать\n---\n\n# Релиз\nшаги\n');
    const topics = loadHelpTopics(root);
    expect(findHelpTopic(topics, 'browser')).toMatchObject({ source: 'project', description: 'Наш регламент', text: '# Наш браузер\nтекст' });
    expect(findHelpTopic(topics, 'release')).toMatchObject({ source: 'project', description: 'Как выпускать', text: '# Релиз\nшаги' });
    expect(findHelpTopic(topics, 'contract')?.source).toBe('builtin');
  });
});

describe('файл пакета', () => {
  it('не содержит текста роли, headless-промпт содержит; resultFormat и commands ведут к справке', () => {
    const root = tempProject();
    const config = loadConfig(root);
    const adapter = createSpecAdapter(root, config);
    const { dir } = createChange(root, config, { id: 'pk', title: 'П', request: 'r' });
    const packet = buildPacket({ root, config, change: loadChange(dir), dir, role: 'researcher', phase: 'research', adapter, truthSources: [] });
    const file = JSON.parse(packetFileJson(packet));
    expect(file.rolePrompt).toBeUndefined();
    expect(file.objective).toBe(packet.objective);
    expect(file.resultFormat).toContain('sbox help result');
    expect(file.commands).toBeUndefined();
    expect(file.tools.map((t: { tool: string }) => t.tool)).toEqual(['sbox', 'sbox-browser', 'sbox-contract', 'sbox-wiki']);
    expect(file.tools[0]).toMatchObject({ help: 'sbox help [тема]' });
    expect(file.tools[1]).toMatchObject({ help: 'sbox-browser help', commands: ['sbox-browser goto <url>', 'sbox-browser snapshot', 'sbox-browser console --errors'] });
    expect(file.tools[2].when).toContain('Используй');
    expect(renderPrompt(packet)).toContain('# Роль: researcher');
  });
});

describe('указатель инструментов', () => {
  it('зависит от роли и фазы, проектный скилл с ролями попадает в указатель со справкой sbox help', () => {
    const root = tempProject();
    const config = loadConfig(root);
    const adapter = createSpecAdapter(root, config);
    write(root, '.sbox/skills/release-notes.md', '---\nname: release-notes\ndescription: Как писать заметки к релизу\nmetadata:\n  roles: [planner]\n  commands: [cat docs/release.md]\n---\n\n# Заметки\n');
    const { dir } = createChange(root, config, { id: 'tl', title: 'Т', request: 'r' });
    const planner = buildPacket({ root, config, change: loadChange(dir), dir, role: 'planner', phase: 'plan', adapter, truthSources: [] });
    expect(planner.tools.map((t) => t.tool)).toEqual(['sbox', 'release-notes', 'sbox-contract', 'sbox-wiki']);
    expect(planner.tools[0]!.commands.some((c) => c.startsWith('sbox instructions'))).toBe(true);
    expect(planner.tools.find((t) => t.tool === 'release-notes')).toMatchObject({ help: 'sbox help release-notes', commands: ['cat docs/release.md'] });
    expect(planner.tools.find((t) => t.tool === 'sbox-contract')!.commands.some((c) => c.includes('diff --delta'))).toBe(true);
    const verifier = buildPacket({ root, config, change: loadChange(dir), dir, role: 'verifier', phase: 'verify', adapter, truthSources: [] });
    expect(verifier.tools[0]!.commands.some((c) => c.startsWith('sbox changeset show'))).toBe(true);
    expect(verifier.tools.map((t) => t.tool)).toContain('sbox-browser');
    const implementer = buildPacket({ root, config, change: loadChange(dir), dir, role: 'implementer', phase: 'implement', adapter, truthSources: [] });
    expect(implementer.tools.map((t) => t.tool)).not.toContain('sbox-browser');
  });
});
