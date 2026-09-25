import { describe, expect, it } from 'vitest';
import { parseRoleResult } from '../src/core/result.js';

describe('parseRoleResult', () => {
  it('разбирает блок sbox-result в конце ответа', () => {
    const md = `Сделано.\n\n\`\`\`yaml\n# sbox-result\nstatus: готово\nblocker: { category: нет }\nsize: normal\ncomplexity: { implementation: обычная, review: высокая }\n\`\`\`\n`;
    const r = parseRoleResult(md);
    expect(r.status).toBe('готово');
    expect(r.size).toBe('normal');
    expect(r.complexity?.review).toBe('высокая');
  });

  it('берёт последний блок, если их несколько', () => {
    const md = '```yaml\n# sbox-result\nstatus: заблокировано\nblocker: { category: тесты, message: x }\n```\nпотом\n```yaml\n# sbox-result\nstatus: готово\n```\n';
    expect(parseRoleResult(md).status).toBe('готово');
  });

  it('требует категорию блокера для статуса заблокировано', () => {
    expect(() => parseRoleResult('```yaml\n# sbox-result\nstatus: заблокировано\n```')).toThrow(/blocker.category/);
  });

  it('разбирает request и deviations и отклоняет чужой статус', () => {
    const md = '```yaml\n# sbox-result\nstatus: готово\nrequest:\n  - { quote: "обновить th-ui", status: противоречит, evidence: "npm" }\ndeviations:\n  - { subject: evidence, text: "x", decision: "y" }\n```';
    const r = parseRoleResult(md);
    expect(r.request?.[0]?.status).toBe('противоречит');
    expect(r.deviations?.[0]?.subject).toBe('evidence');
    expect(() => parseRoleResult('```yaml\n# sbox-result\nstatus: готово\nrequest:\n  - { quote: "x", status: наверное }\n```')).toThrow(/request/);
  });

  it('падает без блока', () => {
    expect(() => parseRoleResult('просто текст')).toThrow(/sbox-result/);
  });
});
