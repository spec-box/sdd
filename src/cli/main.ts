import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { packageRoot } from '../core/paths.js';
import { registerArtifacts } from './commands/artifacts.js';
import { registerChange } from './commands/change.js';
import { registerDoctor } from './commands/doctor.js';
import { registerHost } from './commands/host.js';
import { registerInit } from './commands/init.js';
import { registerProtocol } from './commands/protocol.js';
import { registerSpec } from './commands/spec.js';
import { registerRun } from './commands/run.js';
import { registerChangeset } from './commands/changeset.js';
import { registerDeliver } from './commands/deliver.js';
import { registerCoverage } from './commands/coverage.js';
import { registerCi } from './commands/ci.js';
import { registerPrompt } from './commands/prompt.js';
import { registerMetrics } from './commands/metrics.js';
import { registerWiring } from './commands/wiring.js';

function readVersion(): string {
  try {
    return (JSON.parse(fs.readFileSync(path.join(packageRoot(), 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('sbox')
    .description('@spec-box/sdd: автономная реализация продуктовых фич ИИ-агентами')
    .version(readVersion())
    .option('--json', 'один JSON-документ в stdout', false)
    .option('--cwd <dir>', 'корень проекта или каталог внутри него');
  registerInit(program);
  registerDoctor(program);
  registerHost(program);
  registerChange(program);
  registerProtocol(program);
  registerArtifacts(program);
  registerSpec(program);
  registerRun(program);
  registerChangeset(program);
  registerDeliver(program);
  registerCoverage(program);
  registerCi(program);
  registerPrompt(program);
  registerMetrics(program);
  registerWiring(program);
  return program;
}

export async function main(argv: string[]): Promise<void> {
  await buildProgram().parseAsync(argv);
}

const invokedDirectly = process.argv[1] && /main\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  main(process.argv).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
