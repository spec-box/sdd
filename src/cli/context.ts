import { loadConfig, type Config } from '../core/config.js';
import { requireProjectRoot } from '../core/paths.js';
import { createSpecAdapter, type SpecAdapter } from '../core/spec-adapter.js';
import { resolveChange, type Change } from '../core/change.js';
import '../adapters/spec/index.js';
import '../adapters/runner/index.js';
import '../adapters/repo/index.js';

export interface ProjectContext {
  root: string;
  config: Config;
  adapter: SpecAdapter;
}

export function projectContext(cwd?: string): ProjectContext {
  const root = requireProjectRoot(cwd);
  const config = loadConfig(root);
  return { root, config, adapter: createSpecAdapter(root, config) };
}

export function changeContext(cwd: string | undefined, id?: string): ProjectContext & { dir: string; change: Change } {
  const ctx = projectContext(cwd);
  const { dir, change } = resolveChange(ctx.root, ctx.config, id);
  return { ...ctx, dir, change };
}
