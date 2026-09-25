import { InvalidArgumentError } from 'commander';

/** Числовая опция commander: нечисло даёт ошибку разбора с понятным текстом, а не NaN. */
export function intOption(value: string): number {
  const n = Number(value);
  if (value.trim() === '' || !Number.isFinite(n)) throw new InvalidArgumentError(`ожидалось число, получено «${value}»`);
  return n;
}
