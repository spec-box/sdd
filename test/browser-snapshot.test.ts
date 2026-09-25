import { describe, expect, it } from 'vitest';
import { renderSnapshot, type AXNodeLike } from '../src/browser/snapshot.js';

const tree: AXNodeLike = {
  role: 'RootWebArea',
  name: 'Вход',
  children: [
    { role: 'heading', name: 'Вход в систему', level: 1 },
    { role: 'StaticText', name: 'Введите данные' },
    { role: 'generic', children: [{ role: 'textbox', name: 'Логин', value: 'ivan', focused: true }] },
    { role: 'textbox', name: 'Пароль', required: true },
    { role: 'checkbox', name: 'Запомнить меня', checked: true },
    { role: 'button', name: 'Войти', disabled: true },
    { role: 'link', name: 'Регистрация', url: 'https://example.com/register' },
    { role: 'StaticText', name: '   ' },
  ],
};

describe('browser: снимок дерева доступности', () => {
  it('нумерует интерактивные элементы и показывает состояния', () => {
    const s = renderSnapshot(tree);
    expect(s.count).toBe(5);
    expect(s.refs.get('e1')?.name).toBe('Логин');
    expect(s.text).toContain('heading "Вход в систему" (h1)');
    expect(s.text).toContain('[e1] textbox "Логин" value="ivan" [focused]');
    expect(s.text).toContain('[e2] textbox "Пароль" [required]');
    expect(s.text).toContain('[e3] checkbox "Запомнить меня" [checked]');
    expect(s.text).toContain('[e4] button "Войти" [disabled]');
    expect(s.text).toContain('[e5] link "Регистрация" → https://example.com/register');
    expect(s.text).not.toContain('generic');
    expect(s.text).toContain('text "Введите данные"');
  });

  it('interactiveOnly оставляет только элементы со ссылками', () => {
    const s = renderSnapshot(tree, { interactiveOnly: true });
    expect(s.text.split('\n')).toHaveLength(5);
    expect(s.text).not.toContain('heading');
  });

  it('обрезает длинный снимок и помечает это', () => {
    const big: AXNodeLike = { role: 'RootWebArea', children: Array.from({ length: 200 }, (_, i) => ({ role: 'button', name: `Кнопка ${i}` })) };
    const s = renderSnapshot(big, { maxChars: 500 });
    expect(s.truncated).toBe(true);
    expect(s.text).toContain('снимок обрезан');
    expect(s.count).toBe(200);
  });

  it('пустое дерево даёт пустой текст', () => {
    expect(renderSnapshot(null).text).toBe('');
  });
});
