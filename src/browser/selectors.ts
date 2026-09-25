/**
 * Цель команды: ссылка из снимка (`@e12` или `e12`) либо селектор.
 * Селекторы: CSS по умолчанию; `text=…`, `aria=…`, `xpath=…` или `//…` переводятся в p-селекторы puppeteer.
 */
export type Target = { kind: 'ref'; ref: string; raw: string } | { kind: 'selector'; selector: string; raw: string };

const REF = /^@?(e\d+)$/;

export function parseTarget(input: string): Target {
  const raw = input.trim();
  const ref = raw.match(REF);
  if (ref) return { kind: 'ref', ref: ref[1]!, raw };
  const eq = raw.match(/^(text|aria|xpath|css)=([\s\S]*)$/);
  if (eq) {
    const [, prefix, value] = eq as [string, string, string];
    switch (prefix) {
      case 'text':
        return { kind: 'selector', selector: `::-p-text(${value})`, raw };
      case 'aria':
        return { kind: 'selector', selector: `::-p-aria(${value})`, raw };
      case 'xpath':
        return { kind: 'selector', selector: `::-p-xpath(${value})`, raw };
      default:
        return { kind: 'selector', selector: value, raw };
    }
  }
  if (raw.startsWith('//') || raw.startsWith('(//')) return { kind: 'selector', selector: `::-p-xpath(${raw})`, raw };
  return { kind: 'selector', selector: raw, raw };
}

/** Совпадение URL с шаблоном: подстрока либо glob со звёздочками. */
export function urlMatches(url: string, pattern: string): boolean {
  if (!pattern.includes('*')) return url.includes(pattern);
  const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(url);
}
