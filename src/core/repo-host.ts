import type { Config } from './config.js';

/** Контракт адаптера хостинга репозитория (docs/design.md, раздел 11). */
export interface PullRequestRef {
  number: number;
  url: string;
  draft: boolean;
  head: string;
  base: string;
}

export interface PullRequestComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
}

export interface DeliveryIntent {
  intentKey: string;
  changeId: string;
  branch: string;
  baseBranch: string;
  commitMessage: string;
  prTitle: string;
  prBody: string;
  draft: boolean;
}

export interface DeliveryReceipt {
  commit: string;
  pushed: boolean;
  pr: PullRequestRef | null;
  reused: { commit: boolean; pr: boolean };
}

export interface RepoHost {
  readonly name: string;
  /** Текущая ветка рабочей копии. */
  currentBranch(): string;
  /** Создать или переключиться на ветку изменения. */
  ensureBranch(name: string, from: string): void;
  /** Есть ли коммит с данным ключом intent в текущей ветке. */
  findCommitByIntent(intentKey: string): string | null;
  commitAll(message: string, intentKey: string): string;
  push(branch: string): void;
  findPullRequest(branch: string): Promise<PullRequestRef | null>;
  openPullRequest(input: { branch: string; base: string; title: string; body: string; draft: boolean }): Promise<PullRequestRef>;
  updatePullRequest(pr: PullRequestRef, patch: { title?: string; body?: string; draft?: boolean }): Promise<PullRequestRef>;
  readComments(pr: PullRequestRef, since?: string): Promise<PullRequestComment[]>;
  postComment(pr: PullRequestRef, body: string): Promise<void>;
  isMerged(pr: PullRequestRef): Promise<boolean>;
}

export type RepoHostFactory = (root: string, config: Config) => RepoHost;

const registry = new Map<string, RepoHostFactory>();

export function registerRepoHost(name: string, factory: RepoHostFactory): void {
  registry.set(name, factory);
}

export function createRepoHost(root: string, config: Config, name: string = config.repo.adapter): RepoHost {
  const factory = registry.get(name);
  if (!factory) throw new Error(`Адаптер репозитория "${name}" не зарегистрирован`);
  return factory(root, config);
}
