import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { SpecAdapter } from './adapter.js';
import type { Capability, SpecDelta } from './model.js';
import { SboxError } from '../core/errors.js';
import { hasErrors, type Diagnostic } from '../core/diagnostics.js';

export interface ContractPlan { truth: Capability[]; deltas: SpecDelta[]; diagnostics: Diagnostic[]; revision: string }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const contractIndex = (truth: Capability[]) => truth.map(c => ({ id: c.id, title: c.title, purpose: c.purpose, requirements: c.requirements.length, scenarios: c.requirements.reduce((n, r) => n + r.scenarios.length, 0), source: c.source }));

export class ContractService {
  constructor(readonly root: string, readonly adapter: SpecAdapter) {}
  private snapshot(files: string[], bounded = true) {
    return [...new Set(files)].sort().map(file => {
      const absolute = path.resolve(this.root, file);
      if (bounded && !absolute.startsWith(path.resolve(this.root) + path.sep)) throw new SboxError('CONTRACT_PATH', `Путь вне проекта: ${file}`);
      let current = absolute;
      while (bounded && current !== path.resolve(this.root)) {
        try { if (fs.lstatSync(current).isSymbolicLink()) throw new SboxError('CONTRACT_PATH', `Символическая ссылка: ${file}`); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        current = path.dirname(current);
      }
      return { file, content: fs.existsSync(absolute) ? fs.readFileSync(absolute).toString('base64') : null };
    });
  }
  async inspect(deltaDir?: string): Promise<ContractPlan> {
    const truth = await this.adapter.readTruth();
    const deltas = deltaDir ? await this.adapter.readDelta(deltaDir) : [];
    const diagnostics = [...this.adapter.checkTruth(truth), ...this.adapter.validate(truth, deltas)];
    const files = [...truth.flatMap(c => c.source ? [c.source] : []), ...deltas.map(d => d.source), ...this.adapter.targets(truth, deltas)];
    return { truth, deltas, diagnostics, revision: digest({ adapter: this.adapter.name, truth, deltas, files: this.snapshot(files, false) }) };
  }
  async show(id: string) {
    const cap = (await this.adapter.readTruth()).find(c => c.id === id);
    if (!cap) throw new SboxError('NO_CAPABILITY', `Capability ${id} не найдена`);
    return cap;
  }
  async search(query: string, limit = 10) {
    const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])];
    if (!words.length || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new SboxError('CONTRACT_QUERY', 'Нужен непустой запрос и limit от 1 до 100');
    const truth = await this.adapter.readTruth();
    const results = truth.flatMap(c => {
      const common = { capability: c.id, source: c.source };
      return [
        { ...common, kind: 'capability', id: c.id, title: c.title, text: c.purpose ?? '' },
        ...c.requirements.flatMap(r => [
          { ...common, kind: 'requirement', id: r.id, title: r.title, text: r.text ?? '' },
          ...r.scenarios.map(s => ({ ...common, kind: 'scenario', requirement: r.id, id: s.id, title: s.title, text: s.description ?? '' })),
        ]),
      ];
    });
    return results.map(r => ({ ...r, score: words.reduce((n, w) => n + (r.title.toLowerCase().includes(w) ? 3 : 0) + (r.text.toLowerCase().includes(w) ? 1 : 0), 0) }))
      .filter(r => r.score > 0).sort((a, b) => b.score - a.score || a.capability.localeCompare(b.capability) || a.id.localeCompare(b.id)).slice(0, limit);
  }
  /** Общая транзакция для CLI и SDD. finalize позволяет откатить истину при сбое архивации. */
  async apply(deltaDir: string | undefined, options: { ifMatch?: string; force?: boolean; finalize?: () => Promise<void> | void } = {}) {
    const lock = path.join(this.root, '.sbox-contract.lock');
    let fd: number;
    try { fd = fs.openSync(lock, 'wx'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; throw new SboxError('CONTRACT_BUSY', 'Другая операция применения активна. После аварии проверьте процесс и удалите .sbox-contract.lock.'); }
    try {
      fs.writeSync(fd, String(process.pid));
      const plan = await this.inspect(deltaDir);
      if (options.ifMatch !== undefined && options.ifMatch !== plan.revision) throw new SboxError('CONTRACT_CONFLICT', 'Истина или дельта изменилась после проверки; повторите diff/apply --check.');
      if (hasErrors(plan.diagnostics) && !options.force) throw new SboxError('DELTA_INVALID', plan.diagnostics.filter(d => d.severity === 'error').map(d => d.message).join('; '));
      const snapshot = this.snapshot(this.adapter.targets(plan.truth, plan.deltas));
      try {
        const appliedFiles = plan.deltas.length ? await this.adapter.apply(plan.truth, plan.deltas) : [];
        const diagnostics = [...plan.diagnostics];
        const post = this.adapter.checkTruth(await this.adapter.readTruth());
        diagnostics.push(...post);
        if (hasErrors(post)) throw new SboxError('TRUTH_INVALID', `Истина спецификаций после применения невалидна: ${post.map(d => d.message).join('; ')}`);
        await options.finalize?.();
        return { appliedFiles, diagnostics };
      } catch (e) {
        for (const { file, content } of snapshot) {
          const target = path.resolve(this.root, file);
          if (content === null) fs.rmSync(target, { force: true });
          else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, Buffer.from(content, 'base64')); }
        }
        throw e;
      }
    } finally { fs.closeSync(fd); fs.rmSync(lock, { force: true }); }
  }
}
