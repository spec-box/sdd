import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/core/config.js';
import { doctorDocs } from '../src/core/project-docs.js';
import { hasErrors } from '../src/core/diagnostics.js';
import { tempProject, write } from './helpers.js';

describe('doctor', () => {
  it('фикстура проходит структурную проверку', () => {
    const root = tempProject();
    const d = doctorDocs(root, loadConfig(root));
    expect(d.filter((x) => x.severity === 'error')).toEqual([]);
  });

  it('находит пропущенный раздел, заглушку и несуществующий путь', () => {
    const root = tempProject();
    write(root, '.sbox/project/glossary.md', '---\nid: g\nsummary: s\nread_when: r\nupdated: 2026-01-01\nverification: verified\n---\n# Словарь\n\n## Не тот раздел\n\nTODO дописать `src/nope/file.ts`\n');
    const d = doctorDocs(root, loadConfig(root));
    const codes = d.map((x) => x.code);
    expect(codes).toContain('DOC_SECTION_MISSING');
    expect(codes).toContain('DOC_PLACEHOLDER');
    expect(codes).toContain('DOC_PATH_MISSING');
    expect(hasErrors(d)).toBe(true);
  });
});
