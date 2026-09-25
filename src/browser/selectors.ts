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

const HOST_WITH_PORT = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\]):\d+(\/|\?|#|$)/i;
const BARE_DOMAIN = /^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)+)(:\d+)?(\/|\?|#|$)/i;
/** `index.html` без базового URL это файл, а не домен: последняя метка из известных расширений. */
const FILE_EXTENSION = /\.(html?|xhtml|php|aspx?|jsp|json|xml|txt|md|pdf|js|mjs|css|svg|png|jpe?g|gif|webp|ico|csv|yaml|yml)(\/|\?|#|$)/i;

/**
 * Адрес для goto. Полный URL со схемой как есть; `localhost:3000/x` и IP с портом получают http://;
 * при заданном базовом URL всё остальное разрешается от него (`index.html`, `/orders`, `orders/list`);
 * без базового URL доменное имя получает http://, а относительный путь даёт null.
 */
export function normalizeUrl(input: string, baseUrl: string | null): string | null {
  const url = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^(about|data|blob|file|javascript|mailto):/i.test(url)) return url;
  if (HOST_WITH_PORT.test(url)) return `http://${url}`;
  if (baseUrl) return new URL(url, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
  if (BARE_DOMAIN.test(url) && !FILE_EXTENSION.test(url.split('/')[0] ?? '')) return `http://${url}`;
  return null;
}
