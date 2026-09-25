import { describe, expect, it } from 'vitest';
import { parseTarget, urlMatches } from '../src/browser/selectors.js';

describe('browser: цели команд', () => {
  it('ссылки из снимка: с @ и без', () => {
    expect(parseTarget('@e12')).toEqual({ kind: 'ref', ref: 'e12', raw: '@e12' });
    expect(parseTarget('e3')).toEqual({ kind: 'ref', ref: 'e3', raw: 'e3' });
  });

  it('префиксы text=, aria=, xpath=, css= переводятся в p-селекторы puppeteer', () => {
    expect(parseTarget('text=Войти').selector).toBe('::-p-text(Войти)');
    expect(parseTarget('aria=Сохранить').selector).toBe('::-p-aria(Сохранить)');
    expect(parseTarget('xpath=//button[1]').selector).toBe('::-p-xpath(//button[1])');
    expect(parseTarget('css=#id > a').selector).toBe('#id > a');
    expect(parseTarget('//a[@href]').selector).toBe('::-p-xpath(//a[@href])');
  });

  it('обычный CSS остаётся как есть', () => {
    expect(parseTarget('button.primary[data-test=save]').selector).toBe('button.primary[data-test=save]');
  });

  it('совпадение URL: подстрока или glob', () => {
    expect(urlMatches('https://app.example.com/orders/12', '/orders/')).toBe(true);
    expect(urlMatches('https://app.example.com/orders/12', '*/orders/*')).toBe(true);
    expect(urlMatches('https://app.example.com/orders/12', 'https://app.example.com/login*')).toBe(false);
  });
});

describe('browser: адрес для goto', () => {
  it('полный URL и служебные схемы проходят как есть', async () => {
    const { normalizeUrl } = await import('../src/browser/selectors.js');
    expect(normalizeUrl('https://app.local/x?y=1', null)).toBe('https://app.local/x?y=1');
    expect(normalizeUrl('about:blank', 'http://base')).toBe('about:blank');
    expect(normalizeUrl('file:///tmp/a.html', null)).toBe('file:///tmp/a.html');
  });

  it('хост с портом и доменные имена получают http://', async () => {
    const { normalizeUrl } = await import('../src/browser/selectors.js');
    expect(normalizeUrl('localhost:3000', null)).toBe('http://localhost:3000');
    expect(normalizeUrl('localhost:3000/orders?x=1', null)).toBe('http://localhost:3000/orders?x=1');
    expect(normalizeUrl('127.0.0.1:8080/x', null)).toBe('http://127.0.0.1:8080/x');
    expect(normalizeUrl('example.com/path', null)).toBe('http://example.com/path');
  });

  it('относительный путь считается от базового URL, без него даёт null', async () => {
    const { normalizeUrl } = await import('../src/browser/selectors.js');
    expect(normalizeUrl('/orders', 'http://localhost:3000')).toBe('http://localhost:3000/orders');
    expect(normalizeUrl('orders/list', 'http://localhost:3000/app')).toBe('http://localhost:3000/app/orders/list');
    expect(normalizeUrl('/orders', null)).toBeNull();
    expect(normalizeUrl('orders', null)).toBeNull();
  });
});

describe('browser: относительные адреса при базовом URL', () => {
  it('имя файла с расширением разрешается от базового URL, а не считается доменом', async () => {
    const { normalizeUrl } = await import('../src/browser/selectors.js');
    expect(normalizeUrl('index.html', 'http://localhost:3000')).toBe('http://localhost:3000/index.html');
    expect(normalizeUrl('login.php?x=1', 'http://localhost:3000/app')).toBe('http://localhost:3000/app/login.php?x=1');
    expect(normalizeUrl('example.com/path', 'http://localhost:3000')).toBe('http://localhost:3000/example.com/path');
    expect(normalizeUrl('localhost:4000/x', 'http://localhost:3000')).toBe('http://localhost:4000/x');
    expect(normalizeUrl('index.html', null)).toBeNull();
  });
});
