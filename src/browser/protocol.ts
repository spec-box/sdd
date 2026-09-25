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

export function encodeMessage(msg: Request | Response): string {
  return `${JSON.stringify(msg)}\n`;
}

/** Накапливает куски потока и отдаёт разобранные строки; неполная строка ждёт продолжения. */
export function createLineParser<T>(onMessage: (msg: T) => void, onError?: (err: Error) => void): (chunk: string | Buffer) => void {
  let buffer = '';
  return (chunk) => {
    buffer += chunk.toString();
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
