import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import '../src/adapters/spec/index.js';
import '../src/adapters/repo/index.js';
import { GitHubRepoHost, type GitHubApi } from '../src/adapters/repo/github/index.js';
import { LocalRepoHost } from '../src/adapters/repo/local.js';
import { createChange, loadChange, saveChange } from '../src/core/change.js';
import { loadConfig } from '../src/core/config.js';
import { deliverChange, readinessChecklist } from '../src/core/deliver.js';
import { parseGateCommand, pollPullRequestGate } from '../src/core/gates.js';
import { applyReport } from '../src/core/report.js';
import { createSpecAdapter } from '../src/core/spec-adapter.js';
import { RESULT, git, read, tempProject, write } from './helpers.js';

/** Фейковый GitHub API в памяти: пул-реквесты и комментарии. */
function fakeGitHub() {
  const pulls: Record<number, { number: number; html_url: string; draft: boolean; merged: boolean; head: { ref: string }; base: { ref: string }; node_id: string; title: string; body: string }> = {};
  const comments: Record<number, { id: number; user: { login: string }; body: string; created_at: string }[]> = {};
  let nextPr = 1;
  let nextComment = 1;
  const api: GitHubApi & { pulls: typeof pulls; comments: typeof comments; addComment: (n: number, author: string, body: string) => void } = {
    pulls,
    comments,
    addComment(n, author, body) {
      (comments[n] ??= []).push({ id: nextComment++, user: { login: author }, body, created_at: new Date(Date.now() + 1000).toISOString() });
    },
    async request(method, p, body) {
      const b = (body ?? {}) as Record<string, unknown>;
      if (method === 'GET' && /\/pulls\?/.test(p)) {
        const head = decodeURIComponent(p.split('head=')[1]!.split('&')[0]!).split(':')[1];
        return { status: 200, json: Object.values(pulls).filter((x) => x.head.ref === head && !x.merged) };
      }
      if (method === 'POST' && p.endsWith('/pulls')) {
        const n = nextPr++;
        pulls[n] = { number: n, html_url: `https://github.com/o/r/pull/${n}`, draft: Boolean(b.draft), merged: false, head: { ref: String(b.head) }, base: { ref: String(b.base) }, node_id: `PR_${n}`, title: String(b.title), body: String(b.body) };
        return { status: 201, json: pulls[n] };
      }
      const m = p.match(/\/pulls\/(\d+)$/);
      if (m && method === 'GET') return { status: 200, json: pulls[Number(m[1])] };
      if (m && method === 'PATCH') {
        Object.assign(pulls[Number(m[1])]!, { ...(b.title ? { title: b.title } : {}), ...(b.body ? { body: b.body } : {}) });
        return { status: 200, json: pulls[Number(m[1])] };
      }
      if (method === 'POST' && p === '/graphql') {
        const id = String((b.query as string).match(/pullRequestId: "([^"]+)"/)![1]);
        const pr = Object.values(pulls).find((x) => x.node_id === id)!;
        pr.draft = false;
        return { status: 200, json: { data: {} } };
      }
      const c = p.match(/\/issues\/(\d+)\/comments/);
      if (c && method === 'GET') return { status: 200, json: comments[Number(c[1])] ?? [] };
      if (c && method === 'POST') {
        (comments[Number(c[1])] ??= []).push({ id: nextComment++, user: { login: 'sbox-bot' }, body: String(b.body), created_at: new Date().toISOString() });
        return { status: 201, json: {} };
      }
      return { status: 404, json: { message: `no route ${method} ${p}` } };
    },
  };
  return api;
}

/** Довести изменение до фазы deliver: реализация с изменённым файлом, верификация, ревью с narrative. */
async function prepareDeliverable(root: string, id = 'dl') {
  const config = loadConfig(root);
  const adapter = createSpecAdapter(root, config);
  const { dir } = createChange(root, config, { id, title: 'Поиск', request: 'поиск', autonomy: 'autonomous' });
  const rel = path.relative(root, dir);
  write(root, `${rel}/proposal.md`, '## Зачем\nпоиск');
  write(root, `${rel}/specs/home-page.yml`, 'code: home-page\nadded:\n  Поиск по каталогу:\n    - assert: Поле поиска показывает подсказки\n');
  write(root, `${rel}/design.md`, '## Общая картина\nпоиск');
  write(root, `${rel}/tasks.md`, '- [x] 1.1 сделать\n');
  write(root, 'src/search.ts', 'export const search = () => [];\n');
  const c = loadChange(dir);
  c.phase = 'implement';
  saveChange(dir, c);
  const report = (role: string, phase: string, md: string) => applyReport({ root, config, dir, change: loadChange(dir), role: role as never, phase: phase as never, markdown: md, adapter });
  await report('implementer', 'implement', RESULT('готово'));
  await report('verifier', 'verify', RESULT('готово', 'checks:\n  - { id: V1, result: PASS, evidence: "pnpm test 3/3" }\n  - { id: V2, result: NOT_RUN }\n'));
  await report('reviewer', 'review', RESULT('готово', 'dispositions:\n  - { item: V2, disposition: manual_gap_accepted, reason: "проверим на стенде" }\ndelivery_narrative: { title: "Поиск с подсказками на главной", delta: "Добавлено поле поиска и запрос подсказок", why: "Подсказки приходят с бэкенда по двум символам", preserved: "Промо-блок и корзина не тронуты", rollout: "обычный релиз", rollback: "откат коммита" }\n'));
  write(root, `${rel}/test-plan.md`, '## Ручные проверки\n- стенд\n');
  return { config, adapter, dir };
}

describe('доставка', () => {
  it('чеклист готовности отражает состояние', async () => {
    const root = tempProject();
    const { config, adapter, dir } = await prepareDeliverable(root);
    const change = loadChange(dir);
    expect(change.phase).toBe('deliver');
    const { dod, diagnostics } = await readinessChecklist(root, config, dir, change, adapter);
    expect(diagnostics).toEqual([]);
    expect(dod.every((d) => d.ok)).toBe(true);
  });

  it('локальный адаптер: архив, коммит с ключом intent, повтор не создаёт второй коммит', async () => {
    const root = tempProject();
    const { config, adapter, dir } = await prepareDeliverable(root);
    const host = new LocalRepoHost(root);
    const result = await deliverChange({ root, config, dir, change: loadChange(dir), adapter, host });
    expect(result.receipt.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(git(root, ['log', '-1', '--format=%B']).trim()).toMatch(/Sbox-Intent-Key: dl:/);
    expect(git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('sbox/dl');
    expect(read(root, 'specs/home-page.spec-box.yml')).toContain('Поиск по каталогу');
    expect(fs.existsSync(dir)).toBe(false);
    const archived = loadChange(result.archivedTo);
    expect(archived.status).toBe('done');
    expect(archived.delivery?.state).toBe('done');
    // runs/ в архив не попадает, а narrative ревьюера сохранён в change.yaml: повтор доставки ниже собирает текст без result.md.
    expect(fs.existsSync(path.join(result.archivedTo, 'runs'))).toBe(false);
    expect(archived.delivery_narrative?.title).toBe('Поиск с подсказками на главной');
    // повтор: тот же intent, коммит переиспользуется
    const again = await deliverChange({ root, config, dir: result.archivedTo, change: loadChange(result.archivedTo), adapter, host });
    expect(again.receipt.reused.commit).toBe(true);
    expect(again.receipt.commit).toBe(result.receipt.commit);
    expect(result.prBody).toContain('Поиск с подсказками на главной');
    expect(result.prBody).toContain('Принятые пробелы');
    expect(result.prBody).toContain('План ручного тестирования');
  });

  it('github: создаёт черновик, переводит в готовый, при повторе переиспользует', async () => {
    const root = tempProject();
    const bare = fs.mkdtempSync(path.join(root, '..', 'sbox-remote-'));
    git(bare, ['init', '-q', '--bare', '-b', 'main']);
    git(root, ['remote', 'add', 'origin', bare]);
    const { config, adapter, dir } = await prepareDeliverable(root);
    const api = fakeGitHub();
    const host = new GitHubRepoHost(root, api, 'o', 'r');
    const result = await deliverChange({ root, config, dir, change: loadChange(dir), adapter, host });
    expect(result.receipt.pushed).toBe(true);
    expect(result.receipt.pr?.number).toBe(1);
    expect(result.receipt.pr?.draft).toBe(false);
    expect(api.pulls[1]!.body).toContain('Готовность к влитию');
    const again = await deliverChange({ root, config, dir: result.archivedTo, change: loadChange(result.archivedTo), adapter, host });
    expect(again.receipt.reused).toEqual({ commit: true, pr: true });
    expect(Object.keys(api.pulls)).toHaveLength(1);
  });

  it('сбой после внешней операции даёт delivery_unknown', async () => {
    const root = tempProject();
    const { config, adapter, dir } = await prepareDeliverable(root);
    const api = fakeGitHub();
    const host = new GitHubRepoHost(root, api, 'o', 'r');
    host.push = () => {
      throw new Error('network down');
    };
    await expect(deliverChange({ root, config, dir, change: loadChange(dir), adapter, host })).rejects.toThrow(/DELIVERY_UNKNOWN|прервана/);
    const archived = path.join(root, '.sbox/changes/archive');
    const folder = fs.readdirSync(archived).find((f) => f.endsWith('-dl'))!;
    const c = loadChange(path.join(archived, folder));
    expect(c.status).toBe('delivery_unknown');
    expect(c.delivery?.state).toBe('committed');
  });
});

describe('гейты через комментарии PR', () => {
  it('разбирает команды', () => {
    expect(parseGateCommand('/sbox approve plan Q1=B Q2=A', 'dima', 't')).toEqual({ action: 'approve', gate: 'plan', answers: { Q1: 'B', Q2: 'A' }, author: 'dima', at: 't' });
    expect(parseGateCommand('/sbox reject proposal сузить объём', 'dima', 't')).toMatchObject({ action: 'reject', gate: 'proposal', comment: 'сузить объём' });
    expect(parseGateCommand('просто комментарий', 'x', 't')).toBeNull();
  });

  it('публикует вопрос один раз и применяет ответ', async () => {
    const root = tempProject();
    const config = loadConfig(root);
    const { dir } = createChange(root, config, { id: 'gate', title: 'Гейт', request: 'r' });
    const c = loadChange(dir);
    c.phase = 'propose';
    c.status = 'waiting_approval';
    c.gates.proposal = { state: 'pending' };
    saveChange(dir, c);
    const api = fakeGitHub();
    const host = new GitHubRepoHost(root, api, 'o', 'r');
    const pr = await host.openPullRequest({ branch: 'sbox/gate', base: 'main', title: 't', body: 'b', draft: true });
    let out = await pollPullRequestGate(root, config, dir, host, pr);
    expect(out.posted).toBe(true);
    expect(out.applied).toBeNull();
    expect(api.comments[1]![0]!.body).toContain('/sbox approve proposal');
    out = await pollPullRequestGate(root, config, dir, host, pr);
    expect(out.posted).toBe(false);
    api.addComment(1, 'dima', '/sbox approve proposal');
    out = await pollPullRequestGate(root, config, dir, host, pr);
    expect(out.applied?.action).toBe('approve');
    expect(loadChange(dir).phase).toBe('plan');
    expect(loadChange(dir).gates.proposal?.by).toBe('dima');
  });
});
