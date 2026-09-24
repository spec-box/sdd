import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import '../src/adapters/spec/index.js';
import { applyOpenSpecDelta, parseOpenSpecDelta, validateOpenSpecDeltas } from '../src/adapters/spec/openspec/delta.js';
import { OpenSpecAdapter } from '../src/adapters/spec/openspec/index.js';
import { parseSpecFile } from '../src/adapters/spec/openspec/parser.js';
import { archiveChange } from '../src/core/archive.js';
import { createChange, loadChange, saveChange } from '../src/core/change.js';
import { loadConfig } from '../src/core/config.js';
import { applyReport } from '../src/core/report.js';
import { createSpecAdapter } from '../src/core/spec-adapter.js';
import { RESULT, read, tempProject, write } from './helpers.js';

const AUTH = fs.readFileSync(path.join(import.meta.dirname, 'fixtures/openspec-project/openspec/specs/auth/spec.md'), 'utf8');

describe('openspec: истина', () => {
  it('разбирает заголовок, Purpose, требования, текст и сценарии', () => {
    const cap = parseSpecFile(AUTH, 'auth', 'openspec/specs/auth/spec.md');
    expect(cap.title).toBe('Auth');
    expect(cap.purpose).toMatch(/Аутентификация/);
    expect(cap.requirements.map((r) => r.title)).toEqual(['User Authentication', 'Session Expiration']);
    expect(cap.requirements[0]!.text).toMatch(/SHALL issue a JWT/);
    expect(cap.requirements[0]!.scenarios.map((s) => s.title)).toEqual(['Valid credentials', 'Invalid credentials']);
    expect(cap.requirements[0]!.scenarios[0]!.description).toMatch(/\*\*WHEN\*\* the user submits login form/);
    expect(cap.requirements[1]!.raw).toMatch(/^### Requirement: Session Expiration/);
  });

  it('адаптер читает вложенные capability по пути', async () => {
    const root = tempProject('openspec-project');
    const adapter = new OpenSpecAdapter(root, loadConfig(root));
    const truth = await adapter.readTruth();
    expect(truth.map((c) => c.id)).toEqual(['auth', 'identity/user-profile']);
    expect(truth[1]!.source).toBe('openspec/specs/identity/user-profile/spec.md');
  });
});

describe('openspec: дельта', () => {
  const truth = [parseSpecFile(AUTH, 'auth', 'openspec/specs/auth/spec.md')];
  const ids = new Set(['auth']);

  it('разбирает все секции, включая REMOVED с причиной и RENAMED', () => {
    const { delta, skippedHeaders } = parseOpenSpecDelta(
      `## ADDED Requirements

### Requirement: Two-Factor Authentication
The system MUST support TOTP-based two-factor authentication.

#### Scenario: 2FA enrollment
- **WHEN** the user enables 2FA
- **THEN** a QR code is displayed

## MODIFIED Requirements

### Requirement: Session Timeout
The system MUST expire sessions after 15 minutes of inactivity.

#### Scenario: Idle timeout
- **WHEN** 15 minutes pass without activity
- **THEN** the session is invalidated

## REMOVED Requirements

### Requirement: User Authentication
**Reason**: Replaced by SSO
**Migration**: Use the SSO endpoint

## RENAMED Requirements
- FROM: \`### Requirement: Session Expiration\`
- TO: \`### Requirement: Session Timeout\`
`,
      'auth',
      'd.md',
      ids,
    );
    expect(delta.isNew).toBe(false);
    expect(delta.ops.map((o) => o.op)).toEqual(['rename-requirement', 'remove-requirement', 'modify-requirement', 'add-requirement']);
    const removed = delta.ops.find((o) => o.op === 'remove-requirement') as { reason?: string; migration?: string };
    expect(removed.reason).toBe('Replaced by SSO');
    expect(removed.migration).toBe('Use the SSO endpoint');
    expect(skippedHeaders).toEqual([]);
    expect(validateOpenSpecDeltas(truth, [delta]).filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('находит ошибки: MODIFIED несуществующего, новая capability без Purpose, сценарий с тремя #, потеря сценариев', () => {
    const bad = parseOpenSpecDelta('## MODIFIED Requirements\n\n### Requirement: Nope\nThe system SHALL x.\n\n### Scenario: wrong level\n- **WHEN** a\n- **THEN** b\n', 'auth', 'bad.md', ids);
    const codes = validateOpenSpecDeltas(truth, [bad.delta]).map((d) => d.code);
    expect(codes).toContain('DELTA_MODIFY_MISSING');
    expect(codes).toContain('DELTA_NO_SCENARIO');
    expect(codes).toContain('DELTA_SCENARIO_LEVEL');
    const fresh = parseOpenSpecDelta('## ADDED Requirements\n\n### Requirement: A\nThe system SHALL a.\n\n#### Scenario: s\n- **WHEN** x\n- **THEN** y\n', 'billing/invoice', 'new.md', ids);
    expect(validateOpenSpecDeltas(truth, [fresh.delta]).map((d) => d.code)).toContain('DELTA_NEW_PURPOSE');
    const drops = parseOpenSpecDelta('## MODIFIED Requirements\n\n### Requirement: User Authentication\nThe system SHALL issue a token.\n\n#### Scenario: Valid credentials\n- **WHEN** ok\n- **THEN** token\n', 'auth', 'drop.md', ids);
    const warn = validateOpenSpecDeltas(truth, [drops.delta]).find((d) => d.code === 'DELTA_MODIFY_DROPS_SCENARIOS');
    expect(warn?.message).toMatch(/Invalid credentials/);
  });

  it('применяет дельту текстово и сохраняет остальные разделы', () => {
    const { delta } = parseOpenSpecDelta(
      '## ADDED Requirements\n\n### Requirement: Logout\nThe system SHALL end the session on logout.\n\n#### Scenario: Click logout\n- **WHEN** the user clicks logout\n- **THEN** the session ends\n\n## REMOVED Requirements\n- `### Requirement: User Authentication`\n\n## RENAMED Requirements\n- FROM: `### Requirement: Session Expiration`\n- TO: `### Requirement: Session Timeout`\n',
      'auth',
      'd.md',
      ids,
    );
    const next = applyOpenSpecDelta(AUTH, delta);
    expect(next).toContain('# Auth Specification');
    expect(next).toContain('## Purpose\nАутентификация');
    expect(next).toContain('## Notes\nРаздел с заметками');
    expect(next).not.toContain('### Requirement: User Authentication');
    expect(next).toContain('### Requirement: Session Timeout\nThe system MUST expire sessions after 30 minutes');
    expect(next).toContain('### Requirement: Logout');
    const cap = parseSpecFile(next, 'auth', 'x');
    expect(cap.requirements.map((r) => r.title)).toEqual(['Session Timeout', 'Logout']);
  });

  it('создаёт новую capability с Purpose и заголовком', () => {
    const { delta } = parseOpenSpecDelta('## Purpose\nВыставление счетов клиентам и учёт оплат по подписке.\n\n## ADDED Requirements\n\n### Requirement: Invoice issue\nThe system SHALL issue an invoice.\n\n#### Scenario: Monthly\n- **WHEN** month ends\n- **THEN** invoice is issued\n', 'billing/invoice', 'n.md', ids);
    const created = applyOpenSpecDelta(null, delta);
    expect(created.startsWith('# Invoice Specification\n\n## Purpose\nВыставление счетов')).toBe(true);
    expect(created).toContain('## Requirements\n\n### Requirement: Invoice issue');
  });
});

describe('openspec: изменение целиком', () => {
  it('план валидируется, архивация применяет дельты к истине и создаёт новую capability', async () => {
    const root = tempProject('openspec-project');
    const config = loadConfig(root);
    const adapter = createSpecAdapter(root, config);
    expect(adapter.name).toBe('openspec');
    const { dir } = createChange(root, config, { id: 'add-2fa', title: '2FA', request: 'двухфакторная аутентификация', autonomy: 'autonomous' });
    expect(dir).toContain(path.join('openspec', 'changes', 'add-2fa'));
    const rel = path.relative(root, dir);
    write(root, `${rel}/proposal.md`, '## Зачем\n2FA');
    write(root, `${rel}/specs/auth/spec.md`, '## ADDED Requirements\n\n### Requirement: Two-Factor Authentication\nThe system MUST support TOTP.\n\n#### Scenario: Enrollment\n- **WHEN** the user enables 2FA\n- **THEN** a QR code is displayed\n');
    write(root, `${rel}/specs/identity/recovery/spec.md`, '## Purpose\nВосстановление доступа через резервные коды и подтверждённую почту.\n\n## ADDED Requirements\n\n### Requirement: Backup codes\nThe system SHALL issue ten backup codes.\n\n#### Scenario: Generate\n- **WHEN** 2FA is enabled\n- **THEN** ten codes are shown once\n');
    write(root, `${rel}/design.md`, '## Общая картина\n2FA');
    write(root, `${rel}/tasks.md`, '- [ ] 1.1 x\n');
    const c = loadChange(dir);
    c.phase = 'plan';
    saveChange(dir, c);
    const out = await applyReport({ root, config, dir, change: loadChange(dir), role: 'planner', phase: 'plan', markdown: RESULT('готово'), adapter });
    expect(out.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(out.phaseCompleted).toBe(true);
    const deltas = await adapter.readDelta(path.join(dir, 'specs'));
    expect(deltas.map((d) => `${d.capabilityId}:${d.isNew}`)).toEqual(['auth:false', 'identity/recovery:true']);
    const done = loadChange(dir);
    done.phase = 'deliver';
    saveChange(dir, done);
    const result = await archiveChange(root, config, adapter, dir, loadChange(dir), { date: '2026-09-14' });
    expect(result.appliedFiles.sort()).toEqual(['openspec/specs/auth/spec.md', 'openspec/specs/identity/recovery/spec.md']);
    expect(read(root, 'openspec/specs/auth/spec.md')).toContain('### Requirement: Two-Factor Authentication');
    expect(read(root, 'openspec/specs/auth/spec.md')).toContain('## Notes');
    expect(read(root, 'openspec/specs/identity/recovery/spec.md')).toContain('# Recovery Specification');
    expect(fs.existsSync(path.join(root, 'openspec/changes/archive/2026-09-14-add-2fa'))).toBe(true);
  });
});
