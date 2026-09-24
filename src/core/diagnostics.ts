/** Единый конверт диагностики для всех команд (см. docs/design.md, раздел 12). */
export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  target?: string;
  fix?: string;
}

export function diag(
  severity: Severity,
  code: string,
  message: string,
  target?: string,
  fix?: string,
): Diagnostic {
  const d: Diagnostic = { severity, code, message };
  if (target) d.target = target;
  if (fix) d.fix = fix;
  return d;
}

export function hasErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error');
}
