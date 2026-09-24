import type { Diagnostic } from './diagnostics.js';
import type { Config } from './config.js';
import type { Capability, SpecDelta } from './spec-model.js';

/** Контракт адаптера спецификаций (docs/design.md, раздел 11). */
export interface SpecAdapter {
  readonly name: string;
  /** Прочитать истину: все capability проекта. */
  readTruth(): Promise<Capability[]>;
  /** Прочитать дельты из каталога specs/ изменения. */
  readDelta(dir: string): Promise<SpecDelta[]>;
  /** Проверить дельты относительно истины. */
  validate(truth: Capability[], deltas: SpecDelta[]): Diagnostic[];
  /** Применить дельты к истине и записать файлы. Возвращает изменённые пути. Применение обязано быть идемпотентным. */
  apply(truth: Capability[], deltas: SpecDelta[]): Promise<string[]>;
  /** Файлы истины, которые затронет apply (относительно корня): для снимка и отката. */
  targets(truth: Capability[], deltas: SpecDelta[]): string[];
  /** Структурная проверка истины после применения: дубликаты требований и сценариев. */
  checkTruth(truth: Capability[]): Diagnostic[];
  /** Инструкция для планировщика: как писать дельту в формате адаптера. */
  instructions(): string;
  /** Выгрузка во внешнюю систему, если есть. */
  sync?(): Promise<void>;
}

export type SpecAdapterFactory = (root: string, config: Config) => SpecAdapter;

const registry = new Map<string, SpecAdapterFactory>();

export function registerSpecAdapter(name: string, factory: SpecAdapterFactory): void {
  registry.set(name, factory);
}

export function createSpecAdapter(root: string, config: Config): SpecAdapter {
  const factory = registry.get(config.spec.adapter);
  if (!factory) {
    throw new Error(`Адаптер спецификаций "${config.spec.adapter}" не зарегистрирован`);
  }
  return factory(root, config);
}
