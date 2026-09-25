import { describe, expect, it } from 'vitest';
import { parseKeyCombo } from '../src/browser/keys.js';

describe('browser: комбинации клавиш', () => {
  it('нормализует модификаторы и служебные клавиши', () => {
    expect(parseKeyCombo('ctrl+a')).toEqual({ modifiers: ['Control'], key: 'a' });
    expect(parseKeyCombo('Cmd+Shift+enter')).toEqual({ modifiers: ['Meta', 'Shift'], key: 'Enter' });
    expect(parseKeyCombo('esc')).toEqual({ modifiers: [], key: 'Escape' });
    expect(parseKeyCombo('arrowdown')).toEqual({ modifiers: [], key: 'ArrowDown' });
    expect(parseKeyCombo('F5')).toEqual({ modifiers: [], key: 'F5' });
    expect(parseKeyCombo('Tab')).toEqual({ modifiers: [], key: 'Tab' });
  });

  it('оставляет одиночные символы и неизвестные имена как есть', () => {
    expect(parseKeyCombo('A')).toEqual({ modifiers: [], key: 'A' });
    expect(parseKeyCombo('alt+KeyA')).toEqual({ modifiers: ['Alt'], key: 'KeyA' });
    expect(parseKeyCombo('+')).toEqual({ modifiers: [], key: '+' });
  });
});
