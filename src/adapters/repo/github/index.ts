import { SboxError } from '../../../core/errors.js';
import { registerRepoHost, type PullRequestComment, type PullRequestRef, type RepoHost } from '../../../core/repo-host.js';
import type { Config } from '../../../core/config.js';
import { GitOps, parseGitHubRemote } from '../git.js';

export interface GitHubApi {
  request(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }>;
}

/** REST-клиент GitHub на fetch с токеном из переменной окружения; без зависимости от gh. */
export class FetchGitHubApi implements GitHubApi {
  constructor(
    private readonly apiUrl: string,
    private readonly token: string,
  ) {}

  async request(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  }
}

interface GhPull {
  number: number;
  html_url: string;
  draft: boolean;
  merged: boolean;
  head: { ref: string };
  base: { ref: string };
  node_id?: string;
}

export class GitHubRepoHost implements RepoHost {
  readonly name = 'github';
  readonly git: GitOps;

  constructor(
    root: string,
    private readonly api: GitHubApi,
    private readonly owner: string,
    private readonly repo: string,
  ) {
    this.git = new GitOps(root);
  }

  private get base(): string {
    return `/repos/${this.owner}/${this.repo}`;
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
    this.git.push(branch);
  }

  private toRef(p: GhPull): PullRequestRef {
    return { number: p.number, url: p.html_url, draft: Boolean(p.draft), head: p.head.ref, base: p.base.ref };
  }

  async findPullRequest(branch: string): Promise<PullRequestRef | null> {
    const res = await this.api.request('GET', `${this.base}/pulls?state=open&head=${encodeURIComponent(`${this.owner}:${branch}`)}&per_page=5`);
    if (res.status !== 200) throw new SboxError('GITHUB_API', `GitHub GET pulls: ${res.status} ${JSON.stringify(res.json).slice(0, 200)}`);
    const list = res.json as GhPull[];
    return list.length > 0 ? this.toRef(list[0]!) : null;
  }

  async openPullRequest(input: { branch: string; base: string; title: string; body: string; draft: boolean }): Promise<PullRequestRef> {
    const res = await this.api.request('POST', `${this.base}/pulls`, { title: input.title, body: input.body, head: input.branch, base: input.base, draft: input.draft });
    if (res.status !== 201) throw new SboxError('GITHUB_API', `GitHub POST pulls: ${res.status} ${JSON.stringify(res.json).slice(0, 300)}`);
    return this.toRef(res.json as GhPull);
  }

  async updatePullRequest(pr: PullRequestRef, patch: { title?: string; body?: string; draft?: boolean }): Promise<PullRequestRef> {
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body.title = patch.title;
    if (patch.body !== undefined) body.body = patch.body;
    if (Object.keys(body).length > 0) {
      const res = await this.api.request('PATCH', `${this.base}/pulls/${pr.number}`, body);
      if (res.status !== 200) throw new SboxError('GITHUB_API', `GitHub PATCH pull: ${res.status}`);
    }
    if (patch.draft === false && pr.draft) {
      // Перевод из черновика в готовый доступен только через GraphQL.
      const node = await this.api.request('GET', `${this.base}/pulls/${pr.number}`);
      const nodeId = (node.json as GhPull).node_id;
      const gql = await this.api.request('POST', '/graphql', { query: `mutation { markPullRequestReadyForReview(input: { pullRequestId: "${nodeId}" }) { pullRequest { isDraft } } }` });
      if (gql.status !== 200) throw new SboxError('GITHUB_API', `GitHub markPullRequestReadyForReview: ${gql.status}`);
    }
    const fresh = await this.api.request('GET', `${this.base}/pulls/${pr.number}`);
    return this.toRef(fresh.json as GhPull);
  }

  async readComments(pr: PullRequestRef, since?: string): Promise<PullRequestComment[]> {
    const q = since ? `?since=${encodeURIComponent(since)}&per_page=100` : '?per_page=100';
    const res = await this.api.request('GET', `${this.base}/issues/${pr.number}/comments${q}`);
    if (res.status !== 200) throw new SboxError('GITHUB_API', `GitHub GET comments: ${res.status}`);
    return (res.json as { id: number; user: { login: string }; body: string; created_at: string }[]).map((c) => ({ id: c.id, author: c.user.login, body: c.body, createdAt: c.created_at }));
  }

  async postComment(pr: PullRequestRef, body: string): Promise<void> {
    const res = await this.api.request('POST', `${this.base}/issues/${pr.number}/comments`, { body });
    if (res.status !== 201) throw new SboxError('GITHUB_API', `GitHub POST comment: ${res.status}`);
  }

  async isMerged(pr: PullRequestRef): Promise<boolean> {
    const res = await this.api.request('GET', `${this.base}/pulls/${pr.number}`);
    return res.status === 200 && Boolean((res.json as GhPull).merged);
  }
}

export function resolveGitHubRepo(root: string, config: Config): { owner: string; repo: string } {
  const c = config.repo.github;
  if (c.owner && c.repo) return { owner: c.owner, repo: c.repo };
  const url = new GitOps(root).remoteUrl();
  const parsed = url ? parseGitHubRemote(url) : null;
  if (!parsed) throw new SboxError('GITHUB_REPO', 'Не удалось определить owner/repo GitHub.', 'Укажите repo.github.owner и repo.github.repo в .sbox/config.yaml или настройте remote origin.');
  return parsed;
}

registerRepoHost('github', (root, config) => {
  const token = process.env[config.repo.github.tokenEnv] ?? process.env.GH_TOKEN;
  if (!token) throw new SboxError('GITHUB_TOKEN', `Нет токена GitHub в переменной ${config.repo.github.tokenEnv}.`);
  const { owner, repo } = resolveGitHubRepo(root, config);
  return new GitHubRepoHost(root, new FetchGitHubApi(config.repo.github.apiUrl, token), owner, repo);
});
