/**
 * Внутренняя модель спецификаций, единая для всех адаптеров (docs/design.md, раздел 7).
 * capability → requirement → scenario.
 */
export type AutomationState = 'unknown' | 'automated' | 'problem';

export interface Scenario {
  id: string;
  title: string;
  description?: string;
  automation?: { state: AutomationState; testRef?: string };
}

export interface Requirement {
  id: string;
  title: string;
  /** Нормативный текст (SHALL). У spec-box его нет: там название группы и есть требование. */
  text?: string;
  scenarios: Scenario[];
  /** Исходный текст блока в формате адаптера, если адаптер применяет дельты текстово (OpenSpec). */
  raw?: string;
}

export interface Capability {
  id: string;
  title: string;
  purpose?: string;
  type?: string;
  attributes?: Record<string, string[]>;
  requirements: Requirement[];
  /** Откуда прочитано: путь файла истины относительно корня проекта. */
  source?: string;
}

export type DeltaOp =
  | { op: 'add-requirement'; requirement: Requirement }
  | { op: 'modify-requirement'; requirement: Requirement }
  | { op: 'remove-requirement'; requirementTitle: string; reason?: string; migration?: string; scenarios?: string[] }
  | { op: 'rename-requirement'; from: string; to: string };

export interface SpecDelta {
  capabilityId: string;
  /** Новая capability: в истине её ещё нет. */
  isNew: boolean;
  title?: string;
  purpose?: string;
  type?: string;
  attributes?: Record<string, string[]>;
  ops: DeltaOp[];
  /** Файл дельты относительно корня проекта. */
  source: string;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}
