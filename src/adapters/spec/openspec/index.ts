import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import type { Config } from '../../../core/config.js';
import type { Diagnostic } from '../../../core/diagnostics.js';
import { SboxError } from '../../../core/errors.js';
import { assetsDir, exists, readText, toPosix, writeText } from '../../../core/paths.js';
import { registerSpecAdapter, type SpecAdapter } from '../../../core/spec-adapter.js';
import type { Capability, SpecDelta } from '../../../core/spec-model.js';
import { applyOpenSpecDelta, checkOpenSpecTruth, parseOpenSpecDelta, validateOpenSpecDeltas, type ParsedOpenSpecDelta } from './delta.js';
import { codeFenceMask, normalizeLineEndings, parseSpecFile, REQUIREMENT_HEADER } from './parser.js';

/**
 * Адаптер OpenSpec: истина в `<root>/specs/<capability-path>/spec.md`, дельты в родном синтаксисе OpenSpec
 * в `specs/<capability-path>/spec.md` папки изменения, применение текстовое с сохранением остальных разделов.
 */
export class OpenSpecAdapter implements SpecAdapter {
  readonly name = 'openspec';
  private lastParsed = new Map<string, ParsedOpenSpecDelta>();

  constructor(
    private readonly root: string,
    private readonly config: Config,
  ) {}

  private get specsRoot(): string {
    return path.join(this.root, this.config.spec.openspec.root, 'specs');
  }

  async readTruth(): Promise<Capability[]> {
    if (!exists(this.specsRoot)) return [];
    const files = fg.sync('**/spec.md', { cwd: this.specsRoot, onlyFiles: true, absolute: true }).sort();
    return files.map((file) => {
      const id = toPosix(path.relative(this.specsRoot, path.dirname(file)));
      return parseSpecFile(readText(file), id, toPosix(path.relative(this.root, file)));
    });
  }

  async readDelta(dir: string): Promise<SpecDelta[]> {
    if (!exists(dir)) return [];
    const truthIds = new Set((await this.readTruth()).map((c) => c.id));
    const files = fg.sync('**/spec.md', { cwd: dir, onlyFiles: true, absolute: true }).sort();
    this.lastParsed = new Map();
    return files.map((file) => {
      const id = toPosix(path.relative(dir, path.dirname(file)));
      const source = toPosix(path.relative(this.root, file));
      const parsed = parseOpenSpecDelta(readText(file), id, source, truthIds);
      this.lastParsed.set(source, parsed);
      return parsed.delta;
    });
  }

  validate(truth: Capability[], deltas: SpecDelta[]): Diagnostic[] {
    return validateOpenSpecDeltas(truth, deltas, this.lastParsed);
  }

  private targetFor(truth: Map<string, Capability>, delta: SpecDelta): string {
    const current = truth.get(delta.capabilityId);
    return current?.source ? path.join(this.root, current.source) : path.join(this.specsRoot, delta.capabilityId, 'spec.md');
  }

  targets(truth: Capability[], deltas: SpecDelta[]): string[] {
    const byId = new Map(truth.map((c) => [c.id, c]));
    return deltas.map((d) => toPosix(path.relative(this.root, this.targetFor(byId, d))));
  }

  checkTruth(truth: Capability[]): Diagnostic[] {
    const out = checkOpenSpecTruth(truth);
    // Заголовки требований вне раздела `## Requirements` парсер не видит: такие блоки молча выпадают из истины.
    for (const cap of truth) {
      if (!cap.source) continue;
      const file = path.join(this.root, cap.source);
      if (!exists(file)) continue;
      const lines = normalizeLineEndings(readText(file)).split('\n');
      const mask = codeFenceMask(lines);
      const total = lines.filter((l, idx) => !mask[idx] && REQUIREMENT_HEADER.test(l)).length;
      if (total > cap.requirements.length) {
        out.push({ severity: 'error', code: 'TRUTH_REQUIREMENT_OUTSIDE_SECTION', message: `${total - cap.requirements.length} заголовков \`### Requirement:\` лежат вне раздела \`## Requirements\` и не читаются`, target: cap.source });
      }
    }
    return out;
  }

  async apply(truth: Capability[], deltas: SpecDelta[]): Promise<string[]> {
    const byId = new Map(truth.map((c) => [c.id, c]));
    const written: string[] = [];
    for (const delta of deltas) {
      const current = byId.get(delta.capabilityId);
      const target = this.targetFor(byId, delta);
      const next = applyOpenSpecDelta(current ? readText(target) : null, delta);
      const remaining = current ? current.requirements.length - delta.ops.filter((o) => o.op === 'remove-requirement').length + delta.ops.filter((o) => o.op === 'add-requirement').length : 1;
      if (remaining <= 0 && !/###\s*Requirement:/.test(next)) {
        fs.rmSync(target, { force: true });
      } else {
        writeText(target, next);
      }
      written.push(toPosix(path.relative(this.root, target)));
    }
    return written;
  }

  instructions(): string {
    return readText(path.join(assetsDir(), 'adapters', 'openspec', 'instructions.md'));
  }
}

export function openSpecRootExists(root: string, config: Config): boolean {
  return exists(path.join(root, config.spec.openspec.root));
}

registerSpecAdapter('openspec', (root, config) => {
  if (!config.spec.openspec.root) throw new SboxError('OPENSPEC_ROOT', 'Не задан spec.openspec.root');
  return new OpenSpecAdapter(root, config);
});
