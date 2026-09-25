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
