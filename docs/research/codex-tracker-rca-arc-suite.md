# Codex Tracker RCA + Arc Suite 4.1.0: разбор устройства

Источник: страница wiki `users/denisplatonov/85eb30e13d26`, архив `codex-tracker-rca-arc-suite-v4.1.0.zip` (SHA-256 совпала с указанной на странице). Распакованная копия лежит в `~/projects/tmp/suite-4.1.0/`. Автор Suite: Денис Платонов. Разбор сделан 2026-09-12 для проектирования headless-режима @spec-box/sdd.

## Что это

Автопилот исправления багов: тикет из Yandex Tracker → отдельный Arc mount → RCA и план → реализация → независимая проверка → ревью → неопубликованный черновой PR в Arcanum. Публикация и мерж за человеком. Только Codex CLI, только Arc, только багфиксы.

Версия 4.1.0 помечена как кандидат с заблокированным релизом: на macOS дочерние процессы Codex могут пережить завершение супервизора (проблема F1). Python 3.11, около 38 тысяч строк, из них 11 тысяч в одном файле контроллера `arc_runtime.py`; около 56 тысяч слов документации; большой набор приёмочных тестов с фейковыми Codex и Arc.

## Конвейер

```text
CREATED → ISOLATED → PLANNED → IMPLEMENTED → VERIFIED → REVIEWED → PR_READY
                                    └──────────┴──────────┴→ PARKED
```

Успешный прогон это ровно четыре семантических хода агентов: planner (Sol Max, RCA), worker (Luna или Sol по выбору контроллера), verifier (свежий агент в том же mount), reviewer (Sol high, единственный владелец решения SHIP). Одна коррекция это полный цикл worker → verifier → reviewer на том же RCA; бюджет коррекций по умолчанию 1, итого не больше семи ходов. После бюджета запуск паркуется, скрытых перепланирований нет. Увеличить бюджет может только оператор явной командой resume с большим лимитом.

Принцип, повторённый во всех документах: контроллер механический. Он читает только статусы, ссылки на артефакты, реальные пути и дайджесты, writer lease, счётчик коррекций и решение ревьюера. Он не знает язык проекта, package manager, команды тестов и не интерпретирует прозу агентов. Всё проектное агенты узнают сами из AGENTS.md и репозитория.

## Механизмы контроллера

| Механизм | Как сделано | Файлы |
|---|---|---|
| Изоляция | Отдельный arc mount на задачу; исходный checkout никогда не рабочее место; проверка identity mount перед worker | `arc_runtime.py`, `arc-task.py` |
| Один writer | Отзываемый writer lease только у worker; verifier и reviewer без права записи | `arc_runtime.py` |
| Запечатанный change-set | После worker контроллер сам снимает реальные пути, режимы, before/after байты и дайджест; сверяет пути с `write_roots` планировщика; любое изменение байт после ревью инвалидирует SHIP | `change_set.py`, `evidence_ledger.py` |
| Транзакционная проверка | Verifier переключает workspace final → baseline → optional RED → final; после каждого перехода дайджест сверяется; неудачное восстановление final блокирует доставку | `verification_snapshot.py` |
| Контракты ролей | JSON-схемы результатов planner, worker, verifier, reviewer; `codex exec --json --output-schema --output-last-message`; промпт на stdin; результат заворачивается в envelope с run_id, фазой, попыткой, base_revision, sha входа и sha результата | `schemas/*.json`, `run_codex` |
| Аттестованные инструкции | SKILL.md и references роли читаются один раз, сверяются с `SHA256SUMS`, вкладываются в промпт; автозагрузка скилла с тем же именем отключается через `skills.config`; в receipt хранится sha реального входа модели | `role_instruction_input.py` |
| Состояние запуска | `run.json` с `state_revision` (оптимистичная блокировка), атомарная запись с fsync, flock, controller lease с epoch, терминальные статусы неизменяемы без явного resume, каталог на каждую попытку фазы с events.jsonl, stderr, result, receipt | `RunStore` |
| Процессы | `process-supervisor.py` как обёртка с nonce и receipt, stop-request через файл, остановка всей process group, hard timeout 6 часов и idle timeout, detach через новую сессию | `process-supervisor.py` |
| Повторы | Один transport или capacity retry, только пока нет пригодного по схеме результата и workspace не изменился (fingerprint); смена модели при тех же условиях; бюджет коррекций не расходуется | `agent_runtime.py` |
| Доставка | Write-ahead intent с idempotency key до коммита и PR; commit → receipt → PR (`--publish=disabled`); сверка после сбоя; при DELIVERY_UNKNOWN повтор запрещён до сверки; текст коммита и PR только из `delivery_narrative` ревьюера через шаблоны; хуки коммита один раз, без `--no-verify` | `execute_delivery`, `delivery-gate.py` |
| Tracker | Best-effort теги `RCAutopilot_*` по статусу; локальное состояние остаётся истиной | `tracker_status_sync.py` |
| Внешний вызывающий | Протокол ledger reserve → bind → observe для batch-оркестратора (например, наблюдающего агента); `status --json` со `state_revision`, `settled` и `active_process` | `batch-ledger.py`, `BATCH_RUNBOOK.md` |
| Установка и doctor | verify-suite по манифесту sha, транзакционный install с откатом, doctor проверяет совместимость Codex CLI по `exec --help`, Arc, MacFUSE | `install-suite.py`, `doctor.py`, `codex_cli_compat.py` |

Вызов Codex, дословно из `run_codex`:

```text
codex exec --cd <workspace> --model <model> --skip-git-repo-check --json
  --output-schema <schema.json> --output-last-message <result.json>
  -c model_reasoning_effort="<effort>"
  [--sandbox read-only|workspace-write -c approval_policy="on-request" -c approvals_reviewer="auto_review" | --approve-for-me]
  [--ignore-user-config] -c agents.enabled=false
```

Промпт подаётся на stdin. События JSONL разбираются для прогресса, обнаружения запросов одобрения и классификации сбоев.

## Семантика ролей

**Planner (RCA).** Результат это причинный контракт: problem (триггер, предусловия, наблюдаемое, ожидаемое, первое наблюдаемое расхождение, влияние, известные рабочие случаи), evidence с provenance вида `path#symbol`, cause (первый недопустимый переход, нарушенный инвариант, владелец с обоснованием, цепочка со ссылками на evidence, сильнейшая альтернатива со статусом discriminated или carried), change (write_roots, preserve, constraints, non_goals), verification (primary oracle в форме Given/When/RED/PASS, preserved oracles, manual/CI gaps), uncertainties, blockers. Статусы READY или BLOCKED. Перед ответом обязательная самопроверка на фальсифицируемость.

**Worker.** Сначала дёшево проверяет handoff (REFINED или PLAN_INVALIDATED), сам готовит проект по его инструкциям без рецептов от контроллера, добивается осмысленного RED (список предпочтительных границ от существующего теста до ручного оракула), делает наименьшее причинное изменение у владельца инварианта, доказывает GREEN и проверяет ближайший неверный вариант реализации (мутант). Возвращает setup-запись для следующих фаз. Статусы COMPLETED, NO_CHANGE, PLAN_INVALIDATED, BLOCKED.

**Verifier.** Независим: выводы planner и worker это утверждения, а не авторитет. Строит карту оракулов, сам устанавливает baseline или RED, проверяет final, объясняет каждый семантический hunk. Вердикты PASS, FAIL, PARTIAL, BLOCKED_ENV.

**Reviewer.** Смотрит семантическую дельту до и после как свежий Staff-инженер. Правила допуска находки: вызвана изменением, называет инвариант, содержит конкретный сценарий отказа, цитирует путь и hunk, независима, полезна до мержа; стиль и общие просьбы «добавить тестов» не допускаются. Обязан дать disposition каждому не-PASS пункту верификатора и каждому пробелу: SATISFIED, MANUAL_GAP_ACCEPTED, CHANGE_REQUIRED, BLOCKED. Решения SHIP, CHANGES_REQUIRED, BLOCKED. При SHIP пишет `delivery_narrative`, единственный источник текста коммита и PR.

## Ограничения

- Релиз заблокирован проблемой F1: дочерние процессы Codex создают свои process group до применения песочницы и могут пережить остановку.
- Только Arc и Arcanum; порты для второго VCS есть, адаптера нет.
- Только багфиксы: объём задаёт RCA, а не спецификация; продуктовых решений, дискавери и спецификаций нет.
- Только Codex CLI как среда агентов.
- Очень высокая сложность контроллера: receipts, хеши и envelope на каждом шаге ради безопасной необслуживаемой работы в монорепозитории.

## Что предлагаю взять в @spec-box/sdd

Ниже кандидаты по этапам плана из docs/design.md. Каждый пункт можно принять или отклонить отдельно.

| # | Что | Куда в @spec-box/sdd | Этап |
|---|---|---|---|
| A | Рецепт вызова Codex: `codex exec` с `--output-schema` и `--output-last-message`, промпт на stdin, `agents.enabled=false`, проверка возможностей по `exec --help`, разбор JSONL для прогресса, hard и idle timeout, stop-request и остановка process group | Адаптер среды `codex` | 2 |
| B | Дисциплина состояния: `revision` в `change.yaml` с оптимистичной блокировкой, атомарная запись, lock-файл, неизменяемость терминальных статусов без явного `resume`, каталог на каждую попытку с событиями и stderr | `change.ts`, `runs/` | 2 |
| C | Запечатанный change-set: после фазы implement CLI снимает список путей и дайджест дифа; reviewer и verifier привязаны к дайджесту; deliver отказывает, если дайджест изменился после ревью | `protect.ts` → `changeset.ts`, `report.ts`, `deliver` | 2 |
| D | Политика повторов: один transport retry только без пригодного результата и без изменений workspace; бюджет возвратов монотонный, расширяется только оператором | `runner`, `phases.ts` | 2 |
| E | Контракт ревьюера: правила допуска находок, обязательный disposition каждого не-PASS пункта верификатора, `delivery_narrative` как единственный источник описания PR | `assets/roles/reviewer.md`, рендер PR | 2 |
| F | Словарь исходов и `settled`: PR_READY, NO_CODE_CHANGE, PARKED, BLOCKED, STOPPED, DELIVERY_UNKNOWN; статус для внешнего вызывающего с revision и признаком активного процесса | `change.ts`, `status --json` | 2 |
| G | Идемпотентная доставка: write-ahead intent с ключом до коммита и PR, сверка при resume, запрет слепого повтора при неизвестном исходе | Адаптеры репозитория | 2, 4 |
| H | Изоляция: одна рабочая копия на изменение (`git worktree` для GitHub, отдельный `arc mount` для Arcadia) и проверка identity перед фазой implement | `run`, адаптеры репозитория | 2, 4 |
| I | Provenance: sha промпта роли и пакета в записи запуска | `runs/` | 2 |
| J | Теги в Трекере как проекция статуса, best-effort | Канал `tracker` | 4 |
| K | Схема `bugfix` для @spec-box/sdd: вместо proposal причинный контракт RCA с оракулом Given/When/RED/PASS; тесты фазы cover становятся RED-оракулом | `assets/schema/bugfix.yaml` | 3 или позже |

Что не берём: RCA как единственный источник объёма (у @spec-box/sdd источник это спецификация и дискавери), Codex как единственную среду, тотальные receipts и envelope на каждом шаге (берём выборочно там, где они защищают доставку), отказ контроллера от любого знания о проекте в виде документации (у sbox проектные знания это данные для агентов, а не логика контроллера, что не противоречит принципу Suite).
