import { StringDecoder } from 'node:string_decoder';

/** Протокол клиент → демон: JSON-строки через локальный сокет, по одному документу на строку. */
export interface Request {
  id: number;
  cmd: string;
  args: Record<string, unknown>;
}

export interface ErrorPayload {
  code: string;
  message: string;
  fix?: string;
}

export interface Response {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: ErrorPayload;
}

/** BigInt из страницы (eval) не сериализуется JSON.stringify: отдаём строкой, а не роняем демон. */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

export function encodeMessage(msg: Request | Response): string {
  return `${JSON.stringify(msg, replacer)}\n`;
}

/**
 * Накапливает куски потока и отдаёт разобранные строки; неполная строка ждёт продолжения.
 * Буферы декодируются через StringDecoder: многобайтовый символ UTF-8, разрезанный границей чанка, не портится.
 */
export function createLineParser<T>(onMessage: (msg: T) => void, onError?: (err: Error) => void): (chunk: string | Buffer) => void {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  return (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) {
        try {
          onMessage(JSON.parse(line) as T);
        } catch (e) {
          onError?.(e as Error);
        }
      }
      idx = buffer.indexOf('\n');
    }
  };
}
