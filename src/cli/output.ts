import { SboxError } from '../core/errors.js';
import type { Diagnostic } from '../core/diagnostics.js';

export interface OutputOptions {
  json: boolean;
}

/** Один JSON-документ в stdout в режиме --json; человекочитаемый текст в stdout иначе. */
export function emit<T extends object>(opts: OutputOptions, data: T, human: (d: T) => string): void {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, ...data }, null, 2)}\n`);
  } else {
    process.stdout.write(`${human(data).trimEnd()}\n`);
  }
}

/** Ошибка в машиночитаемом виде: код, сообщение, подсказка. Общая для CLI и демона браузера. */
export function errorPayload(err: unknown, fallbackCode = 'UNEXPECTED'): { code: string; message: string; fix?: string } {
  if (err instanceof SboxError) return { code: err.code, message: err.message, ...(err.fix ? { fix: err.fix } : {}) };
  return { code: fallbackCode, message: err instanceof Error ? err.message : String(err) };
}

export function emitError(opts: OutputOptions, err: unknown): void {
  const status: Diagnostic[] = [{ severity: 'error', ...errorPayload(err) }];
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ok: false, status }, null, 2)}\n`);
  } else {
    for (const s of status) process.stderr.write(`ошибка ${s.code}: ${s.message}${s.fix ? `\n  → ${s.fix}` : ''}\n`);
  }
}

export function formatDiagnostics(diagnostics: Diagnostic[]): string {
  if (diagnostics.length === 0) return 'Диагностика: без замечаний';
  const icon = { error: 'E', warning: 'W', info: 'i' } as const;
  return diagnostics
    .map((d) => `[${icon[d.severity]}] ${d.code}${d.target ? ` (${d.target})` : ''}: ${d.message}${d.fix ? `\n    → ${d.fix}` : ''}`)
    .join('\n');
}
