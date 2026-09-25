/** Комбинация клавиш для puppeteer: `ctrl+shift+a`, `Enter`, `cmd+ArrowDown`, `ctrl++`, пробел. Имена модификаторов и служебных клавиш нормализуются. */
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
  // Одиночный символ, включая пробел и «+», это сама клавиша.
  if (input.length === 1) return { modifiers: [], key: input };
  let modifierPart: string;
  let key: string;
  if (input.endsWith('+') && input.length > 1) {
    // `ctrl++`: последний плюс это клавиша, а не разделитель.
    key = '+';
    modifierPart = input.slice(0, -1);
  } else {
    const idx = input.lastIndexOf('+');
    key = idx >= 0 ? input.slice(idx + 1) : input;
    modifierPart = idx >= 0 ? input.slice(0, idx) : '';
  }
  const modifiers = modifierPart
    .split('+')
    .map((m) => m.trim())
    .filter(Boolean)
    .map((m) => MODIFIERS[m.toLowerCase()] ?? m);
  if (key === ' ') return { modifiers, key };
  const trimmed = key.trim();
  const lower = trimmed.toLowerCase();
  const canonical = trimmed.length === 1 ? trimmed : (ALIASES[lower] ?? SPECIAL_BY_LOWER.get(lower) ?? trimmed);
  return { modifiers, key: canonical };
}
