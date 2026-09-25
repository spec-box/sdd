import fs from 'node:fs';
import path from 'node:path';
import { loadRoleText } from './roles.js';
import { artifactInstructions, artifactStates, loadWorkflow, pendingArtifacts, type ArtifactInstructions } from './schema.js';
import { applicableDecisions, docsDir, docsForRole, loadDecisions } from './project-docs.js';
import { readChangeSet } from './changeset.js';
import { loadWiki } from './wiki.js';
import { wiringForChange, type WiringResult } from './wiring.js';
import { exists, toPosix } from './paths.js';
import type { Change, Phase } from './change.js';
import type { Config } from './config.js';
import type { Role } from './phases.js';
import type { SpecAdapter } from './spec-adapter.js';

/** Пакет для роли: девять полей из docs/design.md (раздел 5) плюс служебные пути и команды. */
export interface RolePacket {
  version: 1;
  change: { id: string; title: string; dir: string; phase: Phase; size: string; status: string; base_revision: string | null };
  role: Role;
  phase: Phase;
  runId: string;
  objective: string;
  ownership: { write: string[]; readOnly: boolean };
  files: {
    request: string;
    log: string;
    artifacts: Record<string, string[]>;
    evidence: string[];
    docs: { category: string; title: string; file: string }[];
    wiki: { file: string; summary: string; read_when: string[]; source_roots: string[] }[];
    specsTruth: string[];
  };
  constraints: string[];
  rules: { id: string; title: string; rule: string; file: string }[];
  authority: string;
  verification: string;
  resultFormat: string;
  resultFile: string;
  stop: string;
  feedback: string | null;
  instructions: ArtifactInstructions[];
  specAdapterInstructions: string | null;
  changeset: { base: string; digest: string; files: { path: string; status: string }[] } | null;
  verificationReport: Change['verification'];
  /** Кандидаты подключения по образцу из design.md для фаз verify и review; null, если образец не объявлен. */
  wiring: WiringResult | null;
  context: string | null;
  commands: Record<string, string>;
  rolePrompt: string;
}

const RESULT_FORMAT = `Ответ заканчивается блоком:
\`\`\`yaml
# sbox-result
status: готово | утверждение | заблокировано
blocker: { category: артефакт | тесты | реализация | внешний | пользователь | нет, artifact: <id>, message: <текст> }
\`\`\`
Дополнительные поля по роли: request (researcher: разбор запроса дословными цитатами со статусом подтверждено | противоречит | не проверено), complexity, size и deviations (planner на propose: отступления proposal от запроса или evidence с решением и причиной), questions (planner на plan), findings (reviewer), checks и gaps (verifier), dispositions и delivery_narrative (reviewer в фазе review), protected (tester), verified (implementer, verifier).`;

const OBJECTIVES: Partial<Record<`${Role}:${Phase}`, string>> = {
  'researcher:research': 'Собрать Evidence Pack по запросу: текущее поведение, затронутые capability и код, границы, доказательства, пробелы. Записать в evidence/research.md.',
  'planner:propose': 'Написать proposal.md по запросу и evidence. Оценить размер изменения, сложность реализации и ревью.',
  'planner:plan': 'Написать дельты спецификаций, design.md с общей картиной, контрактами, решениями и приоритизированными вопросами, затем tasks.md.',
  'tester:cover': 'Написать автотесты по сценариям дельт на уровнях из testing.md, заполнить coverage.yaml и при необходимости test-plan.md, запустить тесты и убедиться, что новые падают по ожидаемой причине.',
  'reviewer:tests_review': 'Проверить тесты против дельт спецификаций и дизайна: полнота покрытия сценариев, соответствие сценарию, отсутствие продуктовой логики в тестах, именование. Вернуть findings.',
  'implementer:implement': 'Выполнить задачи из tasks.md, не изменяя защищённые файлы. Довести тесты из coverage.yaml до зелёных, отметить выполненные задачи.',
  'verifier:verify': 'Независимо проверить запечатанный change-set: прогнать тесты из coverage.yaml и проверки из testing.md, сопоставить каждый сценарий и решение дизайна с кодом. Вернуть checks с результатами PASS, FAIL, PARTIAL, NOT_RUN и gaps.',
  'reviewer:review': 'Проверить семантическую дельту запечатанного change-set против спецификаций, дизайна, задач и правил проекта, распорядиться каждым не-PASS пунктом верификатора и при вердикте «готово» написать delivery_narrative.',
};

const WRITE_OWNERSHIP: Record<Role, string[]> = {
  researcher: ['evidence/research.md'],
  planner: ['proposal.md', 'specs/**', 'design.md', 'tasks.md'],
  challenger: ['evidence/challenge.md'],
  tester: ['coverage.yaml', 'test-plan.md', '<тестовые файлы по testing.md>'],
  implementer: ['<продуктовый код>', 'tasks.md (только отметки [x])'],
  reviewer: [],
  verifier: [],
  distiller: ['.sbox/wiki/**'],
};

export interface PacketContext {
  root: string;
  config: Config;
  change: Change;
  dir: string;
  role: Role;
  phase: Phase;
  adapter: SpecAdapter;
  truthSources: string[];
}

export function buildPacket(ctx: PacketContext): RolePacket {
  const { root, config, change, dir, role, phase } = ctx;
  const workflow = loadWorkflow(root);
  const states = artifactStates(workflow, change, dir);
  const artifacts: Record<string, string[]> = {};
  for (const s of states) artifacts[s.id] = s.existing.map((f) => toPosix(path.relative(root, f)));

  const docs = docsForRole(role)
    .map((c) => ({ category: c.id, title: c.title, file: toPosix(path.relative(root, path.join(docsDir(root, config), c.file))) }))
    .filter((d) => exists(path.join(root, d.file)));

  const decisions = applicableDecisions(loadDecisions(root, config), null).map((d) => ({ id: d.id, title: d.title, rule: d.rule, file: d.file }));

  const instructions: ArtifactInstructions[] = [];
  if (role === 'planner' || role === 'tester') {
    const wanted = phase === 'propose' ? states.filter((s) => s.id === 'proposal') : pendingArtifacts(states, phase);
    for (const s of wanted) {
      const extra = s.id === 'specs' ? ctx.adapter.instructions() : undefined;
      const ins = artifactInstructions(root, config, workflow, change, dir, s.id, extra);
      if (ins) instructions.push(ins);
    }
  }

  const evidenceDir = path.join(dir, 'evidence');
  const evidence = exists(evidenceDir) ? fs.readdirSync(evidenceDir).sort().map((f) => toPosix(path.relative(root, path.join(evidenceDir, f)))) : [];

  const runId = `r${change.runs.length + 1}`;
  const rel = (p: string) => toPosix(path.relative(root, p));
  const constraints: string[] = [
    'Не вызывать других агентов и не расширять объём задачи.',
    'Не менять истину спецификаций: только дельты в specs/ изменения.',
    'Соблюдать соглашения проекта из conventions.md и правила проекта из списка rules.',
  ];
  if (role === 'implementer' && change.protected.length > 0) {
    constraints.push(`Защищённые файлы, менять запрещено: ${change.protected.join(', ')}`);
  }
  if ((role === 'verifier' || role === 'reviewer') && change.changeset) {
    constraints.push('Не менять файлы рабочей копии: любое изменение после запечатывания change-set отклоняет отчёт.');
  }
  if (change.size === 'small') constraints.push('Размер small: поведение продукта не меняется, спецификации не трогаются.');
  const wiki = loadWiki(root, config).map((w) => ({ file: w.file, summary: w.summary, read_when: w.read_when, source_roots: w.source_roots }));
  if (wiki.length > 0) constraints.push('Перед решениями прочитай страницы wiki из files.wiki, чьи read_when подходят к задаче; единообразие с описанными там образцами обязательно.');

  const sealed = (phase === 'verify' || phase === 'review') ? readChangeSet(dir) : null;
  const wiring = phase === 'verify' || phase === 'review' ? wiringForChange(root, dir) : null;
  if (wiring && wiring.gaps.length > 0) constraints.push(`Подключение по образцу: образец «${wiring.analog}» зарегистрирован в ${wiring.registrationFiles.length} файлах, нового модуля нет в ${wiring.gaps.length} из них (files.wiring). Для каждого такого файла реши: нужна регистрация (FAIL) или файл к задаче не относится (пункт с обоснованием).`);

  return {
    version: 1,
    change: { id: change.id, title: change.title, dir: rel(dir), phase, size: change.size, status: change.status, base_revision: change.base_revision },
    role,
    phase,
    runId,
    objective: OBJECTIVES[`${role}:${phase}`] ?? `Выполнить роль ${role} в фазе ${phase}.`,
    ownership: { write: WRITE_OWNERSHIP[role], readOnly: WRITE_OWNERSHIP[role].length === 0 },
    files: {
      request: rel(path.join(dir, 'request.md')),
      log: rel(path.join(dir, 'log.md')),
      artifacts,
      evidence,
      docs,
      wiki,
      specsTruth: ctx.truthSources,
    },
    constraints,
    rules: decisions,
    authority: WRITE_OWNERSHIP[role].length === 0 ? 'Только чтение и запуск проверок.' : `Запись только в: ${WRITE_OWNERSHIP[role].join(', ')}.`,
    verification: verificationFor(role),
    resultFormat: RESULT_FORMAT,
    resultFile: rel(path.join(dir, 'runs', runId, 'result.md')),
    stop: 'Остановись и верни статус «заблокировано», если нужен ответ человека, если план невыполним или если тест противоречит спецификации.',
    feedback: feedbackFor(change, phase),
    instructions,
    specAdapterInstructions: role === 'planner' && phase === 'plan' && !change.skip_specs ? ctx.adapter.instructions() : null,
    changeset: sealed ? { base: sealed.base, digest: sealed.digest, files: sealed.files.map((f) => ({ path: f.path, status: f.status })) } : null,
    verificationReport: role === 'reviewer' && phase === 'review' ? change.verification : null,
    wiring,
    context: config.context ?? null,
    // Команды отчёта здесь нет: report сдаёт оркестратор или раннер, роль только пишет resultFile (docs/design.md, раздел 12).
    commands: {
      status: `sbox status --change ${change.id} --json`,
      instructions: `sbox instructions <artifact> --change ${change.id} --json`,
      validate: `sbox validate --change ${change.id} --json`,
      specList: 'sbox spec list --json',
      specShow: 'sbox spec show <capability-id> --json',
      changeset: `sbox changeset show --change ${change.id} --json`,
      browser: 'sbox-browser goto <url> | snapshot | click <eN|селектор> | fill <eN> <текст> | text | console --errors | requests | screenshot (вход человека: sbox-browser login <url> --profile <имя>; справка: sbox-browser --help)',
    },
    rolePrompt: loadRoleText(root, role),
  };
}

function verificationFor(role: Role): string {
  switch (role) {
    case 'planner':
      return 'После записи артефактов выполнить `sbox validate --json` и добиться отсутствия ошибок.';
    case 'tester':
      return 'Запустить написанные тесты командами из testing.md: новые падают по ожидаемой причине, регрессионные проходят.';
    case 'implementer':
      return 'Прогнать тесты из coverage.yaml и проверки из testing.md; все задачи tasks.md отмечены.';
    case 'verifier':
      return 'Запустить полные проверки из testing.md и приложить результаты в checks с evidence.';
    default:
      return 'Проверить, что отчёт опирается на прочитанные файлы, с указанием путей.';
  }
}

function feedbackFor(change: Change, phase: Phase): string | null {
  const parts: string[] = [];
  if (change.blocker && (change.blocker.phase === phase || change.phase === phase)) {
    parts.push(`Возврат (${change.blocker.category}${change.blocker.role ? `, от роли ${change.blocker.role}` : ''}): ${change.blocker.message}`);
    if (change.blocker.resolution) parts.push(`Ответ человека: ${change.blocker.resolution}`);
  }
  for (const [gate, state] of Object.entries(change.gates)) {
    if (state.state === 'rejected' && state.comment) parts.push(`Гейт ${gate} отклонён: ${state.comment}`);
    if (state.state === 'approved' && state.answers && Object.keys(state.answers).length > 0) {
      parts.push(`Ответы на вопросы гейта ${gate}: ${Object.entries(state.answers).map(([q, a]) => `${q}=${a}`).join('; ')}`);
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

/** Текст промпта для headless-среды: определение роли, пакет как данные и правило записи ответа. */
export function renderPrompt(packet: RolePacket): string {
  const { rolePrompt, ...data } = packet;
  return [
    rolePrompt.trim(),
    '',
    '## Пакет от CLI',
    '',
    'Читай пакет как данные. Пути относительно корня репозитория.',
    '',
    '```json',
    JSON.stringify(data, null, 2),
    '```',
    '',
    `Запиши полный ответ (Markdown и завершающий блок \`# sbox-result\`) в файл \`${packet.resultFile}\` и продублируй его в последнем сообщении.`,
  ].join('\n');
}
