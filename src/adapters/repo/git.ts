import { execFileSync } from 'node:child_process';
import { SboxError } from '../../core/errors.js';

/** Локальные операции git, общие для адаптеров GitHub и local. */
export class GitOps {
  constructor(private readonly root: string) {}

  run(args: string[], opts: { allowFail?: boolean } = {}): string {
    try {
      return execFileSync('git', args, { cwd: this.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      if (opts.allowFail) return '';
      const err = e as { stderr?: string; message: string };
      throw new SboxError('GIT_FAILED', `git ${args.join(' ')}: ${(err.stderr ?? err.message).trim()}`);
    }
  }

  currentBranch(): string {
    return this.run(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  }

  branchExists(name: string): boolean {
    return this.run(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { allowFail: true }).trim().length > 0;
  }

  ensureBranch(name: string, from: string): void {
    if (this.currentBranch() === name) return;
    if (this.branchExists(name)) this.run(['checkout', name]);
    else this.run(['checkout', '-b', name, from]);
  }

  findCommitByIntent(intentKey: string): string | null {
    const out = this.run(['log', '--all', '--format=%H', `--grep=Sbox-Intent-Key: ${intentKey}`], { allowFail: true }).trim();
    return out ? out.split('\n')[0]! : null;
  }

  commitAll(message: string, intentKey: string): string {
    this.run(['add', '-A']);
    const staged = this.run(['diff', '--cached', '--name-only']).trim();
    if (!staged) {
      const existing = this.findCommitByIntent(intentKey);
      if (existing) return existing;
      throw new SboxError('NOTHING_TO_COMMIT', 'Нет изменений для коммита.');
    }
    const full = `${message.trimEnd()}\n\nSbox-Intent-Key: ${intentKey}\n`;
    this.run(['commit', '-q', '-F', '-'], { allowFail: false });
    void full;
    return this.run(['rev-parse', 'HEAD']).trim();
  }

  commitAllWithMessage(message: string, intentKey: string): string {
    this.run(['add', '-A']);
    const staged = this.run(['diff', '--cached', '--name-only']).trim();
    if (!staged) {
      const existing = this.findCommitByIntent(intentKey);
      if (existing) return existing;
      throw new SboxError('NOTHING_TO_COMMIT', 'Нет изменений для коммита.');
    }
    const full = `${message.trimEnd()}\n\nSbox-Intent-Key: ${intentKey}\n`;
    execFileSync('git', ['commit', '-q', '-F', '-'], { cwd: this.root, input: full, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return this.run(['rev-parse', 'HEAD']).trim();
  }

  hasRemote(name = 'origin'): boolean {
    return this.run(['remote'], { allowFail: true }).split('\n').map((l) => l.trim()).includes(name);
  }

  push(branch: string, remote = 'origin'): void {
    this.run(['push', '-u', remote, branch]);
  }

  remoteUrl(remote = 'origin'): string | null {
    const out = this.run(['remote', 'get-url', remote], { allowFail: true }).trim();
    return out || null;
  }
}

/** owner/repo из URL GitHub: https://github.com/o/r(.git) или git@github.com:o/r(.git). */
export function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}
