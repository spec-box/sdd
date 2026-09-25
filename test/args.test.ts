import { describe, expect, it } from 'vitest';
import { intOption } from '../src/cli/args.js';

describe('cli: числовые опции', () => {
  it('принимает числа и отклоняет остальное с понятной ошибкой', () => {
    expect(intOption('42')).toBe(42);
    expect(intOption('0')).toBe(0);
    expect(() => intOption('abc')).toThrow(/ожидалось число/);
    expect(() => intOption('')).toThrow(/ожидалось число/);
  });
});
