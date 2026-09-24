import fs from 'node:fs';
import path from 'node:path';
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { registerRunner, type AgentRunner, type RunFailure, type RunRequest, type RunResponse } from '../../core/runner.js';
import type { Config } from '../../core/config.js';

const CAPACITY_RE = /(rate limit|overloaded|capacity|529|429)/i;
const TRANSPORT_RE = /(ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|network|fetch failed|connection)/i;

/**
 * Адаптер среды Claude через Claude Agent SDK (docs/design.md, раздел 11).
 * События сессии пишутся в JSONL вне репозитория, ответ читается из файла роли или из последнего сообщения.
 */
export class ClaudeRunner implements AgentRunner {
  readonly name = 'claude';
  readonly supportsResume = true;

  constructor(private readonly options: Config['runner']['claude']) {}

  async run(req: RunRequest): Promise<RunResponse> {
    fs.mkdirSync(req.stateDir, { recursive: true });
    const eventsPath = path.join(req.stateDir, 'events.jsonl');
    const stderrPath = path.join(req.stateDir, 'stderr.log');
    const events = fs.createWriteStream(eventsPath, { flags: 'a' });
    const stderr = fs.createWriteStream(stderrPath, { flags: 'a' });
    const started = new Date().toISOString();
    const abort = new AbortController();
    let finishedBy: RunFailure | null = null;
    const onAbort = () => {
      finishedBy = 'stopped';
      abort.abort();
    };
    req.signal.addEventListener('abort', onAbort);
    let lastProgress = Date.now();
    const hard = setTimeout(() => {
      finishedBy = 'timeout';
      abort.abort();
    }, req.timeoutMs);
    const idle = setInterval(() => {
      if (Date.now() - lastProgress > req.idleTimeoutMs) {
        finishedBy = 'timeout';
        abort.abort();
      }
    }, 5000);

    const tools = req.readOnly ? this.options.readOnlyTools : this.options.allowedTools;
    const options: Options = {
      cwd: req.cwd,
      model: req.model,
      abortController: abort,
      allowedTools: tools,
      permissionMode: req.readOnly ? 'default' : this.options.permissionMode,
      ...(req.resumeSession ? { resume: req.resumeSession } : {}),
      ...(this.options.executable ? { pathToClaudeCodeExecutable: this.options.executable } : {}),
      ...(this.options.maxBudgetUsd ? { maxBudgetUsd: this.options.maxBudgetUsd } : {}),
      ...(this.options.maxTurns ? { maxTurns: this.options.maxTurns } : {}),
      ...(req.effort ? { effort: req.effort as Options['effort'] } : {}),
      env: { ...process.env, ...(req.env ?? {}) } as Record<string, string>,
      stderr: (data: string) => {
        stderr.write(data);
      },
    };

    let resultText: string | null = null;
    let session: string | undefined;
    let costUsd: number | undefined;
    let errorText = '';
    let isError = false;
    try {
      for await (const message of query({ prompt: req.prompt, options }) as AsyncIterable<SDKMessage>) {
        lastProgress = Date.now();
        events.write(`${JSON.stringify(summarize(message))}\n`);
        if (message.type === 'system' && 'session_id' in message) session = (message as { session_id: string }).session_id;
        if (message.type === 'result') {
          session = (message as { session_id?: string }).session_id ?? session;
          costUsd = (message as { total_cost_usd?: number }).total_cost_usd;
          if (message.subtype === 'success') resultText = (message as { result: string }).result;
          else {
            isError = true;
            errorText = `${message.subtype}: ${JSON.stringify((message as { errors?: unknown }).errors ?? '')}`.slice(0, 500);
          }
        }
      }
    } catch (e) {
      errorText = (e as Error).message;
      isError = true;
    } finally {
      clearTimeout(hard);
      clearInterval(idle);
      req.signal.removeEventListener('abort', onAbort);
      events.end();
      stderr.end();
    }
    const finished = new Date().toISOString();
    const base = { started, finished, eventsPath, stderrPath, session, costUsd, exitCode: isError ? 1 : 0 };
    if (finishedBy === 'stopped') return { ...base, usable: false, markdown: null, failure: 'stopped', failureMessage: 'остановлено' };
    if (finishedBy === 'timeout') return { ...base, usable: false, markdown: null, failure: 'timeout', failureMessage: 'таймаут запуска или бездействия' };
    let markdown: string | null = null;
    if (fs.existsSync(req.resultFile)) markdown = fs.readFileSync(req.resultFile, 'utf8');
    else if (resultText && resultText.trim()) markdown = resultText;
    if (markdown && markdown.trim()) return { ...base, usable: true, markdown };
    const failure: RunFailure = CAPACITY_RE.test(errorText) ? 'capacity' : TRANSPORT_RE.test(errorText) ? 'transport' : isError ? 'tool' : 'no-result';
    return { ...base, usable: false, markdown: null, failure, failureMessage: errorText.slice(0, 500) };
  }
}

/** Компактная запись события без содержимого файлов и длинных текстов. */
function summarize(message: SDKMessage): Record<string, unknown> {
  const m = message as Record<string, unknown>;
  const out: Record<string, unknown> = { at: new Date().toISOString(), type: m.type };
  if (typeof m.subtype === 'string') out.subtype = m.subtype;
  if (m.type === 'assistant' && m.message && typeof m.message === 'object') {
    const content = (m.message as { content?: { type: string; name?: string; text?: string }[] }).content ?? [];
    out.content = content.map((c) => (c.type === 'tool_use' ? `tool:${c.name}` : c.type === 'text' ? `text:${(c.text ?? '').length}` : c.type));
  }
  if (m.type === 'result') {
    out.num_turns = m.num_turns;
    out.total_cost_usd = m.total_cost_usd;
    out.is_error = m.is_error;
  }
  return out;
}

registerRunner('claude', (_root: string, config: Config) => new ClaudeRunner(config.runner.claude));
