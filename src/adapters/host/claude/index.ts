import path from 'node:path';
import { loadRoleText } from '../../../core/roles.js';
import { ROLES, type Role } from '../../../core/phases.js';
import { defaultHostModel } from '../../../core/runner.js';
import { writeText } from '../../../core/paths.js';
import type { Config } from '../../../core/config.js';

const AGENT_ROLES: Role[] = ['researcher', 'planner', 'tester', 'implementer', 'reviewer', 'verifier', 'challenger'];

const TOOLS: Record<Role, string> = {
  researcher: 'Read, Grep, Glob, Bash',
  planner: 'Read, Write, Edit, Grep, Glob, Bash',
  challenger: 'Read, Grep, Glob, Bash',
  tester: 'Read, Write, Edit, Grep, Glob, Bash',
  implementer: 'Read, Write, Edit, Grep, Glob, Bash',
  reviewer: 'Read, Grep, Glob, Bash',
  verifier: 'Read, Grep, Glob, Bash',
  distiller: 'Read, Write, Edit, Grep, Glob',
};

const DESCRIPTIONS: Record<Role, string> = {
  researcher: 'Исследователь @spec-box/sdd: Evidence Pack по изменению. Вызывается только скиллом sbox-run.',
  planner: 'Планировщик @spec-box/sdd: proposal, дельты спецификаций, design, tasks. Вызывается только скиллом sbox-run.',
  challenger: 'Аудитор плана @spec-box/sdd. Вызывается только скиллом sbox-run.',
  tester: 'Тестировщик @spec-box/sdd: тесты по сценариям до реализации. Вызывается только скиллом sbox-run.',
  implementer: 'Реализатор @spec-box/sdd: выполняет tasks.md, не трогая защищённые тесты. Вызывается только скиллом sbox-run.',
  reviewer: 'Ревьюер @spec-box/sdd: тесты против спецификаций, код против артефактов. Вызывается только скиллом sbox-run.',
  verifier: 'Верификатор @spec-box/sdd: полнота, корректность, согласованность. Вызывается только скиллом sbox-run.',
  distiller: 'Дистиллятор знаний @spec-box/sdd.',
};

/** Материалы для Claude Code: тонкий скилл-оркестратор и по агенту на роль (docs/design.md, раздел 11). */
export function installClaudeMaterials(root: string, config?: Config): string[] {
  const written: string[] = [];
  const skill = path.join(root, '.claude', 'skills', 'sbox-run', 'SKILL.md');
  writeText(skill, RUN_SKILL);
  written.push(skill);
  const approve = path.join(root, '.claude', 'skills', 'sbox-approve', 'SKILL.md');
  writeText(approve, APPROVE_SKILL);
  written.push(approve);
  for (const role of ROLES) {
    if (!AGENT_ROLES.includes(role)) continue;
    const file = path.join(root, '.claude', 'agents', `sbox-${role}.md`);
    writeText(file, agentFile(root, role, config?.runner.models[role], config?.runner.efforts[role] ?? config?.runner.defaultEffort ?? 'medium'));
    written.push(file);
  }
  return written;
}

/** Имя модели для фронтматтера агента Claude Code: псевдонимы sonnet/opus/haiku или полный идентификатор. */
function agentModel(configured: string | undefined): string | null {
  if (!configured) return null;
  const v = configured.toLowerCase();
  if (v.includes('opus')) return 'opus';
  if (v.includes('sonnet')) return 'sonnet';
  if (v.includes('haiku')) return 'haiku';
  return configured;
}

function agentFile(root: string, role: Role, configuredModel?: string, effort = 'medium'): string {
  const body = loadRoleText(root, role);
  const model = agentModel(configuredModel) ?? defaultHostModel(role);
  // Без явного effort субагент наследует усилие сессии (в пилоте это был xhigh на каждом ходе).
  return `---
name: sbox-${role}
description: ${DESCRIPTIONS[role]}
tools: ${TOOLS[role]}
model: ${model}
effort: ${effort}
---

Ты выполняешь роль ${role} инструмента @spec-box/sdd. Во входном сообщении путь к JSON-пакету (\`packet\`). Прочитай пакет целиком: там цель, допущенные файлы, ограничения, правила проекта, инструкции к артефактам и путь \`resultFile\`.

Порядок работы: прочитай пакет → выполни этапы роли ниже → запиши полный ответ (Markdown и завершающий блок \`# sbox-result\`) в файл \`resultFile\` из пакета → в сообщении верни только две строки: путь к resultFile и статус.

${body.trim()}
`;
}

const RUN_SKILL = `---
name: sbox-run
description: Выполнить следующий шаг изменения @spec-box/sdd — запросить пакет у CLI, выполнить роль субагентом и сдать отчёт. Используй, когда пользователь просит продвинуть изменение, запустить sbox, выполнить следующий шаг.
---

# sbox-run

Ты оркестратор: не исследуешь проект и не решаешь задачу сам. Роли выполняют субагенты \`sbox-<role>\`.

1. Определи изменение: из аргумента, из контекста или \`sbox change list --json\`. Если активных изменений несколько и не ясно, какое брать, спроси пользователя.
2. Запроси следующий шаг: \`sbox next --change <id> --brief --json\`. Никогда не запрашивай \`next\` без \`--brief\` и не читай packet.json сам: пакет нужен субагенту, а не тебе.
3. По полю \`kind\` ответа:
   - \`role\`: если субагент этой роли уже запускался в этой сессии, продолжи его тем же сообщением через SendMessage (он помнит проект и артефакты, повторное чтение не нужно); иначе запусти нового субагента \`sbox-<role>\`. Сообщение: \`packet: <path из поля packetFile>\`. Дождись ответа. Затем сдай отчёт: \`sbox report --change <id> --role <role> --json\`. Ответ \`report\` уже содержит статус и диагностику: не читай result.md и evidence целиком, покажи пользователю только строку статуса и ошибки. Если CLI вернул ошибки (например, не создан артефакт или изменены защищённые файлы), передай их тому же субагенту одним сообщением и повтори отчёт; не больше двух повторов.
   - \`gate\`: покажи пользователю пути артефактов из ответа и спроси: «Утвердить <gate>? Ответьте «да» или замечанием». «да» → \`sbox approve <gate> --change <id> --by <user>\`; замечание → \`sbox reject <gate> --change <id> --comment "<текст>"\`. Мелкие правки формулировок пользователь может внести в артефакт сам и ответить «да»: отклонение запускает цикл доработки роли. Затем вернись к шагу 2.
   - \`deliver\`: покажи чеклист \`sbox deliver --change <id> --check\` и предложи доставку \`sbox deliver --change <id>\` (архив, коммит, push, пул-реквест). Не запускай доставку без просьбы пользователя.
   - \`wait\`: покажи статус и блокер, спроси пользователя, что делать.
   - \`done\`: сообщи об окончании.
4. Повторяй шаги 2–3, пока не встретишь gate, wait, deliver или done. Не запускай субагентов параллельно.

Полезные команды: \`sbox status --change <id>\` (состояние, change-set, привязка ревью), \`sbox changeset show\` (запечатанный диф и дрейф), \`sbox coverage --report jest=<path>\` (покрытие утверждений тестами), \`sbox change resume --returns N\` (продолжить после parked).

Экономия контекста: не читай артефакты изменения (design.md, спецификации, отчёты) целиком; тебе нужны только ответы CLI. Запрещено: переформулировать задачу пользователя, редактировать артефакты, вызывать роли напрямую в обход пакета, менять код.
`;

const APPROVE_SKILL = `---
name: sbox-approve
description: Утвердить или отклонить гейт изменения @spec-box/sdd (proposal, plan, tests). Используй, когда пользователь говорит «утверждаю», «одобряю план», «отклоняю с замечанием».
---

# sbox-approve

1. Определи изменение и гейт: \`sbox status --change <id> --json\` показывает ожидающий гейт.
2. Утверждение: \`sbox approve <gate> --change <id> --by <user> [--comment "..."] [--answer Q1=B]\`.
3. Отклонение: \`sbox reject <gate> --change <id> --by <user> --comment "<замечание>"\`.
4. Покажи результат и предложи продолжить скиллом sbox-run.
`;
