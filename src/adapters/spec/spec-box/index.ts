import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import type { Config } from '../../../core/config.js';
import type { Diagnostic } from '../../../core/diagnostics.js';
import { SboxError } from '../../../core/errors.js';
import { assetsDir, exists, readText, toPosix, writeText } from '../../../core/paths.js';
import { registerSpecAdapter, type SpecAdapter } from '../../../core/spec-adapter.js';
import type { Capability, SpecDelta } from '../../../core/spec-model.js';
import { applyDelta, parseDelta, validateDeltas } from './delta.js';
import { parseSpecBoxFile, serializeSpecBox } from './yaml.js';

interface TmsConfig {
  projectPath?: string;
  yml?: { files?: string[]; metaPath?: string };
}

export class SpecBoxAdapter implements SpecAdapter {
  readonly name = 'spec-box';

  constructor(
    private readonly root: string,
    private readonly config: Config,
  ) {}

  private get options() {
    return this.config.spec['spec-box'];
  }

  private readTms(): TmsConfig | null {
    const file = path.join(this.root, this.options.config);
    if (!exists(file)) return null;
    try {
      return JSON.parse(readText(file)) as TmsConfig;
    } catch (e) {
      throw new SboxError('BAD_TMS', `Не разбирается ${file}: ${(e as Error).message}`);
    }
  }

  /** База и шаблоны путей истины: из конфига инструмента, иначе из .tms.json. */
  private source(): { base: string; patterns: string[] } {
    if (this.options.files && this.options.files.length > 0) return { base: this.root, patterns: this.options.files };
    const tms = this.readTms();
    if (!tms?.yml?.files?.length) {
      throw new SboxError('NO_SPEC_FILES', 'Не заданы файлы спецификаций spec-box.', 'Укажите spec.spec-box.files в .sbox/config.yaml или yml.files в .tms.json.');
    }
    const base = tms.projectPath ? path.resolve(this.root, tms.projectPath) : this.root;
    return { base, patterns: tms.yml.files };
  }

  async readTruth(): Promise<Capability[]> {
    const { base, patterns } = this.source();
    const files = fg.sync(patterns, { cwd: base, onlyFiles: true, absolute: true }).sort();
    const caps: Capability[] = [];
    const seen = new Map<string, string>();
    for (const file of files) {
      const rel = toPosix(path.relative(this.root, file));
      const cap = parseSpecBoxFile(readText(file), rel);
      if (seen.has(cap.id)) throw new SboxError('SPEC_DUPLICATE_CODE', `code ${cap.id} повторяется: ${seen.get(cap.id)} и ${rel}`);
      seen.set(cap.id, rel);
      caps.push(cap);
    }
    return caps;
  }

  async readDelta(dir: string): Promise<SpecDelta[]> {
    if (!exists(dir)) return [];
    const truthIds = new Set((await this.readTruth()).map((c) => c.id));
    const files = fg.sync(['*.yml', '*.yaml'], { cwd: dir, onlyFiles: true, absolute: true }).sort();
    return files.map((f) => parseDelta(readText(f), toPosix(path.relative(this.root, f)), truthIds));
  }

  validate(truth: Capability[], deltas: SpecDelta[]): Diagnostic[] {
    return validateDeltas(truth, deltas);
  }

  private targetFor(truth: Map<string, Capability>, delta: SpecDelta): string {
    const current = truth.get(delta.capabilityId);
    return current?.source ? path.join(this.root, current.source) : path.join(this.root, this.options.newFile.replace('{code}', delta.capabilityId));
  }

  targets(truth: Capability[], deltas: SpecDelta[]): string[] {
    const byId = new Map(truth.map((c) => [c.id, c]));
    return deltas.map((d) => toPosix(path.relative(this.root, this.targetFor(byId, d))));
  }

  checkTruth(truth: Capability[]): Diagnostic[] {
    const out: Diagnostic[] = [];
    for (const cap of truth) {
      for (const r of cap.requirements) {
        const seen = new Map<string, number>();
        for (const s of r.scenarios) seen.set(s.title, (seen.get(s.title) ?? 0) + 1);
        for (const [title, n] of seen) if (n > 1) out.push({ severity: 'error', code: 'TRUTH_DUPLICATE_ASSERT', message: `Утверждение «${title}» в группе «${r.title}» встречается ${n} раз`, target: cap.source ?? cap.id });
      }
    }
    return out;
  }

  async apply(truth: Capability[], deltas: SpecDelta[]): Promise<string[]> {
    const byId = new Map(truth.map((c) => [c.id, c]));
    const written: string[] = [];
    for (const delta of deltas) {
      const current = byId.get(delta.capabilityId);
      const next = applyDelta(current, delta);
      const target = this.targetFor(byId, delta);
      if (next.requirements.length === 0) {
        if (fs.existsSync(target)) fs.rmSync(target);
      } else {
        writeText(target, serializeSpecBox(next));
      }
      written.push(toPosix(path.relative(this.root, target)));
    }
    return written;
  }

  instructions(): string {
    return readText(path.join(assetsDir(), 'adapters', 'spec-box', 'instructions.md'));
  }
}

registerSpecAdapter('spec-box', (root, config) => new SpecBoxAdapter(root, config));
