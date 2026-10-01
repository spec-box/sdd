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
    expect(file.commands.help).toContain('sbox help');
    expect(renderPrompt(packet)).toContain('# Роль: researcher');
  });
});
