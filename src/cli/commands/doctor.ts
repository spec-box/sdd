import type { Command } from 'commander';
import { hasErrors } from '../../core/diagnostics.js';
import { doctorDocs } from '../../core/project-docs.js';
import { doctorWiki } from '../../core/wiki.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from '../../core/config.js';
import type { Diagnostic } from '../../core/diagnostics.js';
import { projectContext } from '../context.js';
import { emit, emitError, formatDiagnostics } from '../output.js';

export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .description('Проверить проектную документацию и конфиг (структурный уровень)')
    .action(async (_opts: unknown, cmd: Command) => {
      const g = cmd.optsWithGlobals() as { json: boolean; cwd?: string };
      try {
        const ctx = projectContext(g.cwd);
        const diagnostics = doctorDocs(ctx.root, ctx.config);
        try {
          const truth = await ctx.adapter.readTruth();
          diagnostics.push({ severity: 'info', code: 'SPEC_TRUTH', message: `Истина спецификаций: ${truth.length} capability через адаптер ${ctx.adapter.name}` });
        } catch (e) {
          diagnostics.push({ severity: 'error', code: 'SPEC_TRUTH', message: (e as Error).message });
        }
        diagnostics.push(...doctorWiki(ctx.root, ctx.config));
        diagnostics.push(...runnerReadiness(ctx.config));
        const ok = !hasErrors(diagnostics);
        emit(g, { healthy: ok, diagnostics }, (d) => `${formatDiagnostics(d.diagnostics)}\n\n${d.healthy ? 'Документация пригодна для запуска.' : 'Есть ошибки: исправьте их перед запуском изменений.'}`);
        if (!ok) process.exitCode = 1;
      } catch (e) {
        emitError(g, e);
        process.exitCode = 1;
      }
    });
}

/** Готовность сред запуска: ключи и исполняемые файлы. Только информационные сообщения и предупреждения. */
function runnerReadiness(config: Config): Diagnostic[] {
  const out: Diagnostic[] = [];
  const hasApiKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasCloud = Boolean(process.env.CLAUDE_CODE_USE_BEDROCK || process.env.CLAUDE_CODE_USE_VERTEX);
  const hasLogin = fs.existsSync(path.join(os.homedir(), '.claude'));
  if (hasApiKey || hasCloud) out.push({ severity: 'info', code: 'RUNNER_CLAUDE', message: `Среда claude: аутентификация через ${hasApiKey ? 'ANTHROPIC_API_KEY' : 'облачного провайдера'}` });
  else if (hasLogin) out.push({ severity: process.env.CI ? 'warning' : 'info', code: 'RUNNER_CLAUDE', message: 'Среда claude: API-ключа нет, будет использован вход Claude Code этой машины', fix: process.env.CI ? 'В CI и для командных запусков используйте ANTHROPIC_API_KEY: подписочные учётные данные нельзя передавать от имени других пользователей.' : undefined });
  else out.push({ severity: 'warning', code: 'RUNNER_CLAUDE', message: 'Среда claude: нет ни ANTHROPIC_API_KEY, ни входа Claude Code', fix: 'Задайте ANTHROPIC_API_KEY или выполните `claude` и войдите.' });
  const codex = config.runner.codex.executable;
  const codexOk = codex.includes('/') ? fs.existsSync(codex) : (process.env.PATH ?? '').split(path.delimiter).some((p) => fs.existsSync(path.join(p, codex)));
  out.push({ severity: config.runner.default === 'codex' && !codexOk ? 'error' : 'info', code: 'RUNNER_CODEX', message: codexOk ? `Среда codex: ${codex}` : `Среда codex: исполняемый файл ${codex} не найден`, ...(codexOk ? {} : { fix: 'Укажите runner.codex.executable, например /Applications/ChatGPT.app/Contents/Resources/codex, или установите @openai/codex.' }) });
  return out;
}
