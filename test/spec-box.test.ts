import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyDelta, parseDelta, validateDeltas } from '../src/adapters/spec/spec-box/delta.js';
import { parseSpecBoxFile, serializeSpecBox } from '../src/adapters/spec/spec-box/yaml.js';
import { SpecBoxAdapter } from '../src/adapters/spec/spec-box/index.js';
import { loadConfig } from '../src/core/config.js';
import { read, tempProject, write } from './helpers.js';

const TRUTH = `feature: Главная страница
description: Витрина
code: home-page
specs-unit:
  Промо-блок показывает слайды:
    - assert: Отображается карусель
    - assert: У слайда есть заголовок
  Блок корзины:
    - assert: Отображается стоимость
`;

describe('spec-box yaml', () => {
  it('читает файл в модель и обратно без потерь', () => {
    const cap = parseSpecBoxFile(TRUTH, 'specs/home.yml');
    expect(cap.id).toBe('home-page');
    expect(cap.requirements).toHaveLength(2);
    expect(cap.requirements[0]!.scenarios[1]!.title).toBe('У слайда есть заголовок');
    const again = parseSpecBoxFile(serializeSpecBox(cap), 'x');
    expect(again).toMatchObject({ id: cap.id, title: cap.title, purpose: cap.purpose });
    expect(again.requirements.map((r) => r.title)).toEqual(cap.requirements.map((r) => r.title));
  });
});

describe('spec-box delta', () => {
  const truth = [parseSpecBoxFile(TRUTH, 'specs/home.yml')];
  const ids = new Set(['home-page']);

  it('добавляет, меняет, удаляет и переименовывает группы', () => {
    const delta = parseDelta(
      `code: home-page
added:
  Промо-блок показывает слайды:
    - assert: Слайды листаются свайпом
  Новая группа:
    - assert: Новое утверждение
modified:
  Блок корзины показывает состав:
    - assert: Отображается количество и стоимость
removed:
  Промо-блок показывает слайды:
    asserts: ["Отображается карусель"]
renamed:
  - from: Блок корзины
    to: Блок корзины показывает состав
`,
      'd.yml',
      ids,
    );
    expect(validateDeltas(truth, [delta]).filter((d) => d.severity === 'error')).toEqual([]);
    const next = applyDelta(truth[0], delta);
    const titles = next.requirements.map((r) => r.title);
    expect(titles).toEqual(['Промо-блок показывает слайды', 'Блок корзины показывает состав', 'Новая группа']);
    expect(next.requirements[0]!.scenarios.map((s) => s.title)).toEqual(['У слайда есть заголовок', 'Слайды листаются свайпом']);
    expect(next.requirements[1]!.scenarios.map((s) => s.title)).toEqual(['Отображается количество и стоимость']);
  });

  it('находит ошибки: несуществующая группа, новая capability без feature', () => {
    const bad = parseDelta('code: home-page\nmodified:\n  Нет такой:\n    - assert: x\n', 'bad.yml', ids);
    const codes = validateDeltas(truth, [bad]).map((d) => d.code);
    expect(codes).toContain('DELTA_MODIFY_MISSING');
    const stale = parseDelta('code: home-page\nrenamed:\n  - { from: Блок корзины, to: Корзина }\nmodified:\n  Блок корзины:\n    - assert: x\n', 'stale.yml', ids);
    expect(validateDeltas(truth, [stale]).map((d) => d.code)).toContain('DELTA_MODIFY_RENAMED');
    const fresh = parseDelta('code: new-cap\nadded:\n  Группа:\n    - assert: x\n', 'new.yml', ids);
    expect(validateDeltas(truth, [fresh]).map((d) => d.code)).toContain('DELTA_NEW_TITLE');
  });

  it('адаптер читает истину из .tms.json и применяет дельту в файл', async () => {
    const root = tempProject();
    const adapter = new SpecBoxAdapter(root, loadConfig(root));
    const truth = await adapter.readTruth();
    expect(truth.map((c) => c.id)).toEqual(['home-page']);
    write(root, '.sbox/changes/x/specs/home-page.yml', 'code: home-page\nadded:\n  Поиск по каталогу:\n    - assert: Поле поиска показывает подсказки\n');
    write(root, '.sbox/changes/x/specs/cart-page.yml', 'code: cart-page\nfeature: Страница корзины\ndescription: Список товаров перед оформлением заказа\nadded:\n  Список товаров:\n    - assert: Отображаются товары с ценами\n');
    const deltas = await adapter.readDelta(path.join(root, '.sbox/changes/x/specs'));
    expect(deltas).toHaveLength(2);
    expect(adapter.validate(truth, deltas).filter((d) => d.severity === 'error')).toEqual([]);
    const files = await adapter.apply(truth, deltas);
    expect(files.sort()).toEqual(['specs/cart-page.spec-box.yml', 'specs/home-page.spec-box.yml']);
    expect(read(root, 'specs/home-page.spec-box.yml')).toContain('Поиск по каталогу');
    expect(read(root, 'specs/cart-page.spec-box.yml')).toContain('feature: Страница корзины');
  });
});
