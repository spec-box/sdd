/** Комбинация клавиш для puppeteer: `ctrl+shift+a`, `Enter`, `cmd+ArrowDown`. Имена модификаторов и служебных клавиш нормализуются. */
const MODIFIERS: Record<string, string> = {
  ctrl: 'Control',
  control: 'Control',
  cmd: 'Meta',
  command: 'Meta',
  meta: 'Meta',
  win: 'Meta',
  shift: 'Shift',
  alt: 'Alt',
  option: 'Alt',
};

const SPECIAL = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Insert', ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)];
const SPECIAL_BY_LOWER = new Map(SPECIAL.map((k) => [k.toLowerCase(), k]));
const ALIASES: Record<string, string> = { esc: 'Escape', return: 'Enter', del: 'Delete', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', pgup: 'PageUp', pgdn: 'PageDown', spacebar: 'Space' };

export function parseKeyCombo(input: string): { modifiers: string[]; key: string } {
  const parts = input
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return { modifiers: [], key: '+' };
  const key = parts.pop()!;
  const modifiers = parts.map((m) => MODIFIERS[m.toLowerCase()] ?? m);
  const lower = key.toLowerCase();
  const canonical = key.length === 1 ? key : (ALIASES[lower] ?? SPECIAL_BY_LOWER.get(lower) ?? key);
  return { modifiers, key: canonical };
}
