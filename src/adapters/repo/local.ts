import { SboxError } from '../../core/errors.js';
import { registerRepoHost, type PullRequestComment, type PullRequestRef, type RepoHost } from '../../core/repo-host.js';
import { GitOps } from './git.js';

/** Локальный адаптер: только git, без пул-реквестов. Для interactive-режима и тестов. */
export class LocalRepoHost implements RepoHost {
  readonly name = 'local';
  readonly git: GitOps;

  constructor(root: string) {
    this.git = new GitOps(root);
  }

  currentBranch(): string {
    return this.git.currentBranch();
  }
  ensureBranch(name: string, from: string): void {
    this.git.ensureBranch(name, from);
  }
  findCommitByIntent(intentKey: string): string | null {
    return this.git.findCommitByIntent(intentKey);
  }
  commitAll(message: string, intentKey: string): string {
    return this.git.commitAllWithMessage(message, intentKey);
  }
  push(branch: string): void {
    if (this.git.hasRemote()) this.git.push(branch);
  }
  async findPullRequest(): Promise<PullRequestRef | null> {
    return null;
  }
  async openPullRequest(): Promise<PullRequestRef> {
    throw new SboxError('NO_PR_SUPPORT', 'Локальный адаптер не создаёт пул-реквесты.', 'Задайте repo.adapter: github.');
  }
  async updatePullRequest(pr: PullRequestRef): Promise<PullRequestRef> {
    return pr;
  }
  async readComments(): Promise<PullRequestComment[]> {
    return [];
  }
  async postComment(): Promise<void> {
    /* нет канала */
  }
  async isMerged(): Promise<boolean> {
    return false;
  }
}

registerRepoHost('local', (root) => new LocalRepoHost(root));
