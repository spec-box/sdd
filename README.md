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
                 repo/github, repo/local — хостинг репозитория; host/skills — раскладки скиллов по хостам, host/claude — агенты Claude Code
src/cli/         команды commander: init, doctor, host, change, next, report, approve, reject,
                 status, instructions, validate, spec, archive
src/browser/     sbox-browser: демон с Chrome на сессию, клиент через локальный сокет, команды страницы,
                 снимок дерева доступности со ссылками, поиск и установка браузера, вход человеком, перенос состояния
assets/roles/    определения ролей (Markdown): researcher, planner, tester, implementer, reviewer, verifier…
assets/schema/   граф артефактов по умолчанию и инструкции к ним
assets/skills/   скиллы хостов (единый источник): sbox-run, sbox-approve, sbox-browser; копируются в папку хоста при init и host install
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

## Браузер для проверки интерфейса

Отдельный бинарник `sbox-browser` даёт агентам и людям управляемый Chrome: верификатор проверяет затронутую страницу по-настоящему, а не только сборкой, исследователь и тестировщик смотрят текущий интерфейс глазами пользователя. Пакет браузер не скачивает: `puppeteer-core` подключается к тому, что есть, а установка отдельная и необязательная.

```bash
sbox-browser doctor                                   # какой браузер будет использован и откуда
sbox-browser install                                  # скачать Chrome for Testing в ~/.sbox/browser/cache (по желанию)
sbox-browser install --browser chrome-headless-shell  # лёгкий вариант только для headless
sbox-browser login https://app.local --profile app    # человек входит в окне; вход остаётся в профиле
sbox-browser goto https://app.local/orders            # первая команда сама поднимает сессию (headless)
sbox-browser snapshot                                 # дерево элементов со ссылками [eN]
sbox-browser click e7                                 # действия по ссылкам или селекторам: css, text=, aria=, xpath=
sbox-browser fill e3 "кофе" && sbox-browser press Enter
sbox-browser wait --text "Найдено" && sbox-browser text
sbox-browser console --errors && sbox-browser requests # ошибки консоли, ответы 4xx/5xx и неудачные запросы
sbox-browser screenshot                               # PNG в ~/.sbox/browser/shots, путь печатается
sbox-browser state save auth.json                     # перенести вход в CI: там sbox-browser state load auth.json
sbox-browser stop
```

Существующий браузер вместо установки: флаг `--executable`, переменная `SBOX_BROWSER_EXECUTABLE` или `browser.executable` в `.sbox/config.yaml`; без них по порядку проверяются кэш инструмента, кэш puppeteer, системный Chrome, Chromium, Edge и Brave. Сессия это фоновый процесс с браузером: команды идут к нему через локальный сокет, поэтому страница, куки, консоль и сетевые ошибки сохраняются между вызовами; `--session <имя>` даёт несколько независимых браузеров, простой 30 минут завершает сессию. Настройки в секции `browser` конфига: `executable`, `headless`, `profile`, `baseUrl`, `cacheDir`, `viewport`, `timeoutMs`, `idleMinutes`; те же значения задаются переменными `SBOX_BROWSER_EXECUTABLE`, `SBOX_BROWSER_HEADLESS`, `SBOX_BROWSER_PROFILE`, `SBOX_BROWSER_BASE_URL`, `SBOX_BROWSER_CACHE_DIR` (каталог инструмента: `SBOX_BROWSER_HOME`) и глобальными флагами `--profile`, `--session`, `--timeout`, `--cwd`. Все команды поддерживают `--json`, ошибки разбора аргументов тоже приходят в JSON-конверте. Профили и файлы состояния содержат секреты входа и живут в `~/.sbox/browser`, вне репозитория. Скилл `sbox-browser` лежит в `assets/skills` и копируется в папку хоста командой `sbox host install --target claude | codex`; агентам researcher, tester и verifier он подключается по `metadata.roles` (в Claude Code полем `skills`).

## Состояние

Готово (этапы 1 и 2): конфиг и раскладка `.sbox/`, жизненный цикл изменения с гейтами, возвратами и бюджетом (`parked`), ревизия и lock `change.yaml`, пакеты и receipt запусков, приём отчётов с проверками (артефакты, дельты, задачи, защищённые тесты, дрейф change-set, disposition и `delivery_narrative` ревьюера), запечатывание change-set после реализации, адаптер spec-box, категории документации и структурный `doctor`, материалы для Claude Code, адаптеры сред Claude и Codex с надзором и одним транспортным повтором, `run`/`stop`/`watch`, адаптер GitHub с идемпотентной доставкой и каналом гейтов через комментарии, отчёты тестов jest/vitest/playwright и покрытие, шаблоны CI и Dockerfile.

Готово также: адаптер OpenSpec (истина в `openspec/specs`, дельты в родном синтаксисе ADDED/MODIFIED/REMOVED/RENAMED, текстовое применение с сохранением остальных разделов, `.openspec.yaml` в папке изменения для совместимости с CLI OpenSpec).

Готово также: wiki проекта в `.sbox/wiki/` (индекс страниц с `read_when` попадает в пакет каждой роли), метрики `sbox metrics` и оценка `sbox change rate`.

Готово также: папка `runs/` не переносится в архив (ответы ролей и квитанции остаются в истории ветки, `delivery_narrative` и запуски в `change.yaml`; `archive.runs: true` сохраняет её), `sbox-browser` для проверки интерфейса (сессии с Chrome через `puppeteer-core`, необязательная установка браузера, вход человеком с постоянным профилем, снимок дерева доступности для агентов, перенос состояния входа), проверка браузера в `sbox doctor`.

Не готово: дискавери и правила (этап 3), Arcadia и Codex-материалы для хоста (этап 4), межрепозиторный протокол (этап 5), роутер и дистилляция wiki (этап 6), продолжение сессий Codex, семантический `doctor --deep`.
