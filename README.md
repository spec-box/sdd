# @spec-box/sdd

Инструмент автономной реализации продуктовых фич ИИ-агентами: вы даёте описание фичи, агенты-роли проводят её через исследование, предложение, спецификации, дизайн, тесты, реализацию, верификацию и ревью до пул-реквеста, готового к влитию. Состояние процесса хранится в файлах репозитория продукта.

Проект входит в группу [spec-box](https://github.com/spec-box): инструменты для работы со спецификациями и автотестами. Репозиторий: [github.com/spec-box/sdd](https://github.com/spec-box/sdd).

Замысел и устройство описаны в [docs/design.md](docs/design.md). Ниже то, что уже реализовано (этапы 1 и 2 плана).

## Установка

Требуется Node.js 22. Инструмент ставится глобально из npm и обновляется той же командой:

```bash
npm install -g @spec-box/sdd
sbox --version
```

Для разработки самого @spec-box/sdd: `pnpm install`, `pnpm build` (tsc → dist/), `pnpm test` (vitest), `pnpm dev -- <команда>` запускает CLI через tsx без сборки. Публикация: `npm publish` из корня репозитория, `prepublishOnly` собирает и прогоняет тесты.

## Быстрый старт в проекте продукта

```bash
cd <репозиторий продукта>     # spec-box (.tms.json) или OpenSpec (openspec/specs); адаптер определяется автоматически
sbox init --host claude       # .sbox/config.yaml, шаблоны .sbox/project/*.md, .gitignore, скиллы и агенты Claude Code
# заполнить .sbox/project/*.md
sbox doctor                   # структурная проверка документации, спецификаций и сред запуска
sbox change new add-search --title "Поиск по каталогу" --request "Добавить поле поиска на главную"
sbox next --change add-search # пакет для первой роли (researcher)
```

Дальше цикл ведёт скилл `/sbox-run` в Claude Code: он вызывает `sbox next`, запускает субагента нужной роли, сдаёт его ответ через `sbox report` и останавливается на гейтах. Гейты решает человек: `sbox approve <gate>` или `sbox reject <gate> --comment "..."`.

## Что где лежит

```text
src/core/        доменная модель, конфиг, состояние изменения (ревизия, lock), машина состояний, схема артефактов,
                 пакет для роли, приём отчёта, change-set, headless-цикл run, доставка и текст PR, гейты через PR,
                 отчёты тестов и покрытие, категории документации и doctor, архивация
src/adapters/    spec/spec-box, spec/openspec — истина и дельты в двух форматах; runner/claude, runner/codex — среды агентов;
                 repo/github, repo/local — хостинг репозитория; host/claude — материалы для Claude Code
src/cli/         команды commander: init, doctor, host, change, next, report, approve, reject,
                 status, instructions, validate, spec, archive
assets/roles/    определения ролей (Markdown): researcher, planner, tester, implementer, reviewer, verifier…
assets/schema/   граф артефактов по умолчанию и инструкции к ним
assets/templates/ шаблоны артефактов изменения
assets/project/  шаблоны категорий проектной документации
assets/ci/       шаблоны GitHub Actions и Dockerfile
test/            vitest: парсеры, адаптер spec-box, doctor, полный цикл изменения на фикстуре
docs/design.md   проектный документ
```

## Headless-режим

```bash
sbox run --change add-search --runner claude  # роли выполняет адаптер среды до гейта, блокера или конца
sbox run --change add-search --detach         # в фоне; журнал в .sbox/changes/<id>/runs/run.log
sbox watch --change add-search                # ждать терминального статуса, выход 1 при parked/blocked/stopped
sbox stop --change add-search                 # остановить процесс роли, доставка после этого запрещена
sbox change resume add-search --returns 6     # продолжить после parked с большим бюджетом возвратов
sbox changeset show                           # запечатанный change-set и дрейф рабочей копии
sbox coverage --report jest=reports/jest.json # покрытие утверждений дельт тестами
sbox deliver --check && sbox deliver          # чеклист готовности, архив, коммит, push, пул-реквест
sbox gates poll                               # гейты через комментарии /sbox approve|reject в пул-реквесте
sbox ci install --target github               # workflows для GitHub Actions; --target docker для Dockerfile.sbox
sbox wiring --analog X --new Y                # новый модуль подключён везде, где подключён образец
sbox metrics                                  # время агентов, ожидание человека, запуски, стоимость, вмешательства, оценки
sbox change rate <id> --score 4               # оценка результата человеком
sbox prompt show project-docs                 # промпт для заполнения .sbox/project/*.md под адаптер проекта
```

Модели и усилие по ролям задаются в `runner.models` и `runner.efforts` (по умолчанию opus только для planner и challenger, effort medium); после правки выполните `sbox host install --target claude`. Среды: `claude` через Claude Agent SDK (нужен `ANTHROPIC_API_KEY` для CI; локально годится вход Claude Code), `codex` через `codex exec` (в конфиге `runner.codex.executable`, например бинарник из ChatGPT.app). Репозиторий: `repo.adapter: github` с токеном в `GITHUB_TOKEN`; `local` только коммитит.

## Состояние

Готово (этапы 1 и 2): конфиг и раскладка `.sbox/`, жизненный цикл изменения с гейтами, возвратами и бюджетом (`parked`), ревизия и lock `change.yaml`, пакеты и receipt запусков, приём отчётов с проверками (артефакты, дельты, задачи, защищённые тесты, дрейф change-set, disposition и `delivery_narrative` ревьюера), запечатывание change-set после реализации, адаптер spec-box, категории документации и структурный `doctor`, материалы для Claude Code, адаптеры сред Claude и Codex с надзором и одним транспортным повтором, `run`/`stop`/`watch`, адаптер GitHub с идемпотентной доставкой и каналом гейтов через комментарии, отчёты тестов jest/vitest/playwright и покрытие, шаблоны CI и Dockerfile.

Готово также: адаптер OpenSpec (истина в `openspec/specs`, дельты в родном синтаксисе ADDED/MODIFIED/REMOVED/RENAMED, текстовое применение с сохранением остальных разделов, `.openspec.yaml` в папке изменения для совместимости с CLI OpenSpec).

Готово также: wiki проекта в `.sbox/wiki/` (индекс страниц с `read_when` попадает в пакет каждой роли), метрики `sbox metrics` и оценка `sbox change rate`.

Не готово: дискавери и правила (этап 3), Arcadia и Codex-материалы для хоста (этап 4), межрепозиторный протокол (этап 5), роутер и дистилляция wiki (этап 6), продолжение сессий Codex, семантический `doctor --deep`.
