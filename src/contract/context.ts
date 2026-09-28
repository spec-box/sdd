import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { specSchema, type ContractConfig } from './config.js';
import { createSpecAdapter } from './adapter.js';
import { SboxError } from '../core/errors.js';
import '../adapters/spec/index.js';

export interface ContractOptions { cwd?: string; format?: string }
export function contractContext(options: ContractOptions = {}) {
  let root = path.resolve(options.cwd ?? process.cwd());
  for (;;) {
    if (['.sbox/config.yaml', '.sbox-contract.yaml', '.tms.json', 'openspec/specs'].some(p => fs.existsSync(path.join(root, p)))) break;
    const parent = path.dirname(root);
    if (parent === root) { root = path.resolve(options.cwd ?? process.cwd()); break; }
    root = parent;
  }
  let raw: Record<string, unknown> | undefined;
  const file = ['.sbox/config.yaml', '.sbox-contract.yaml'].map(f => path.join(root, f)).find(f => fs.existsSync(f));
  if (file) {
    try { raw = YAML.parse(fs.readFileSync(file, 'utf8'))?.spec; }
    catch (e) { throw new SboxError('CONTRACT_CONFIG', `Не разбирается ${file}: ${(e as Error).message}`); }
    if (!raw || typeof raw !== 'object') throw new SboxError('CONTRACT_CONFIG', `Нет секции spec в ${file}`);
  }
  const hasTms = fs.existsSync(path.join(root, '.tms.json'));
  const hasOpenSpec = fs.existsSync(path.join(root, 'openspec/specs'));
  if (!raw && !options.format && hasTms && hasOpenSpec) throw new SboxError('CONTRACT_FORMAT', 'Найдены spec-box и OpenSpec; укажите --format.');
  const parsed = specSchema.safeParse({ ...raw, adapter: options.format ?? raw?.adapter ?? (hasOpenSpec ? 'openspec' : 'spec-box') });
  if (!parsed.success) throw new SboxError('CONTRACT_CONFIG', parsed.error.message);
  const config: ContractConfig = { spec: parsed.data };
  if (config.spec.adapter === 'spec-box' && !config.spec['spec-box'].files && !hasTms && !raw) config.spec['spec-box'].files = ['specs/**/*.spec-box.yml'];
  return { root, config, adapter: createSpecAdapter(root, config) };
}

export function initContract(cwd: string, format = 'spec-box') {
  const root = path.resolve(cwd);
  if (fs.existsSync(path.join(root, '.sbox/config.yaml'))) throw new SboxError('CONTRACT_CONFIG_EXISTS', 'В проекте SDD уже есть spec в .sbox/config.yaml; используйте его.');
  const parsed = specSchema.safeParse({ adapter: format });
  if (!parsed.success) throw new SboxError('CONTRACT_FORMAT', 'Формат должен быть spec-box или openspec');
  const spec = parsed.data;
  if (format === 'spec-box' && !fs.existsSync(path.join(root, '.tms.json'))) spec['spec-box'].files = ['specs/**/*.spec-box.yml'];
  fs.mkdirSync(root, { recursive: true });
  const target = path.join(root, '.sbox-contract.yaml');
  fs.writeFileSync(target, YAML.stringify({ spec }), { flag: 'wx' });
  fs.mkdirSync(path.join(root, format === 'openspec' ? 'openspec/specs' : 'specs'), { recursive: true });
  return { config: target, format };
}
