import { describe, expect, it } from 'vitest';
import { loadRoleDescription, loadRoleText } from '../src/core/roles.js';
import { tempProject, write } from './helpers.js';

describe('роли как данные', () => {
  it('текст роли без фронтматтера, описание из фронтматтера', () => {
    const root = tempProject('spec-box-project', { git: false });
    const text = loadRoleText(root, 'verifier');
    expect(text.startsWith('# Роль: verifier')).toBe(true);
    expect(text).not.toContain('description:');
    expect(loadRoleDescription(root, 'verifier')).toMatch(/^Верификатор @spec-box\/sdd/);
  });

  it('переопределение проекта без фронтматтера даёт общее описание', () => {
    const root = tempProject('spec-box-project', { git: false });
    write(root, '.sbox/roles/tester.md', '# Наш тестировщик\n\nПиши тесты.\n');
    expect(loadRoleText(root, 'tester')).toBe('# Наш тестировщик\n\nПиши тесты.\n');
    expect(loadRoleDescription(root, 'tester')).toMatch(/Роль tester/);
  });
});
