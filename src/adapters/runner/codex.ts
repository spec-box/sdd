import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SboxError } from '../../core/errors.js';
import { assetsDir } from '../../core/paths.js';
import { jsonAnswerToMarkdown } from '../../core/result.js';
import { registerRunner, type AgentRunner, type RunFailure, type RunRequest, type RunResponse } from '../../core/runner.js';
import type { Config } from '../../core/config.js';

const REQUIRED_FLAGS = ['--output-schema', '--output-last-message', '--json', '--cd', '--model'];
const CAPACITY_RE = /(rate limit|capacity|overloaded|too many requests|429|insufficient_quota)/i;
const TRANSPORT_RE = /(ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|network|connection (reset|refused|closed)|websocket)/i;

/**
 * Адаптер среды Codex CLI: рецепт вызова повторяет Codex Tracker RCA + Arc Suite
 * (docs/design.md, раздел 11). Промпт подаётся на stdin, ответ читается из файла последнего сообщения.
 */
export class CodexRunner implements AgentRunner {
  readonly name = 'codex';
  readonly supportsResume = false;
  private capabilities: { ok: boolean; missing: string[]; version: string } | null = null;

  constructor(
    private readonly executable: string,
    private readonly options: { sandboxWrite: string; sandboxRead: string; approvalPolicy: string; extraConfig: string[] },
  ) {}

  probe(): { ok: boolean; missing: string[]; version: string } {
    if (this.capabilities) return this.capabilities;
    let help = '';
    let version = '';
    try {
      version = execFileSync(this.executable, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      help = execFileSync(this.executable, ['exec', '--help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
      throw new SboxError('CODEX_UNAVAILABLE', `Не удалось запустить ${this.executable}: ${(e as Error).message}`, 'Установите Codex CLI или укажите runner.codex.executable.');
    }
    const missing = REQUIRED_FLAGS.filter((f) => !help.includes(f));
    this.capabilities = { ok: missing.length === 0, missing, version };
    return this.capabilities;
  }

  async run(req: RunRequest): Promise<RunResponse> {
    const caps = this.probe();
    if (!caps.ok) throw new SboxError('CODEX_CAPABILITY', `Codex ${caps.version} не поддерживает: ${caps.missing.join(', ')}`);
    fs.mkdirSync(req.stateDir, { recursive: true });
    const eventsPath = path.join(req.stateDir, 'events.jsonl');
    const stderrPath = path.join(req.stateDir, 'stderr.log');
    const lastMessage = path.join(req.stateDir, 'last-message.json');
    const schema = path.join(assetsDir(), 'schema', 'sbox-answer.schema.json');
    const args = [
      'exec',
      '--cd', req.cwd,
      '--model', req.model,
      '--skip-git-repo-check',
      '--json',
      '--output-schema', schema,
      '--output-last-message', lastMessage,
      '-c', `model_reasoning_effort="${req.effort ?? 'medium'}"`,
      '-c', 'agents.enabled=false',
      '--sandbox', req.readOnly ? this.options.sandboxRead : this.options.sandboxWrite,
      '-c', `approval_policy="${this.options.approvalPolicy}"`,
      '-c', 'approvals_reviewer="auto_review"',
      ...this.options.extraConfig.flatMap((c) => ['-c', c]),
    ];
    const prompt = `${req.prompt}\n\nПоследнее сообщение верни строго как JSON-объект по схеме вывода: { "markdown": <полный ответ в Markdown>, "result": <содержимое блока sbox-result как объект> }.`;
    const started = new Date().toISOString();
    return new Promise<RunResponse>((resolve) => {
      const events = fs.createWriteStream(eventsPath, { flags: 'a' });
      const stderr = fs.createWriteStream(stderrPath, { flags: 'a' });
      const child = spawn(this.executable, args, { cwd: req.cwd, env: { ...process.env, ...(req.env ?? {}) }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let lastProgress = Date.now();
      let finishedBy: RunFailure | null = null;
      let stderrText = '';
      const killGroup = (sig: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, sig);
        } catch {
          /* группа уже завершилась */
        }
      };
      const onAbort = () => {
        finishedBy = 'stopped';
        killGroup('SIGTERM');
        setTimeout(() => killGroup('SIGKILL'), 5000).unref();
      };
      const hard = setTimeout(() => {
        finishedBy = 'timeout';
        killGroup('SIGTERM');
        setTimeout(() => killGroup('SIGKILL'), 5000).unref();
      }, req.timeoutMs);
      const idle = setInterval(() => {
        if (Date.now() - lastProgress > req.idleTimeoutMs) {
          finishedBy = 'timeout';
          killGroup('SIGTERM');
        }
      }, 5000);
      const finish = (code: number | null) => {
        clearInterval(idle);
        clearTimeout(hard);
        req.signal.removeEventListener('abort', onAbort);
        events.end();
        stderr.end();
        const finished = new Date().toISOString();
        const base = { started, finished, eventsPath, stderrPath, exitCode: code };
        if (finishedBy === 'stopped') return resolve({ ...base, usable: false, markdown: null, failure: 'stopped', failureMessage: 'остановлено' });
        if (finishedBy === 'timeout') return resolve({ ...base, usable: false, markdown: null, failure: 'timeout', failureMessage: 'таймаут запуска или бездействия' });
        let markdown: string | null = null;
        if (fs.existsSync(req.resultFile)) markdown = fs.readFileSync(req.resultFile, 'utf8');
        else if (fs.existsSync(lastMessage)) {
          const raw = fs.readFileSync(lastMessage, 'utf8');
          try {
            markdown = jsonAnswerToMarkdown(JSON.parse(raw));
          } catch {
            markdown = raw;
          }
        }
        if (markdown && markdown.trim()) return resolve({ ...base, usable: true, markdown });
        const failure: RunFailure = CAPACITY_RE.test(stderrText) ? 'capacity' : TRANSPORT_RE.test(stderrText) ? 'transport' : code === 0 ? 'no-result' : 'tool';
        resolve({ ...base, usable: false, markdown: null, failure, failureMessage: stderrText.trim().split('\n').slice(-3).join(' | ').slice(0, 500) });
      };
      req.signal.addEventListener('abort', onAbort);
      child.stdout.on('data', (chunk: Buffer) => {
        lastProgress = Date.now();
        events.write(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderrText += chunk.toString();
        stderr.write(chunk);
      });
      child.on('error', (e) => {
        stderrText += `\n${e.message}`;
        finish(null);
      });
      child.on('close', (code) => finish(code));
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}

registerRunner('codex', (_root: string, config: Config) => {
  const o = config.runner.codex;
  return new CodexRunner(o.executable, { sandboxWrite: o.sandboxWrite, sandboxRead: o.sandboxRead, approvalPolicy: o.approvalPolicy, extraConfig: o.extraConfig });
});
