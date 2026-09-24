/** Ошибка инструмента с машиночитаемым кодом: попадает в JSON-конверт диагностики. */
export class SboxError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly fix?: string,
  ) {
    super(message);
    this.name = 'SboxError';
  }
}
