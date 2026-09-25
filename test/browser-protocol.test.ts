import { describe, expect, it } from 'vitest';
import { createLineParser, encodeMessage } from '../src/browser/protocol.js';

describe('browser: протокол', () => {
  it('склеивает многобайтовый символ, разрезанный границей чанка', () => {
    const text = 'Привет, мир! '.repeat(2000);
    const line = Buffer.from(encodeMessage({ id: 1, ok: true, result: { text } }));
    const got: { result: { text: string } }[] = [];
    const feed = createLineParser<{ result: { text: string } }>((m) => got.push(m));
    // Режем внутри двухбайтовых символов: по нечётным смещениям.
    for (let offset = 0; offset < line.length; offset += 8_191) feed(line.subarray(offset, Math.min(line.length, offset + 8_191)));
    expect(got).toHaveLength(1);
    expect(got[0]!.result.text).toBe(text);
    expect(got[0]!.result.text.includes('�')).toBe(false);
  });

  it('разбирает несколько строк в одном чанке и неполную строку в двух', () => {
    const got: number[] = [];
    const feed = createLineParser<{ id: number }>((m) => got.push(m.id));
    feed('{"id":1}\n{"id":2}\n{"id"');
    expect(got).toEqual([1, 2]);
    feed(Buffer.from(':3}\n'));
    expect(got).toEqual([1, 2, 3]);
  });

  it('битая строка идёт в onError, а не роняет разбор', () => {
    const errors: string[] = [];
    const got: unknown[] = [];
    const feed = createLineParser((m) => got.push(m), (e) => errors.push(e.message));
    feed('{oops}\n{"id":4}\n');
    expect(errors).toHaveLength(1);
    expect(got).toEqual([{ id: 4 }]);
  });

  it('BigInt в результате сериализуется строкой, а не бросает исключение', () => {
    expect(encodeMessage({ id: 1, ok: true, result: { big: 10n ** 20n } })).toBe('{"id":1,"ok":true,"result":{"big":"100000000000000000000"}}\n');
  });
});
