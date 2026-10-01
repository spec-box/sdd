import fs from 'node:fs';
import path from 'node:path';
import { Command, CommanderError } from 'commander';
import { contractContext, initContract } from './context.js';
import { ContractService, contractIndex } from './service.js';
import { packageVersion } from '../core/paths.js';
import { SboxError } from '../core/errors.js';
import { attachHelpCommand } from '../cli/help-command.js';
import { hasErrors } from '../core/diagnostics.js';

export function buildProgram(): Command {
  const program = new Command().name('sbox-contract').description('Контракт поведения продукта: требования, сценарии и дельты').version(packageVersion())
    .option('--cwd <dir>', 'каталог проекта', process.cwd()).option('--format <format>', 'spec-box или openspec').option('--json', 'машиночитаемый JSON');
  const service = () => { const ctx = contractContext(program.opts()); return new ContractService(ctx.root, ctx.adapter); };
  const emit = (value: unknown) => console.log(program.opts().json ? JSON.stringify({ ok: true, data: value }) : typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  const deltaDir = (dir: string) => {
    const absolute = path.resolve(program.opts().cwd, dir);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) throw new SboxError('CONTRACT_DELTA_DIR', `Нет каталога дельты: ${absolute}`);
    return absolute;
  };
  const inspectDelta = async (dir: string) => {
    const svc = service();
    const plan = await svc.inspect(deltaDir(dir));
    if (!plan.deltas.length) throw new SboxError('CONTRACT_DELTA_EMPTY', 'В каталоге нет файлов дельты выбранного формата.');
    return { svc, plan };
  };
  program.command('init').description('Создать автономную конфигурацию без SDD').action(() => emit(initContract(program.opts().cwd, program.opts().format)));
  program.command('index').description('Индекс capability').action(async () => emit(contractIndex(await service().adapter.readTruth())));
  program.command('show <id>').description('Прочитать capability целиком').action(async id => emit(await service().show(id)));
  program.command('search <query>').description('Найти требования и сценарии').option('--limit <n>', 'максимум результатов', '10').action(async (query, opts) => emit(await service().search(query, Number(opts.limit))));
  program.command('instructions').description('Формат дельт выбранного адаптера').action(() => emit(service().adapter.instructions()));
  program.command('delta').description('Подготовка каталога дельты').command('init <dir>').description('Создать пустой каталог и инструкцию выбранного формата').action(dir => {
    const svc = service();
    const target = path.resolve(program.opts().cwd, dir);
    if (fs.existsSync(target)) throw new SboxError('CONTRACT_DELTA_EXISTS', `Каталог уже существует: ${target}`);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'README.md'), svc.adapter.instructions(), { flag: 'wx' });
    emit({ dir: target, instructions: path.join(target, 'README.md'), format: svc.adapter.name });
  });
  program.command('validate').option('--delta <dir>', 'проверить дельту относительно истины').action(async opts => {
    const plan = opts.delta ? (await inspectDelta(opts.delta)).plan : await service().inspect();
    emit({ diagnostics: plan.diagnostics, revision: plan.revision });
    if (hasErrors(plan.diagnostics)) process.exitCode = 1;
  });
  program.command('diff').requiredOption('--delta <dir>', 'каталог дельты').option('--preview', 'добавить будущее состояние затронутых capability').action(async opts => {
    const { svc, plan } = await inspectDelta(opts.delta);
    const ids = new Set(plan.deltas.map(d => d.capabilityId));
    const after = opts.preview && !hasErrors(plan.diagnostics) ? svc.adapter.preview(plan.truth, plan.deltas).filter(c => ids.has(c.id)) : undefined;
    emit({ before: plan.truth.filter(c => ids.has(c.id)), deltas: plan.deltas, after, diagnostics: plan.diagnostics, revision: plan.revision });
    if (hasErrors(plan.diagnostics)) process.exitCode = 1;
  });
  program.command('apply').requiredOption('--delta <dir>', 'каталог дельты').option('--check', 'проверить без записи; получить revision').option('--if-match <revision>', 'revision из проверки, обязательна для записи').action(async opts => {
    const { svc, plan } = await inspectDelta(opts.delta);
    if (opts.check) {
      const diagnostics = [...plan.diagnostics];
      if (!hasErrors(diagnostics)) diagnostics.push(...svc.adapter.checkTruth(svc.adapter.preview(plan.truth, plan.deltas)));
      emit({ diagnostics, revision: plan.revision, targets: svc.adapter.targets(plan.truth, plan.deltas) });
      if (hasErrors(diagnostics)) process.exitCode = 1;
    } else {
      if (!opts.ifMatch) throw new SboxError('CONTRACT_REVISION', 'Сначала apply --check, затем передайте revision через --if-match.');
      emit(await svc.apply(deltaDir(opts.delta), { ifMatch: opts.ifMatch }));
    }
  });
  attachHelpCommand(program, { topic: 'contract', cwd: () => program.opts().cwd as string | undefined, emit: (payload, human) => emit(program.opts().json ? payload : human) });
  return program;
}
export async function main(argv: string[]): Promise<void> {
  const program = buildProgram();
  const commands = (cmd: Command): Command[] => [cmd, ...cmd.commands.flatMap(commands)];
  for (const cmd of commands(program)) {
    cmd.exitOverride();
    if (argv.includes('--json')) cmd.configureOutput({ writeErr: () => {} });
  }
  try { await program.parseAsync(argv); }
  catch (e) {
    if (e instanceof CommanderError && e.exitCode === 0) return;
    const error = { code: e instanceof SboxError || e instanceof CommanderError ? e.code : 'CONTRACT_ERROR', message: e instanceof Error ? e.message : String(e) };
    if (argv.includes('--json')) console.log(JSON.stringify({ ok: false, error }));
    else console.error(`${error.code}: ${error.message}`);
    process.exitCode = 1;
  }
}
