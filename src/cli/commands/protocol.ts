import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { nextRunId, saveChange } from '../../core/change.js';
import { GATES, type Gate } from '../../core/config.js';
import { SboxError } from '../../core/errors.js';
import { buildPacket } from '../../core/packet.js';
import { exists, readText, toPosix, writeText } from '../../core/paths.js';
import { approveGate, isRoleName, nextStep, rejectGate, ROLE_BY_PHASE, type Role } from '../../core/phases.js';
import { applyReport } from '../../core/report.js';
import { artifactStates, loadWorkflow } from '../../core/schema.js';
import { changeContext } from '../context.js';
import { emit, emitError, formatDiagnostics } from '../output.js';

type Globals = { json: boolean; cwd?: string };

export function registerProtocol(program: Command): void {
  program
    .command('next')
    .description('Следующий шаг изменения: пакет для роли, гейт, доставка или ожидание')
    .option('--change <id>', 'идентификатор изменения')
    .option('--brief', 'не печатать пакет целиком: только роль, фаза, путь к пакету и команда отчёта')
    .action(async (opts: { change?: string; brief?: boolean }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as Globals;
      try {
        const ctx = changeContext(g.cwd, opts.change);
        const step = nextStep(ctx.change, ctx.config);
        if (step.kind === 'role') {
          if (ctx.change.phase === 'intake') {
            ctx.change.phase = 'research';
            saveChange(ctx.dir, ctx.change);
          }
          const truthSources = (await ctx.adapter.readTruth()).map((c) => c.source ?? c.id);
          const packet = buildPacket({ ...ctx, role: step.role, phase: step.phase, truthSources });
          const packetFile = path.join(ctx.dir, 'runs', packet.runId, 'packet.json');
          writeText(packetFile, JSON.stringify(packet, null, 2));
          const rel = toPosix(path.relative(ctx.root, packetFile));
          const brief = { kind: 'role' as const, role: step.role, phase: step.phase, runId: packet.runId, packetFile: rel, resultFile: packet.resultFile, objective: packet.objective, feedback: packet.feedback, report: packet.commands.report };
          if (opts.brief) {
            emit(g, brief, (d) => [`Шаг: роль ${d.role}, фаза ${d.phase}`, `Пакет: ${d.packetFile}`, `Цель: ${d.objective}`, ...(d.feedback ? [`Фидбэк: ${d.feedback.slice(0, 300)}`] : []), `Отчёт: ${d.report}`].join('\n'));
            return;
          }
          emit(g, { ...brief, packet }, (d) =>
            [`Шаг: роль ${d.role}, фаза ${d.phase}`, `Пакет: ${d.packetFile}`, `Цель: ${d.objective}`, `Отчёт: ${d.report}`].join('\n'),
          );
          return;
        }
        if (step.kind === 'gate') {
          const states = artifactStates(loadWorkflow(ctx.root), ctx.change, ctx.dir);
          const review = states.filter((s) => s.existing.length > 0).map((s) => ({ id: s.id, files: s.existing.map((f) => toPosix(path.relative(ctx.root, f))) }));
          const questions = pendingQuestions(ctx.change);
          emit(g, { kind: 'gate', gate: step.gate, phase: step.phase, review, questions, approve: `sbox approve ${step.gate} --change ${ctx.change.id} --by <user>`, reject: `sbox reject ${step.gate} --change ${ctx.change.id} --comment "<замечание>"` }, (d) =>
            [`Гейт ${d.gate}: нужно решение человека.`, 'Посмотрите:', ...d.review.flatMap((r) => r.files.map((f) => `  ${f}`)), ...(d.questions.length ? ['Вопросы:', ...d.questions.map((q) => `  ${q}`)] : []), `Утвердить: ${d.approve}`, `Отклонить: ${d.reject}`].join('\n'),
          );
          return;
        }
        if (step.kind === 'deliver') {
          emit(g, { kind: 'deliver', archive: `sbox archive --change ${ctx.change.id}` }, (d) => `Изменение готово к доставке. Архивация: ${d.archive}`);
          return;
        }
        if (step.kind === 'wait') {
          emit(g, { kind: 'wait', status: step.status, blocker: step.blocker }, (d) => `Ожидание: статус ${d.status}${d.blocker ? `, блокер ${d.blocker.category}: ${d.blocker.message}` : ''}`);
          return;
        }
        emit(g, { kind: 'done' }, () => 'Изменение завершено.');
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });

  program
    .command('report')
    .description('Принять ответ роли и перевести изменение дальше')
    .requiredOption('--role <role>', 'роль')
    .option('--file <path>', 'файл с ответом роли; по умолчанию runs/<следующий запуск>/result.md')
    .option('--change <id>', 'идентификатор изменения')
    .option('--phase <phase>', 'фаза, если отличается от текущей')
    .option('--runner <name>', 'адаптер среды')
    .option('--model <name>', 'модель')
    .option('--session <id>', 'идентификатор сессии агента')
    .action(async (opts: { role: string; file?: string; change?: string; phase?: string; runner?: string; model?: string; session?: string }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as Globals;
      try {
        const ctx = changeContext(g.cwd, opts.change);
        if (!isRoleName(opts.role)) throw new SboxError('BAD_ROLE', `Неизвестная роль ${opts.role}`);
        const step = nextStep(ctx.change, ctx.config);
        const phase = (opts.phase as typeof ctx.change.phase | undefined) ?? (step.kind === 'role' ? step.phase : ctx.change.phase);
        const expected = ROLE_BY_PHASE[phase];
        if (expected && expected !== opts.role) throw new SboxError('ROLE_MISMATCH', `Фаза ${phase} ожидает роль ${expected}, а не ${opts.role}.`);
        const file = opts.file ? path.resolve(opts.file) : path.join(ctx.dir, 'runs', nextRunId(ctx.change), 'result.md');
        if (!exists(file)) throw new SboxError('NO_FILE', `Нет файла ${file}`, 'Роль пишет ответ в resultFile из пакета; укажите --file, если ответ лежит в другом месте.');
        const outcome = await applyReport({ ...ctx, role: opts.role as Role, phase, markdown: readText(file), adapter: ctx.adapter, receipt: { runner: opts.runner, model: opts.model, session: opts.session } });
        const rejected = outcome.diagnostics.some((d) => d.severity === 'error');
        emit(g, { runId: outcome.runId, status: outcome.result.status, phaseCompleted: outcome.phaseCompleted, accepted: !rejected, diagnostics: outcome.diagnostics, change: { phase: ctx.change.phase, status: ctx.change.status, blocker: ctx.change.blocker }, next: outcome.next }, (d) =>
          [`Запуск ${d.runId}: статус роли «${d.status}», ${d.accepted ? (d.phaseCompleted ? 'фаза завершена' : 'фаза не завершена') : 'отчёт не принят'}`, formatDiagnostics(d.diagnostics), `Изменение: фаза ${d.change.phase}, статус ${d.change.status}`, `Дальше: ${JSON.stringify(d.next)}`].join('\n'),
        );
        if (rejected) process.exitCode = 1;
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });

  program
    .command('approve <gate>')
    .description('Утвердить гейт (proposal | plan | tests)')
    .option('--change <id>')
    .option('--by <user>', 'кто утвердил', process.env.USER ?? 'human')
    .option('--comment <text>')
    .option('--answer <pairs...>', 'ответы на вопросы: Q1=B Q2=A')
    .action((gate: string, opts: { change?: string; by: string; comment?: string; answer?: string[] }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as Globals;
      try {
        const ctx = changeContext(g.cwd, opts.change);
        assertGate(gate);
        const answers = Object.fromEntries((opts.answer ?? []).map((p) => { const [k, ...v] = p.split('='); return [k!, v.join('=')]; }));
        approveGate(ctx.change, gate, opts.by, opts.comment, Object.keys(answers).length ? answers : undefined);
        saveChange(ctx.dir, ctx.change);
        emit(g, { gate, phase: ctx.change.phase, status: ctx.change.status, next: nextStep(ctx.change, ctx.config) }, (d) => `Гейт ${d.gate} утверждён. Фаза ${d.phase}, статус ${d.status}.`);
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });

  program
    .command('reject <gate>')
    .description('Отклонить гейт с замечанием')
    .option('--change <id>')
    .option('--by <user>', 'кто отклонил', process.env.USER ?? 'human')
    .requiredOption('--comment <text>', 'замечание для планировщика или тестировщика')
    .action((gate: string, opts: { change?: string; by: string; comment: string }, cmd: Command) => {
      const g = cmd.optsWithGlobals() as Globals;
      try {
        const ctx = changeContext(g.cwd, opts.change);
        assertGate(gate);
        rejectGate(ctx.change, gate, opts.by, opts.comment);
        saveChange(ctx.dir, ctx.change);
        emit(g, { gate, phase: ctx.change.phase, status: ctx.change.status, next: nextStep(ctx.change, ctx.config) }, (d) => `Гейт ${d.gate} отклонён. Возврат в фазу ${d.phase}.`);
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });
}

function assertGate(gate: string): asserts gate is Gate {
  if (!(GATES as readonly string[]).includes(gate)) throw new SboxError('BAD_GATE', `Неизвестный гейт ${gate}; допустимы: ${GATES.join(', ')}`);
}

function pendingQuestions(change: { runs: { role: string; result?: string }[] }): string[] {
  // Вопросы planner лежат в его последнем ответе; для человека их достаточно показать ссылкой на design.md.
  return [];
}

export { fs };
